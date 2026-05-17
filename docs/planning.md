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

## 架构域划分

架构域用于描述 Eva AI 长期应保持稳定的边界；阶段规划用于描述这些边界按什么顺序落地。二者不合并，避免把时间线误读成最终模块边界。

### 1. Agent Runtime

目标：建立所有运行模式共享的 agent 执行核心。

范围：

- `agent-loop`：LLM turn、tool execution、event emission、abort handling。
- `Agent`：有状态 wrapper，管理 messages、tools、队列、active run。
- `AgentSession`：连接 Agent、session persistence、tool governance 和 UI-facing events。
- `AgentMessage` / `LlmMessage` 双层消息模型：内部/session/harness 消息与 provider 请求消息分离。
- `RuntimeHost` / `RuntimeServices`：管理当前 runtime、cwd 绑定服务、session 切换与 reload。

参考策略：

- 结构边界优先参考 `pi-mono` 的 `agent` / `AgentSessionRuntime` / `AgentSessionServices`。
- 消息边界优先参考 `pi-mono` 的 `AgentMessage[] -> transformContext() -> AgentMessage[] -> convertToLlm() -> Message[]`。
- 事件和 hook 点保留足够扩展性，但不提前复制 `claude-code` 的复杂运行时。

### 2. Session / Recovery

目标：让会话不只是消息数组，而是可恢复、可分支、可重建的运行记录。

范围：

- JSONL session entry model。
- entry-tree-first session model：append-only `SessionEntry` tree 成为主要事实源，`Message[]` 只是从当前 leaf path 派生出的 provider/session view。
- session tree、active leaf、fork、clone、import/export。
- resume、session metadata、compaction entry、future sidecar metadata。
- 可恢复运行现场，包括 transcript、agent metadata、file history、todo/memory/subagent metadata。

参考策略：

- 优先学习 `pi-mono` 的 append-only session tree 和 path-aware context rebuild。
- 逐步从当前 message-snapshot-first 过渡到 entry-tree-first；避免只做 session-level lineage，而没有真正对齐 `pi-mono` 的 leaf/path 语义。
- 选择性吸收 `claude-code` 的 transcript、compact boundary、file history 和恢复工程经验。

### 3. Context Management

目标：让发送给模型的上下文成为可解释、可预算、可恢复的 request view。

范围：

- `ContextBuilder`：无状态构造 provider request view。
- `ContextManager`：后续承接 token budget、manual/auto compaction、summary、prompt-too-long recovery。
- project context / skills / tool result budgets。
- context diagnostics、usage accounting、post-compact reinjection。

参考策略：

- 第一阶段保持 `pi-mono` 风格的简洁 transform/context rebuild。
- 后续吸收 `claude-code` 的 token estimation、microcompact、auto compact 和 prompt-too-long recovery。

### 4. Tool System

目标：让工具定义、执行、结果和测试注入具备真实编码负载下的可预测性。

范围：

- tool registry、builtin tools、MCP/custom tools ownership。
- read-only 并发、write/bash 串行、tool result ordering。
- per-tool / aggregate result budget、oversized output persistence。
- operations injection、edit diff、tool rendering metadata。

参考策略：

- 保留 `pi-mono` 简洁的 tool definition / tool execution hook。
- 吸收 `claude-code` 的 tool orchestration、streaming tool execution、result budget 和大输出保护。

### 5. Permission / Safety

目标：所有高风险操作经过统一、可解释、可测试的权限决策路径。

范围：

- permission rules：allow、deny、ask。
- permission modes：default、plan、accept-edits、bypass、dont-ask。
- interactive confirmation、headless/RPC fail-closed。
- bash/file safety、sandbox hook points、permission diagnostics。

参考策略：

- 先实现 deterministic rules 和 mode，再预留 classifier slot。
- 不在基础权限管线成熟前引入自动审批。

### 6. Resources / MCP / Skills / Extensions

目标：把外部资源和扩展能力从 builtin tools 中解耦出来，并支持渐进加载。

范围：

- system prompt、`AGENTS.md` / `CLAUDE.md` project context、prompt templates。
- skills metadata、progressive disclosure。
- MCP config、server lifecycle、tools/resources/prompts。
- extension hook skeleton、reload、diagnostics。

