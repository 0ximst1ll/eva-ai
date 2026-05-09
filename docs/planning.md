# Eva AI Planning

## 项目目标

Eva AI 的目标是构建一个智能编码助手。它应该具备清晰、可演进的内核结构，也要具备真实编码场景所需的 harness 工程能力。

核心方向：

- 以 `pi-mono` 的架构设计理念作为骨架，建立稳定的 runtime/session/mode 分层。
- 吸收 `claude-code` 的 harness 工程实践，增强工具编排、权限治理、恢复能力、MCP 接入和上下文管理。
- 保持 Eva AI 自身代码小而清晰，不直接复制任一项目的复杂度。

主要取舍：

- 先建立清晰边界，再增加复杂能力。
- 先做可测试的核心路径，再引入自动化策略。
- 先用简单机制解决真实问题，再决定是否需要更重的抽象。

## 总体策略

Eva AI 不应该在 `pi-mono` 和 `claude-code` 之间二选一。

推荐策略是：

- 架构层优先参考 `pi-mono`，保证长期可维护性。
- 执行层吸收 `claude-code` 的工具编排和 MCP 渐进接入能力。
- 治理层逐步引入 `claude-code` 风格的权限管线、恢复体系和上下文管理。
- 节奏上遵循“先骨架、后能力、再治理”。

## 参考 pi-mono 的设计

`pi-mono` 的价值在于内核边界清晰。Eva AI 应优先学习它的结构，而不是复制实现细节。

### Runtime / Services / Session / Modes 分层

目标分层：

- `cli`：参数解析、启动错误展示、mode 选择。
- `modes`：interactive、print、RPC；只负责 I/O。
- `core/runtime-host`：持有当前 runtime，负责 session new/resume/switch。
- `core/runtime-services`：cwd 绑定的配置、资源、工具、会话和 diagnostics。
- `core/agent-session`：会话桥接、持久化、队列状态、高层 session 操作。
- `core/agent`：围绕 loop 的有状态 agent wrapper。
- `core/agent-loop`：LLM turn、tool execution、event emission、abort handling。
- `llm`：provider adapters 和 streaming event normalization。
- `tools`：builtin tool definitions 和本地操作。
- `resources`：project context、system prompt、skills、MCP config、reload。
- `sessions`：JSONL entry model、tree/fork/context rebuild、export/import。

设计约束：

- mode 层不应该知道 config、resource、tool、session 如何被发现和装配。
- session 切换应该通过 `RuntimeHost` 完成。
- provider 差异应该留在 `llm` 层，不泄漏到 session 或 mode。

### 事件驱动内核

核心层只发事件，不直接做终端输出。

目标事件包括：

- message lifecycle：`message_start`、`content_delta`、`thinking_delta`、`message_end`
- tool lifecycle：`tool_call`、`tool_execution_start`、`tool_execution_end`、`tool_result`
- run lifecycle：`agent_start`、`turn_start`、`turn_end`、`agent_end`
- error/usage：`error`、`usage`

这样 interactive、print、RPC、未来 TUI 可以复用同一个核心执行路径。

### Append-only Session 与 Context Rebuild

会话应逐步从 flat JSONL 升级为显式 entry model。

目标能力：

- 每条 entry 有 `id`、`parentId`、`timestamp`。
- 支持 message、model/config change、compaction、custom metadata entry。
- 支持 `/resume`、`/fork`、`/clone`、import/export。
- 能从 active leaf 确定性 rebuild context。
- 保留旧 flat JSONL 的兼容读取或迁移路径。

### Agent Loop 边界与长任务执行

Eva AI 的主 agent loop 参考 `pi-mono`，后续应保持同样的自然停止语义。

目标语义：

- 主 loop 不应该依赖固定 `max_steps` 作为 interactive 会话的硬停止条件；
- loop 由模型停止请求工具、工具返回 terminate、用户 abort、LLM/tool error 等自然条件结束；
- interactive 长任务通过 session resume、context rebuild 和 compaction 持续推进；
- bounded execution 属于 print/headless/RPC 的运行策略，而不是 interactive core loop 的默认语义。

