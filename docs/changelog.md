# Eva AI Changelog

本文只记录较大的架构演进、核心分层调整和重要设计方向变化。

维护规则：

- 按架构域更新，不按单个小功能流水账更新。
- 同一架构域的多次小迭代应合并到该域下说明。
- 每次记录应说明：升级前的问题、升级后的设计、带来的优势。
- 细碎任务、测试补充、局部命令、单个 entry 类型或 UI 展示细节不单独记录；这些内容放在 `docs/current.md` 或任务上下文中。

## Project Foundation

### TypeScript Harness Foundation

升级前：

- 项目从早期 mini-agent 形态演进而来，代码边界更偏 demo / script。
- CLI、会话、模型调用、工具执行和配置读取容易混在同一路径里。
- Python 版本和早期 TypeScript 版本之间的项目身份、目录命名、配置命名不统一。

升级后：

- 项目统一为 `eva-ai` TypeScript CLI 编码 Agent Harness。
- 建立 TypeScript 工程、配置文件、provider client、工具系统、session persistence 和文档体系。
- 项目命名、配置目录和包元数据统一收敛为 Eva AI。

优势：

- 后续架构可以围绕 TypeScript 类型边界和测试体系演进。
- 项目身份稳定，避免命名迁移继续污染核心代码。
- 为 runtime、session、tools、context 等架构域拆分提供统一基础。

## Agent Runtime

### Agent / Loop / Session / Runtime 分层重建

升级前：

- CLI 直接承担过多装配职责，agent 执行、会话持久化、工具调用和终端 I/O 边界不清。
- `AgentSession` 容易变成大而全对象，同时承载 agent loop、messages、session persistence、工具治理和 mode 展示。
- interactive 和 print/headless 难以稳定复用同一条执行路径。

升级后：

- 引入 `Agent`、`agent-loop`、`AgentSession`、`RuntimeServices`、`RuntimeHost` 和 mode 层分工。
- `agent-loop` 负责 LLM turn、tool execution、event emission 和 abort handling。
- `Agent` 作为有状态 wrapper 管理 messages、tools、队列和 active run。
- `AgentSession` 连接 Agent、session persistence、tool governance 和 UI-facing events。
- `RuntimeServices` 承载 cwd 绑定的 config、provider、resources、tools、sessions、context 和 diagnostics。
- `RuntimeHost` 负责当前 runtime 生命周期、session new/resume/switch/fork/clone/import/export/reload。
- interactive、print、TUI 和 RPC modes 共享同一 runtime/session 核心。

优势：

- mode 层只负责 I/O，不再直接知道 config、resources、tools、sessions 如何装配。
- session 切换和 runtime reload 有稳定边界，后续 TUI/RPC 可以复用。
- agent loop 和 terminal rendering 解耦，事件流可以被 CLI、TUI、RPC 不同接口消费。
- 更贴近 `pi-mono` 的 runtime/session/mode 分层，同时保留 Eva 自身较轻的实现复杂度。

### AgentMessage / LlmMessage 双层消息边界

升级前：

- session history、agent-loop working messages、context transform 和 provider request 使用同一类 `Message[]`。
- harness metadata、compaction summary、permission pending、resource/context marker 等内部信息缺少清晰归属。
- provider 请求层容易被内部消息污染，后续 context pruning 和 durable metadata 难以扩展。

升级后：

- 引入 `AgentMessage` / `LlmMessage` 最小双层边界。
- provider call 前执行 `transformContext()` 和 `convertToLlm()`。
- internal message 默认在转换边界被过滤；需要跨 resume 恢复的 harness metadata 写入独立 durable `internal` session entry。

优势：

- 内部/session/harness 消息和 provider API 请求消息解耦。
- context 管理、compaction、skills/resource injection 和 permission diagnostics 有了明确承载层。
- 后续 RPC/TUI/MCP/Extensions 不必绑定早期单层 message 临时结构。

## Session / Recovery

### Entry-Tree-First Session Model

升级前：

- 会话主要像线性 `Message[]` 快照，session log 更接近 append-only transcript。
- fork/clone 只能复制当前消息快照，无法表达从某个历史 entry 派生的新分支。
- resume 时难以确定当前 active context 具体来自哪条路径。
- branch 操作、active leaf、entry path 和 session lineage 没有稳定 durable 语义。

升级后：

- session 读取路径收敛为 entry-tree-first。
- append-only `SessionEntry` tree 成为主要事实源，active provider/session view 从当前 leaf path 派生。
- session entry 增加 `entryId` / `parentEntryId`，并支持 message、compaction、usage、internal、leaf、branch summary 等 durable entry。
- fork/clone 支持基于 active 或指定 leaf entry path 复制。
- branch 操作在同一 session 文件内移动 active leaf，下一次 append 从该 leaf 继续。
- `/entries`、`/path`、`/branch`、`/sessions`、`/parent`、`/children`、`/child` 提供最小可见和导航边界。
- load/import 不再把旧 flat JSONL 当作有效 active context；缺 entry metadata 的旧格式需要未来显式 migration。