参考策略：

- 资源发现和读取参考 `pi-mono` 的 ResourceLoader。
- MCP/skills 的 lifecycle、dedupe、approval 和超时降级吸收 `claude-code` 的工程实践。

### 7. Modes / Interfaces

目标：interactive、print/headless、RPC/SDK、未来 TUI 共享同一 runtime/session 核心。

范围：

- interactive CLI。
- print/headless single-run。
- JSONL RPC / SDK embedding。
- future TUI 和更丰富 UI。

参考策略：

- mode 层只负责 I/O 和展示，不直接装配 config、resources、tools、sessions。
- 所有模式通过 `RuntimeHost` / `AgentSession` 进入核心路径。

### 8. Provider / Config / Observability

目标：让 provider 差异、配置、诊断和运行数据可观测但不污染核心业务边界。

范围：

- provider adapters 和 streaming event normalization。
- config/settings、model selection、retry。
- diagnostics、usage/cost/timing、startup/runtime reporting。
- telemetry/logging hook points。

参考策略：

- provider 差异留在 `llm` 层。
- diagnostics 在 core 收集，在 mode 层展示。

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

### AgentMessage / LlmMessage 双层消息模型

当前 Eva AI 仍是单层 `Message[]`：session history、agent-loop working messages、`ContextBuilder` 输入输出和 provider request messages 使用同一类型。这是早期最小闭环的取舍，不是长期目标。

后续核心骨架应对齐 `pi-mono`，把内部消息和 provider 请求消息分离：

```text
AgentMessage[] -> transformContext() -> AgentMessage[] -> convertToLlm() -> LlmMessage[] -> provider
```

目标语义：

- `AgentMessage` 是 Eva 内部/session/harness 消息层，可承载普通 user/assistant/tool，也可承载 compaction summary、permission pending、resource/context marker、tool execution metadata、UI-only state 和未来 MCP/skills/extensions 产生的消息。
- `LlmMessage` 是 provider 请求消息层，只包含模型 API 能理解的 system/user/assistant/tool 结构。
- `transformContext()` 在 `AgentMessage` 层完成 context pruning、compaction summary、resource/skills reinjection 和预算策略。
- `convertToLlm()` 是唯一把内部消息转换为 provider request messages 的边界；不能发送给模型的内部消息必须在这里过滤或降级。
- `AgentSessionEvent` 仍是事件流，不替代 `AgentMessage`；UI/RPC 可基于事件渲染，也可读取 session 中的 `AgentMessage` 状态。

该能力属于核心骨架，不应等到完整 session tree 才引入。它应先于 RPC/TUI/MCP/Extensions 的完整形态落地，避免后续接口绑定当前临时的单层 `Message[]`。

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

当前 Eva AI 已有高风险 confirmation，并已把最小 tool permission decision 统一为 `allow`、`deny`、`ask`。完整目标仍是演进为统一权限管线。

推荐顺序：

1. rules：从当前最小 `allow`、`deny`、`ask` 语义演进为可配置规则。
2. modes：default、plan、accept-edits、bypass、dont-ask。
3. interaction：interactive 下询问用户。
4. headless/RPC：无确认通道时默认 fail-closed；RPC/ACP 后续把 `ask` 暴露为 pending permission event。
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
- 支持基于 context reserve 的自动 compaction；
- 支持 prompt-too-long recovery；
- compaction 作为 session entry 写入；
- compact 后按预算重新注入 project context 和 skills。

实施取舍：

- 先实现 flat JSONL 兼容的 compaction entry 和 context rebuild 最小闭环；
- 不必为了第一版 `/compact` 立即完成完整 session tree；
- 完整历史必须继续保留在 session log 中，只改变发送给模型的上下文视图；
- 后续再补齐 tool result micro-compaction、大输出持久化和更完整的 post-compact skills/resource reinjection。

### Context Builder / Context Manager 分工

Eva AI 的上下文治理分两层推进：

- `ContextBuilder`：无状态构造器。每次 LLM call 前，把当前 session messages、system prompt、project context 和 runtime context 组合成发送给 provider 的 request messages。
- `ContextManager`：有状态管理器。后续负责 token budget、manual/auto compaction、summary、post-compact resource reinjection 和 context diagnostics。