配置演进：

- 当前 `max_steps` 应逐步改名或迁移为 `max_turns_per_run` / `max_steps_per_run` 一类更明确的 headless guard；
- interactive mode 默认不启用固定 100 步硬上限；
- 保留可选 runaway guard，用于非交互自动化、测试或未来 RPC 调用；
- 文档和配置示例应避免把该 guard 描述成会话总轮数限制。

### Resource Loading

资源加载不应该混入 builtin tools。

应独立管理：

- system prompt；
- `AGENTS.md` / `CLAUDE.md` 等项目上下文；
- skills metadata；
- prompts；
- MCP config；
- reload diagnostics。

Resource loading 只负责发现和读取资源，不负责决定这些资源如何进入模型上下文。`AGENTS.md` / `CLAUDE.md` 等项目上下文应由后续 Context Builder 在每次 LLM call 前构造请求视图时注入，而不是永久写入 session history。

## 参考 claude-code 的设计

`claude-code` 的价值在于 harness 工程深度。Eva AI 应选择性吸收能提升真实编码体验的机制。

### 工具编排

目标：

- read-only tools 可以并发执行；
- write/bash tools 必须串行执行；
- tool result 按原始 tool-call 顺序写回消息；
- 并发批次不能直接并发修改共享上下文；
- 提供最大并发数和超大输出保护。

后续增强：

- per-tool result budget；
- per-message aggregate result budget；
- 大输出持久化为文件，只把 preview 和 stable path 写入上下文；
- 为 read/write/edit/bash 注入 operations，方便测试和未来远程 workspace。

### 权限治理

当前 Eva AI 只有高风险 confirmation。目标是演进为统一权限管线。

推荐顺序：

1. rules：allow、deny、ask。
2. modes：default、plan、accept-edits、bypass、dont-ask。
3. interaction：interactive 下询问用户。
4. headless/RPC：无确认通道时默认 deny。
5. classifier slot：只预留接口，暂不实现。

设计原则：

- 所有 tool call 经过同一条 permission decision path。
- 无交互环境默认 fail-closed。
- 被拒绝的工具调用返回结构化 tool result。

### MCP 渐进接入

MCP 不应阻塞首轮提示。

目标：

- MCP server 有 approval state。
- lifecycle 支持 pending、connected、failed。
- 慢连接通过 timeout 降级为 diagnostics。
- 后台连接成功后增量更新 tools/resources。
- 对重复 server、tool、resource 做 dedupe。
- MCP tools 和 builtin tools 保持所有权分离。

### 可恢复运行现场

恢复不应只恢复消息。

后续可逐步恢复：

- session transcript；
- agent metadata；
- todo state；
- file history；
- compaction state；
- future subagent sidecar metadata；
- memory metadata。

这部分应建立在 session tree 和 sidecar metadata 之后，避免过早耦合。

### 上下文管理

目标：

- 支持 token accounting，并优先使用 provider 返回的 usage；
- 支持 context diagnostics，能解释当前上下文预算和压缩状态；
- 支持手动 `/compact`；
- 支持自动阈值 compaction；
- 支持 prompt-too-long recovery；
- compaction 作为 session entry 写入；
- compact 后按预算重新注入 project context 和 skills。

实施取舍：

- 先实现 flat JSONL 兼容的 compaction entry 和 context rebuild 最小闭环；
- 不必为了第一版 `/compact` 立即完成完整 session tree；
- 完整历史必须继续保留在 session log 中，只改变发送给模型的上下文视图；
- 后续再补齐 tool result micro-compaction、大输出持久化和 post-compact resource budgets。

### Context Builder / Context Manager 分工

Eva AI 的上下文治理分两层推进：

- `ContextBuilder`：无状态构造器。每次 LLM call 前，把当前 session messages、system prompt、project context 和 runtime context 组合成发送给 provider 的 request messages。
- `ContextManager`：有状态管理器。后续负责 token budget、manual/auto compaction、summary、post-compact resource reinjection 和 context diagnostics。