优势：

- session 不再只是消息数组，而是可恢复、可分支、可重建的运行记录。
- active context 可以由 leaf path 确定性 rebuild，减少 resume/fork/branch 的隐式状态。
- 与 `pi-mono` 的 append-only session tree 和 path-aware context rebuild 方向对齐。
- 为后续 branch summarization、sidecar metadata、file history、todo/memory/subagent metadata 留出结构位置。

### Session Semantic Split

升级前：

- `SessionManager` 同时维护 session lifecycle、workspace JSONL 文件、entry tree、active path、metadata、append/branch/fork/load/import 语义。
- 多组 per-session Map 分散维护状态，容易出现 active messages、entry tree、path entries 和 metadata 不一致。
- load/import/create/reset/fork 的 model restoration 逻辑散落在 manager 内部。

升级后：

- 抽出 `SessionStorage` backend 边界，提供 JSONL 和 in-memory backend。
- 抽出 `SessionEntryStore`，负责单 session entry tree、path entries、active entry id、path traversal 和 tree view。
- 抽出 `SessionModel`，负责单 session metadata、lineage、schema format、entry store 和 active state cache。
- append message/usage/internal/compaction、branch active leaf 应用等单 session 语义下沉到 `SessionModel`。
- create/reset、fork/clone、parsed log application 分别收敛到 helper。
- 抽出 `session-log-parser.ts`，负责 JSONL parsing、session id 读取和 import rewrite。
- `SessionManager` 保留为 public lifecycle facade，主要负责 memory/jsonl 分发、manifest/latest session、list/import/export 和持久化编排。

优势：

- 单 session 语义、entry tree 状态、storage backend 和 manager lifecycle 职责更清晰。
- `SessionManager` 不再直接维护多组易失同步 Map，后续继续拆 `SessionRepo` 时边界更自然。
- in-memory backend 让核心 session 语义更容易测试。
- load/import/fork/reset 共享更一致的 model restoration 路径。

### Session Recovery And Diagnostics

升级前：

- session load/import 失败原因不够结构化，用户只能看到笼统失败。
- corrupt JSONL、missing entry metadata、unsupported schema、broken active path、latest manifest mismatch 等场景策略不清。
- latest session 不可加载时，runtime 行为和用户提示都不够可解释。

升级后：

- `parseSessionLog()` 返回 structured diagnostics。
- parser 补最小 schema validation，覆盖 message、compaction、usage、internal、branch summary 和 leaf 的必要 payload。
- load/import 区分 fatal 和 recoverable：
  - unsupported schema、缺失有效 `session_start`、broken active path、无 active context 的缺 entry metadata 会阻断。
  - trailing invalid JSONL、单条 invalid payload、unknown entry type 可诊断降级。
- `SessionManager.getDiagnostics()` 可读取 load/import/list/latest 过程中记录的动态 session diagnostics。
- `/diagnostics` 合并 runtime diagnostics 和 session manager diagnostics。
- `/resume` 对不可加载 session 展示简短原因。
- latest manifest 指向缺失或不可加载 session 时，会记录 latest load failure，并 fallback 到最近可加载 session；没有 fallback 时返回 `null` 让 runtime 创建新 session。
- unsupported schema 提示明确实际 schema version、当前 Eva 支持版本，并提示升级 Eva 或执行未来 migration。

优势：

- session recovery 策略从隐式失败变成可诊断、可测试、可展示。
- 用户不会因为 latest session 损坏而直接卡住启动路径。
- Eva 在 fallback 行为上接近 `pi-mono` 的 recent-session 容错，同时在 session log 结构损坏上比 `pi-mono` 更显式，减少悄悄加载 partial context 的风险。

## Context Management

### Request-Time Context Builder / Manager

升级前：

- system prompt、project context、skills/resource context 和 session messages 的组合逻辑容易散在 agent/session/runtime 中。
- provider request view 和 durable session history 边界不够清楚。
- context usage、compaction recommendation、token estimate 等信息缺乏统一诊断入口。

升级后：

- `ContextBuilder` 收敛为无状态 provider request view builder。
- `ContextManager` 提供 token estimate、usage percent、compaction recommendation、skills/resource 和 permission pending diagnostics 的最小聚合。
- `TokenCounter` 建立 provider/local 计数边界，Anthropic 和 Gemini 优先使用 provider countTokens。
- project context、skills invocation 和 post-compact resource budget 在 request-time 注入，不默认写回 session history。

优势：

- durable session history 和 provider request context 解耦。
- context 注入、裁剪、计数和 diagnostics 有独立架构域。
- 为后续完整 token budget engine、OpenAI countTokens、tool result budget 和 micro-compaction 留出空间。