第一阶段先实现 `ContextBuilder`、最小 `ContextManager` diagnostics 聚合、TokenCounter provider/local 边界、本地 request token estimation、Anthropic/Gemini countTokens 最小接入、可选 context usage percent、auto compaction、prompt-too-long recovery 和 post-compact resource budget 最小闭环，避免过早引入完整 Claude Code 式 context engine。当前最小 `ContextManager` 只聚合 `ContextBuilder.latestBuild`、session usage、compaction、step guard、project context metadata、token count source、基于配置窗口的 usage percent 和 compaction recommendation；`AgentSession.run()` 只在 `reserve_reached` 时基于该 recommendation 自动调用现有 `compact()`，并在 context overflow 时执行一次 compact-and-retry。

`ContextBuilder` 的目标行为：

- 不修改 `SessionManager` 中的真实 session history；
- 不把 `AGENTS.md` 持久化为普通 user message；
- 保留当前 system prompt 兼容路径；
- 在请求模型前临时注入 project context；
- 对 project context 应用轻量字符预算，避免 `AGENTS.md` 无限制膨胀请求；
- 当 active context 已 compact 时，对 project context 应用更保守的 post-compact 有效预算；
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
- automatic reserve-based compaction execution；
- prompt-too-long recovery；
- 更完整的 post-compact project context / skills reinjection；
- context diagnostics。

## 阶段规划

### M0：稳定当前基线

目标：确认当前 runtime/session/mode 路径可靠。

涉及架构域：

- Agent Runtime
- Modes / Interfaces
- Provider / Config / Observability

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

涉及架构域：

- Agent Runtime
- Session / Recovery
- Modes / Interfaces
- Provider / Config / Observability

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

涉及架构域：

- Agent Runtime
- Session / Recovery
- Context Management
- Provider / Config / Observability

范围：

- 对齐 `pi-mono` 的 agent-loop 自然停止语义；
- 将当前 `max_steps` 从 interactive core loop 的默认硬限制迁出，保留为 print/headless/RPC 可选 guard 的设计方向；
- 增加 `ContextBuilder` 最小版，构造 LLM request messages；
- 将 `AGENTS.md` 作为 transient project context 注入请求视图；
- 确保 project context 不写回 session log；
- 增加 context diagnostics 最小输出，说明 project context 是否被注入；
- 增加 project context 字符预算；
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

涉及架构域：

- Agent Runtime
- Tool System
- Resources / MCP / Skills / Extensions
- Provider / Config / Observability

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
- reload 后当前 session 保持不变，下一次 LLM request 使用新的 request-time context。

### M2.x：Agent Core Alignment（已完成最小闭环）

目标：在继续扩展 RPC、TUI、MCP/Skills/Extensions 之前，先把 Eva 的核心 agent/message 边界对齐 `pi-mono`。

涉及架构域：

- Agent Runtime
- Session / Recovery
- Context Management
- Modes / Interfaces
- Provider / Config / Observability

范围：

- 引入 `AgentMessage` / `LlmMessage` 双层消息模型。
- 将现有 provider-facing `Message` 逐步收敛为 `LlmMessage` 或同等命名。
- 让 `Agent`、`AgentSession` 和 agent-loop 的 working history 围绕 `AgentMessage[]` 工作。
- `SessionManager` 保持 provider-visible `message` entry 兼容，同时通过 durable `internal` entry 承载需要跨 resume 恢复的 harness metadata。
- 增加 `transformContext(AgentMessage[]) -> AgentMessage[]` 边界，用于后续 budget、compaction、resource/skills reinjection。
- 增加 `convertToLlm(AgentMessage[]) -> LlmMessage[]` 边界，并让 `ContextBuilder` 输出 provider request view。
- 保持现有 flat JSONL session 兼容，不在本阶段强行完成 session tree。
- 保持现有 CLI 行为、context diagnostics 和 provider usage 持久化不回归。

验收标准：