第一阶段只实现 `ContextBuilder`，避免过早引入完整 Claude Code 式 context engine。

`ContextBuilder` 的目标行为：

- 不修改 `SessionManager` 中的真实 session history；
- 不把 `AGENTS.md` 持久化为普通 user message；
- 保留当前 system prompt 兼容路径；
- 在请求模型前临时注入 project context；
- assistant/tool result 仍写回原始 session messages，而不是写回 request messages；
- 为后续 budget 和 diagnostics 返回结构化 metadata。

推荐第一版请求视图：

```text
system: Eva base system prompt

user: <project_context>
Contents of AGENTS.md:
...
</project_context>

user/assistant/tool: durable session history
```

这借鉴 `claude-code` 的 user context 注入方式，同时保留 `pi-mono` 风格的简洁 agent loop。

`ContextManager` 后续再承接：

- token accounting；
- project context budget；
- session summary；
- manual `/compact`；
- automatic threshold compaction；
- prompt-too-long recovery；
- post-compact project context / skills reinjection；
- context diagnostics。

## 阶段规划

### M0：稳定当前基线

目标：确认当前 runtime/session/mode 路径可靠。

范围：

- 建立真实 `test` 和 `typecheck` script。
- 覆盖 retry、tool loop、SessionManager、RuntimeHost、abort、queue 等核心测试。
- 保持 interactive 和 print 共享同一 runtime/session 路径。
- 修正 system prompt 中对未实现能力的描述。

验收标准：

- 核心测试不依赖外部 LLM API。
- 当前 CLI 行为不回归。
- 当前架构事实记录在 `docs/architecture.md`。

### M1：补齐会话命令与 Diagnostics

目标：让当前 Agent 日常可用，减少隐式状态。

范围：

- `/new`
- `/resume`
- `/resume <id>`
- `/history`
- `/stats`
- 当前 workspace 的 session list。
- config/provider/tools/session/resource diagnostics 统一收集和渲染。

验收标准：

- session 命令都通过 `RuntimeHost`。
- startup diagnostics 在 core 收集，在 mode 层渲染。

### M1.x：长任务上下文最小闭环

目标：在不提前引入完整 session tree 的前提下，解除 interactive 长任务被固定 step guard 和完整历史上下文拖住的问题。

范围：

- 对齐 `pi-mono` 的 agent-loop 自然停止语义；
- 将当前 `max_steps` 从 interactive core loop 的默认硬限制迁出，保留为 print/headless/RPC 可选 guard 的设计方向；
- 增加 `ContextBuilder` 最小版，构造 LLM request messages；
- 将 `AGENTS.md` 作为 transient project context 注入请求视图；
- 确保 project context 不写回 session log；
- 增加 context diagnostics 最小输出，说明 project context 是否被注入；
- 持久化 assistant usage，提供 token accounting fallback；
- 增加 flat JSONL 兼容的 compaction entry；
- 将 `ContextBuilder` 演进为可预算的 context rebuild 入口；
- 支持手动 `/compact`。

验收标准：

- interactive 会话不再把固定 100 steps 当作长任务上限；
- LLM mock 能观察到 `AGENTS.md` project context；
- `SessionManager` 中不会持久化 transient project context；
- compact 后 session 可以继续 resume；
- 完整历史仍保留在 session log 中；
- context rebuild 可测试且确定；
- compaction 失败不破坏当前 session。

### M2：RuntimeServices 与 Resource Loader

目标：停止继续扩大 `createRuntime()` 的职责。

范围：

- 引入 `RuntimeServices`。
- 将 cwd 绑定的 config、resources、tools、sessions、diagnostics 移入 services。
- 加载 system prompt、项目上下文、skills metadata、MCP config。
- 将资源加载和上下文构造分离：`ResourceLoader` 只读资源，`ContextBuilder` 决定请求注入。
- 支持 reload。

验收标准：

- mode 不知道资源发现细节。
- resource diagnostics 默认非致命。
- builtin tool loading 与 resource loading 保持分离。