### Manual / Auto Compaction And Prompt Recovery

升级前：

- 长会话依赖完整历史直接发送给 provider，容易触发上下文过长。
- compact 行为缺少稳定 entry 和 runtime recovery 路径。

升级后：

- manual `/compact` 最小闭环落地。
- auto compaction 最小执行闭环、prompt-too-long compact-and-retry、post-compact resource budget 最小闭环落地。
- compaction 结果作为 session entry 持久化，provider request view 可由 active path 和 summary 派生。

优势：

- 长任务不再只依赖固定 step guard 或完整历史上下文。
- prompt-too-long 从硬失败变成可恢复路径。
- compaction 和 session tree 对齐，为后续更细粒度 tool-result/micro compaction 留出位置。

## Tool System

### Builtin Tool Registry And Governance

升级前：

- 工具定义、执行、风险信息和确认逻辑分散，难以对不同 mode 复用。
- CLI/agent 对工具治理的关系不够清楚。

升级后：

- 工具系统升级为 registry + builtin tools + metadata 边界。
- tool metadata 承载 source、category、risk level、read-only、requires confirmation 等治理信息。
- agent-loop 在 tool call 前经过统一 governance hook。

优势：

- 工具能力和权限治理解耦。
- 后续 MCP/custom tools 可以接入同一 tool registry 和 metadata 模型。
- read-only / write / bash 等风险策略有统一判定基础。

## Permission / Safety

### Tool Permission Pending Boundary

升级前：

- 高风险工具确认主要依赖 interactive prompt，headless/RPC 场景缺乏可恢复治理路径。
- 没有 confirmation handler 时，工具阻断原因不够 durable。

升级后：

- 工具治理实现 fail-closed。
- 需要确认但当前 mode 不能确认时，写入 durable `permission_pending` internal entry。
- RPC permission pending approval 最小闭环落地，RPC mode 可输出 `permission_pending` event，并通过 approve/deny 返回决定。

优势：

- interactive、headless、RPC 的权限路径更一致。
- 高风险操作不会在无确认能力的 mode 中静默执行。
- pending 状态可诊断、可持久化，后续 permission pipeline 可以继续扩展。

## Resources / MCP / Skills / Extensions

### Runtime Resource Loading Boundary

升级前：

- system prompt、project context、skills 和未来 MCP/extensions 的加载容易混入 tools 或 runtime 装配细节。
- resource 加载失败或缺失缺少统一 diagnostics。

升级后：

- `ResourceLoader` 负责 system prompt、`AGENTS.md` project context、skills discovery、skills source metadata、source candidate merge/dedupe 和 resource diagnostics。
- skills metadata 可注入 system prompt，`/skill:name` 支持按需展开全文到下一次 provider request。
- MCP 配置字段已解析，但当前仅报告 extension boundary diagnostic，尚未接入 MCP server lifecycle。

优势：

- 外部资源发现和读取从 builtin tools 中解耦。
- project/user skills 有 source metadata 和 visibility 边界。
- 为后续 MCP server lifecycle、extensions、prompts/resources/tools loading 提供统一入口。

## Modes / Interfaces

### Shared Runtime Across CLI, TUI, Print And RPC

升级前：

- interactive 和 print/headless 容易形成不同执行路径。
- TUI/RPC 如果各自装配 runtime，会放大 session/tool/context 行为差异。

升级后：

- mode 层只负责 I/O 和展示。
- interactive、print、TUI、RPC 共享 `RuntimeHost`、`AgentSession` 和 session manager。
- TUI 是 Eva 自建最小 terminal UI 框架，不引入第二套 agent/runtime。
- Headless RPC 使用 JSONL stdin/stdout envelope，支持 prompt、get_state、abort、session lifecycle 和 permission approve/deny。

优势：

- 多接口行为一致，核心能力只在 runtime/session 层实现一次。
- TUI/RPC 可以复用已有 slash command 和 session switching 逻辑。
- 后续 SDK/ACP 兼容层可以建立在 RPC/runtime 边界上，而不是复制 agent 逻辑。

## Provider / Config / Observability

### Provider Adapter And Runtime Diagnostics

升级前：

- provider 差异、配置加载、工具加载、resource 加载和 session 状态的错误展示较分散。
- 启动输出容易噪音过多，完整 diagnostics 又不易追踪。

升级后：

- provider adapters 统一在 `llm` 层处理 streaming event normalization 和 provider errors。
- `RuntimeServices` 收集 config/provider/resource/context/session/tools diagnostics。
- mode 层通过统一 renderer 展示 startup diagnostics，并通过 `/diagnostics` 查看完整信息。
- provider usage 持久化，provider 错误展示收敛。

优势：

- provider 差异不泄漏到 session 或 mode。
- diagnostics 在 core 收集、mode 展示，减少业务逻辑和终端输出耦合。
- 用户能看到关键 warning/error，同时保留完整排查入口。