- agent-loop 不再直接把 session history 当作 provider request messages。
- LLM mock 能观察到 `convertToLlm()` 后的 request view。
- transient project context、compaction summary 和 tool results 的写回边界清晰可测。
- permission pending 可以写入 durable `internal` entry，并通过 diagnostics 暴露。
- `AgentSessionEvent` 与 `AgentMessage` 职责分离：事件用于流式展示，消息用于 session/harness 状态。
- 后续 RPC/TUI 可以基于 `AgentMessage` 暴露状态，而不是绑定 provider `Message`。

### M3：Headless RPC

目标：让 Eva AI 可被外部程序嵌入，而不新增第二套 agent 实现。

涉及架构域：

- Agent Runtime
- Session / Recovery
- Modes / Interfaces

范围：

- JSONL stdin/stdout 协议。
- 最小 request envelope：`{ id, method, params }`。
- 最小 response/event envelope：`{ id, type, ... }`，其中 `type` 至少包含 `response`、`event`、`error`。
- `prompt`：追加 user message，驱动 `AgentSession.run()`，并把 run lifecycle 作为 RPC events 输出。
- `get_state`：返回当前 session id、message count、usage、compaction、step guard、provider/model 和 diagnostics 摘要。
- `abort`：中断当前 active run；第一版只需要支持单 active run。
- `new_session`：通过 `RuntimeHost.newSession()` 创建并切换 session。
- `resume_session`：通过 `RuntimeHost.switchSession()` 切换指定 session；未传 id 时可恢复 latest session。
- 通过 RPC stream 输出稳定的 session lifecycle events；第一版复用 `AgentSessionEvent` 字段，但包在 RPC envelope 内，避免外部直接绑定内部事件 transport。

验收标准：

- interactive、print、RPC 共享 `RuntimeHost`。
- RPC 能驱动多轮 tool loop。
- 非法 JSON 和未知命令返回结构化错误。
- `prompt` 会输出 `agent_start` / message streaming / tool event / `agent_end` 或 `error`。
- `get_state` 不触发 LLM 调用。
- print/TUI/interactive 行为不因 RPC mode 引入而回归。

非目标：

- 第一版不实现完整 ACP。
- 第一版不实现多 run 并发调度。
- 第一版不实现远程 permission approval；遇到需要确认但无确认通道时仍沿用 fail-closed / pending permission 语义。
- 第一版不升级 session tree。

#### M3.1：RPC Permission Pending 设计

目标：在不提前引入完整 M6 权限系统的前提下，定义 RPC/headless 如何表达需要人工审批的 tool call。

当前行为：

- interactive/TUI 通过 mode 层提供 confirmation handler，并返回 `allow` 或 `deny`。
- print/headless/RPC 没有 confirmation handler 时继续 fail-closed。
- fail-closed 时 runtime 会写入 durable `permission_pending` internal entry，并由 `ContextManager` diagnostics 汇总。

最小实现：

- RPC 默认仍是 `fail_closed`，保持当前 headless 安全语义。
- 可在 `prompt.params.permission_mode` 中显式传入 `request`，表示客户端愿意接收 pending event 并通过 RPC 命令审批。
- 当工具治理需要确认且当前 RPC run 启用了 `request`：
  - RPC mode 创建稳定 `permission_id`；
  - 通过 RPC event envelope 输出 `permission_pending`；
  - `event.permission` 至少包含 `permission_id`、`tool_call_id`、`tool_name`、`risk_level`、`source`、`category`、`is_read_only`、`requires_confirmation`、`reason` 和安全截断后的 `args_preview`；
  - 同时继续写入 durable `permission_pending` internal entry，保证 diagnostics / resume 可见。
- 客户端通过 `approve_permission` 或 `deny_permission` 命令返回决定：
  - `approve_permission.params.permission_id` -> resolve 为 `allow`；
  - `deny_permission.params.permission_id` 和可选 `reason` -> resolve 为 `deny`；
  - 未知、已解决或过期的 permission id 返回结构化 `error`。
- `get_state` 包含 pending permission 摘要，至少包含数量和最近 pending id。
- `abort` active run 时，所有未解决 pending permission 应被取消，并返回被 abort 的 tool result。
- pending permission 应有 timeout；timeout 后默认 deny/fail-closed，避免 headless run 无限悬挂。