### M3：Headless RPC

目标：让 Eva AI 可被外部程序嵌入，而不新增第二套 agent 实现。

范围：

- JSONL stdin/stdout 协议。
- `prompt`
- `get_state`
- `abort`
- `new_session`
- 通过 RPC stream `AgentSessionEvent`。

验收标准：

- interactive、print、RPC 共享 `RuntimeHost`。
- RPC 能驱动多轮 tool loop。
- 非法 JSON 和未知命令返回结构化错误。

### M4：Session Tree 与可恢复状态

目标：从 flat transcript 过渡到可恢复 agent state。

范围：

- session entry schema。
- context rebuild。
- 将 M1.x 的 flat compaction entry 演进到 tree/path-aware context rebuild。
- `/fork`
- `/clone`
- import/export。
- sidecar metadata 预留。

验收标准：

- branch/fork 保留历史。
- context rebuild 可测试且确定。
- 旧 JSONL session 可兼容处理。

### M5：Tool Harness Hardening

目标：让工具执行在真实编码工作负载下可预测。

范围：

- read-only 并发批次。
- write/bash 串行批次。
- tool result ordering。
- result budget。
- oversized output persistence。
- operations injection。
- edit diff 和确认展示数据。

验收标准：

- 并发工具不会竞态修改消息状态。
- 写操作保持串行。
- 大输出不会淹没上下文。
- 工具可用 mock operations 测试。

### M6：Permission And Safety

目标：从高风险确认升级为权限管线。

范围：

- rules：allow/deny/ask。
- modes：default/plan/accept-edits/bypass/dont-ask。
- headless deny behavior。
- dangerous bash checks。
- filesystem safety checks。
- sandbox hook points。

验收标准：

- 每个 tool call 经过统一权限决策。
- interactive 与 RPC/headless 行为明确。
- deny 结果结构化进入 tool result。

### M7：MCP、Skills 与 Extensions

目标：接入外部能力，但不阻塞启动，不污染 builtin tools。

范围：

- MCP config loader。
- MCP server approval state。
- pending/connected/failed lifecycle。
- timeouts、reconnect、dedupe。
- skills progressive disclosure。
- extension hook skeleton。

验收标准：

- 慢 MCP server 不阻塞第一轮 prompt。
- MCP failure 降级为 diagnostics。
- skills/MCP tools 与 builtin tools 权责分离。

### M8：Context Management

目标：在 M1.x 最小闭环基础上，把长会话上下文管理补齐到更完整的 harness 能力。

范围：

- automatic threshold compaction。
- prompt-too-long recovery。
- tool result micro-compaction。
- oversized output persistence。
- post-compact reinjection budgets。
- compaction failure circuit breaker。

验收标准：

- compact 后 session 仍可 resume。
- 完整历史仍保留在 session log 中。
- compaction 失败不会破坏当前 session。

### M9：体验与长期运行

目标：在 harness 稳定后增强日常使用体验。

范围：

- thinking/tool output 折叠或隐藏。
- session selector。
- token/cost/timing visibility。
- TUI 或更丰富 interactive UI。
- policy switches 和 feature flags。
- optional memory/subagent systems。

验收标准：

- UI 改动不改变 core 行为。
- 运行数据可观测，但不把 core 耦合到 renderer。

## 当前非目标

- 不直接复制 `claude-code`。
- 不在权限规则和模式成熟前引入 classifier 自动审批。
- 不在 session tree、sidecar metadata 和权限上下文成熟前实现 subagents。
- 不在 interactive、print、RPC 共用稳定 runtime 前构建重 TUI。
- 不把 MCP/skills 混入 builtin tool ownership。

## 判断标准

每个阶段开始前都应回答：

- 这一步是否强化了 Eva AI 的核心边界？
- 是否能通过测试验证？
- 是否会让 mode 层知道过多 runtime 细节？
- 是否把路线图能力误写成当前已实现能力？
- 是否保持了“小而清晰”的代码形态？