内部边界：

- 在 RPC mode 内引入轻量 `RpcPermissionBroker`，只负责当前 active run 的 pending map、event 输出、approval/deny resolve 和 timeout。
- Runtime / Tool governance 仍只理解 `ToolPermissionDecision`，不直接知道 RPC 协议。
- durable session metadata 可以继续使用现有 `permission_pending` internal entry；是否追加 `permission_resolved` entry 留到 M6 或 session model 演进时决定。

验收标准：

- 默认 RPC 行为不变：无审批通道时继续 fail-closed。
- 开启 request 模式后，高风险 tool call 会输出 `permission_pending` event，而不是直接执行。
- `approve_permission` 后工具继续执行；`deny_permission` 后工具返回结构化 deny result。
- `abort` 和 timeout 不会留下永远 pending 的 promise。
- RPC stdout 仍保持纯 JSONL。

非目标：

- 不在 M3.1 实现完整 permission modes：default、plan、accept-edits、bypass、dont-ask。
- 不在 M3.1 实现规则文件、危险命令分类器或 sandbox policy。
- 不让 RPC event 直接暴露未截断的完整 tool args。

### M4：Session Tree 与可恢复状态

目标：从 flat transcript 过渡到可恢复 agent state。

涉及架构域：

- Session / Recovery
- Context Management

范围：

- session entry schema：先在 `session_start` 上增加向后兼容 lineage metadata。
- session entry schema：逐步为 `message`、`compaction`、`usage` 和 `internal` entry 增加 `entryId` / `parentEntryId`。
- context rebuild。
- 将 M1.x 的 flat compaction entry 演进到 tree/path-aware context rebuild。
- `/fork`
- `/clone`
- import/export。
- sidecar metadata 预留。

当前最小落地：

- `SessionManager` 已支持 `parentSessionId`、`rootSessionId` 和 `forkedFromMessageIndex`。
- 旧 JSONL session 没有 lineage metadata 时会被视为 root session。
- `SessionManager.forkSession()` 优先复制当前 active entry path 到新 session，并写入 lineage metadata；旧 JSONL 没有 entry metadata 时回退复制 active context messages。
- `RuntimeHost.forkSession()` 暴露 fork 边界，mode 层不需要直接访问 `SessionManager`。
- interactive/TUI slash command 可通过 `/fork [id] [--entry <entryId>]` 创建当前 session 分支。
- `SessionManager.cloneSession()` / `RuntimeHost.cloneSession()` 已按 `pi-mono` 的 current-leaf fork 语义实现 clone，并复用 entry-path fork。
- interactive/TUI slash command 可通过 `/clone [id] [--entry <entryId>]` 克隆当前 session。
- `SessionManager.exportSession()` / `RuntimeHost.exportSession()` 已支持 JSONL session 导出。
- `SessionManager.importSession()` / `RuntimeHost.importSession()` 已支持 JSONL session 导入并切换到导入后的 session。
- interactive/TUI slash command 可通过 `/export [path]` 和 `/import <path>` 做最小 JSONL import/export。
- 新写入的 `message`、`compaction`、`usage` 和 `internal` entry 已带有 `entryId` / `parentEntryId`，`SessionManager.getEntryTreeInfo()` 可返回当前 session 文件内的 entry tree metadata。
- `SessionManager.getEntryPath()` 已可从 active entry leaf 回溯当前 session 文件内的 path entries。
- `SessionContextRebuilder` 已提供最小 rebuild 边界：新 session 使用 `entry_path` 策略从 active leaf 构造 messages，旧 JSONL 无 entry metadata 时回退 `flat_snapshot`。
- `SessionManager.loadSession()` 已在主加载路径中使用 active entry path 重建 active messages，`RuntimeHost` resume/switch 后的 `AgentSession` 会使用 path-aware context。
- `SessionManager.listSessionTree()` 已支持基于 `parentSessionId` 的 workspace session-level lineage tree。
- interactive `/sessions` 已改为展示 session tree，并标记 current/latest session。
- `RuntimeHost.switchToParentSession()` 已提供 mode 层向 parent session 导航边界，interactive `/parent` 可切换到当前 session 的 parent session。
- M4.x entry-path fork/clone 第一小步已落地：fork/clone 不再只复制 active `Message[]` 快照，而是优先复制 active leaf path 上的 session entries。
- RuntimeHost、interactive slash command 和 RPC 已支持指定 `leafEntryId` / `leaf_entry_id` 的 fork/clone。
- `SessionManager.branchSession()` 已支持同 session 文件内移动 active leaf，并由当前 leaf path 派生 active messages。
- `RuntimeHost.branchSession()`、interactive `/branch <entryId>` 和 RPC `branch_session` 已暴露 entry-level branch 最小入口。

后续仍需：

- 更完整的 child branch navigation。
- entry-level branch / navigate 继续增强：补 tree 展示中的 entry id 可见性、branch summary 和更完整导航体验。
- entry-tree-first 收敛：让 append-only `SessionEntry` tree 成为主要事实源，`Message[]` 退化为 `buildSessionContext()` 的派生结果。
- 跨 session parent/child entry graph 与 sidecar metadata。

验收标准：

- branch/fork 保留历史。
- context rebuild 可测试且确定。
- 旧 JSONL session 可兼容处理。

#### M4.x：Entry Tree First 对齐

目标：把 Eva 当前的 message-snapshot-first session model 收敛到更接近 `pi-mono` 的 entry-tree-first 模型。

当前状态：

- Eva 已有 `entryId` / `parentEntryId`、`activeEntryId`、`getEntryPath()` 和 entry-path resume。
- 但 `SessionManager` 仍维护 `Map<sessionId, Message[]>` 作为 active messages 主状态。
- `forkSession()` / `cloneSession()` 已优先复制指定 leaf path 上的 session entries，RuntimeHost、interactive slash command 和 RPC 均可传入 leaf entry。
- `branchSession()` 已可在同 session 文件内移动 active leaf，下一次 append 会从该 leaf 形成新分支。
- session tree 展示当前是 session-level lineage tree，不是单个 session 文件内部完整 entry tree navigation。

目标语义：

- append-only `SessionEntry` tree 是 session 的主要事实源。
- 当前上下文由 active leaf 沿 `parentEntryId` 回溯得到 path，再通过 `buildSessionContext()` 派生 `AgentMessage[]` / `Message[]`。
- fork/clone 支持指定 leaf entry，并复制该 leaf path 上的 entries。
- 同一 session 文件内支持 entry-level branch / navigate；切换 leaf 不修改旧 entries。
- branch summary、model/thinking changes、label/session info 和 future custom metadata 可作为一等 entry 渐进引入。

推荐落地顺序：

1. 先保留当前兼容层，新增 `buildSessionContextFromEntryPath()` 风格边界，让 message view 明确变成派生结果。
2. 已完成指定 leaf entry 的 entry path fork/clone，并已暴露到 RuntimeHost、interactive slash command 和 RPC。
3. 已完成 entry-level `branch(entryId)` 最小能力，先处理 message/compaction/internal/usage path。
4. 后续补 entry tree 展示中的 entry id 可见性、branch summary 和更完整 navigate UX。
5. 再逐步把 `SessionManager` 内部主状态从 `Map<sessionId, Message[]>` 收敛为 entry tree + active leaf。
6. 最后补 session version / migration，支持旧 JSONL 到 entry-tree-first 的兼容迁移。

非目标：

- 不一次性复制 `pi-mono` 的所有 session entry 类型。
- 不在 entry-tree-first 基础稳定前引入复杂 sidecar metadata 或 extension custom entries。

### M5：Tool Harness Hardening

目标：让工具执行在真实编码工作负载下可预测。

涉及架构域：

- Tool System
- Context Management
- Permission / Safety

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

涉及架构域：

- Permission / Safety
- Tool System
- Modes / Interfaces

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

涉及架构域：

- Resources / MCP / Skills / Extensions
- Tool System
- Permission / Safety
- Provider / Config / Observability

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

涉及架构域：

- Context Management
- Session / Recovery
- Tool System
- Provider / Config / Observability

范围：

- automatic reserve-based compaction。
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

涉及架构域：

- Modes / Interfaces
- Provider / Config / Observability
- Session / Recovery

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
