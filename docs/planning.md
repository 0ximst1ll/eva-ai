# Eva AI Planning

本文记录 Eva AI 的长期设计目标、架构域和阶段里程碑。它不记录短期任务细节；当前开发状态、下一步和已知问题放在 `docs/current.md`。

维护规则：

- 只有长期目标、架构域边界或阶段里程碑变化时才更新本文。
- 同一架构域内的小步骤不单独追加流水账。
- 已完成事实只保留里程碑级别，不展开到单个命令、测试、entry 类型或 diagnostic code。

## Project Goal

Eva AI 的目标是构建一个智能编码助手。它应该具备清晰、可演进的内核结构，也要具备真实编码场景所需的 harness 工程能力。

核心方向：

- 以 `pi-mono` 的架构设计理念作为骨架，建立稳定的 runtime/session/mode 分层。
- 吸收 `claude-code` 的 harness 工程实践，增强工具编排、权限治理、恢复能力、MCP 接入和上下文管理。
- 保持 Eva AI 自身代码小而清晰，不直接复制任一项目的复杂度。

设计取舍：

- 先建立清晰边界，再增加复杂能力。
- 先做可测试的核心路径，再引入自动化策略。
- 先用简单机制解决真实问题，再决定是否需要更重的抽象。

## Strategy

Eva AI 不在 `pi-mono` 和 `claude-code` 之间二选一。

- 架构层优先参考 `pi-mono`：runtime/session/mode 分层、append-only session tree、message/context 边界。
- 执行层选择性吸收 `claude-code`：工具编排、权限治理、恢复策略、MCP/Extensions、上下文预算。
- 工具大输出处理优先参考 `pi-mono`：临时展示物默认不作为 durable session artifact 保存，只有明确需要长期恢复的资产才进入持久化边界。
- 治理层优先可解释、可测试、fail-closed。
- 节奏上遵循“先骨架、后能力、再治理”。

## Pi-Mono Alignment Strategy

Eva AI 当前核心骨架已经接近 `pi-mono`，后续对齐不追求复制全部复杂度，而是优先补齐会明显影响编码体验、稳定性和长期扩展边界的细节。

对齐优先级：

- P0：Prompt Resource / Tool Prompt Metadata、Agent Runtime 和 Provider request lifecycle。优先补齐动态 system prompt、active tool prompt snippets/guidelines、failed assistant turn、stream error message lifecycle、retry UI state、provider model/auth/request option 细节，因为这些直接影响工具调用准确性、长任务稳定性和错误恢复体验。
- P1：Tool System 和 Session durable schema。优先补齐 typed tool result details 的 durable boundary、tool result block content、session migration 和 branch summary pipeline，因为这些决定工具输出、compaction 和恢复质量。
- P2：Extension/MCP 和 product polish。等核心 runtime/session/tool/provider 边界稳定后，再补完整 extension registry、package discovery、MCP lifecycle、export/search/selector 等产品能力。

各域对齐目标：

- Agent Runtime：从简单 delta event 逐步升级为更完整的 assistant turn lifecycle；错误、abort、partial output、retry 都应归一到同一消息生命周期，而不是散落在 provider 和 UI 层。
- Session / Recovery：entry tree 继续作为事实源；补齐 migration、labels/session info、branch summary、error/aborted assistant handling 和更完整的 tree navigation，但避免提前引入比当前需求更重的 repo 层。
- Tool System：保持 `renderCall` / `renderResult` / typed details 方向；补齐工具自身的 prompt snippet/guidelines、durable tool details、block content、rich renderer、extension tool registry 和更完整的 tool result compaction。
- Resources / Prompt Context：system prompt 不应只是静态配置文本；后续应基于 active tools、project context、skills 和 append prompt 动态构造 provider-facing prompt，并保持工具名、schema、使用边界和 UI 展示一致。
- Provider：从 client wrapper 继续收敛为 provider subsystem；补齐 model registry、compat flags、auth variants、stream error contract、payload/response hooks、session/cache affinity 和 cross-provider message transform。

## Architecture Domains

### 1. Agent Runtime

目标：建立所有运行模式共享的 agent 执行核心。

长期边界：

- `agent-loop`：LLM turn、tool execution、event emission、abort handling。
- `Agent`：有状态 wrapper，管理 messages、tools、队列和 active run。
- `AgentSession`：连接 Agent、session persistence、tool governance 和 UI-facing events。
- `RuntimeServices`：cwd 绑定服务装配。
- `RuntimeHost`：active runtime 和 session lifecycle 边界。
- `AgentMessage` / `LlmMessage`：内部/session/harness 消息与 provider request 消息分离。
- stream/message lifecycle：provider 首包前失败属于 provider retry；一旦已有 thinking/content/tool call 等部分输出，后续失败应由 agent-loop/session 从 durable message boundary 恢复，避免把半截 assistant/tool 状态写入 session。

里程碑：

- 已完成：Agent / loop / AgentSession / RuntimeServices / RuntimeHost 基础分层。
- 已完成：interactive、print、TUI、RPC 共享 runtime/session 核心。
- 已完成：AgentMessage / LlmMessage 最小消息边界。
- 后续：继续稳定 run lifecycle、usage/timing observability 和 future SDK embedding。

### 2. Session / Recovery

目标：让会话不只是消息数组，而是可恢复、可分支、可重建的运行记录。

长期边界：

- session log 保存 durable 主时间线和 metadata reference。
- append-only entry tree 是 session 事实源。
- derived context 从 active leaf path 派生 provider/session view。
- runtime state 保存短生命周期 run/abort/permission/queue。
- sidecar store 只用于明确需要跨 session 恢复的 durable metadata 或资产；普通大工具输出默认不进入 session sidecar。

里程碑：

- 已完成：entry-tree-first session model、active leaf、entry path rebuild、fork/clone/branch/import/export。
- 已完成：`SessionStorage`、`SessionEntryStore`、`SessionModel`、session parser 和 model helper 的第一层拆分。
- 已完成：session recovery diagnostics、schema validation、latest fallback 和用户可理解失败提示的最小闭环。
- 已完成：M4.x session reliability 收口，包括 recovery smoke cases。
- 后续：只有在出现 migration、repo-level delete/list/index、sidecar store 或跨 session entry graph 需求时，再拆完整 `SessionRepo`。
- 后续：branch summarization pipeline、sidecar metadata、schema migration framework。

### 3. Context Management

目标：让发送给模型的上下文成为可解释、可预算、可恢复的 request view。

长期边界：

- `ContextBuilder`：无状态 provider request view builder。
- `ContextManager`：token budget、compaction、summary、prompt-too-long recovery、diagnostics。
- `TokenCounter`：provider/local countTokens 边界。
- project context、skills 和临时大工具输出都以 request-time context 或 preview 进入 provider request，不默认写回 durable session history。

里程碑：

- 已完成：ContextBuilder / ContextManager 最小分层。
- 已完成：manual `/compact`、auto compaction、prompt-too-long recovery、post-compact resource budget。
- 已完成：Anthropic/Gemini provider countTokens 最小接入。
- 后续：完整 token budget engine、OpenAI countTokens、tool result budget、micro-compaction。

### 4. Tool System

目标：让工具定义、执行、结果和测试注入在真实编码负载下可预测。

长期边界：

- tool registry 管理 builtin、MCP 和 custom tools。
- tool metadata 承载 source、category、risk、read-only、confirmation 等信息。
- tool definition 后续应逐步吸收 `pi-mono` 的设计：把 LLM schema、metadata、prompt snippet/guidelines、execution mode、typed details、`renderCall` 和 `renderResult` UI boundary 收敛到同一工具定义边界。
- read-only tools 可并发；write/bash tools 应串行。
- execution mode 默认可由 metadata 推断，但应允许工具显式声明 `parallel` / `sequential`，避免复杂工具被全局策略误判。
- tool result ordering 和预算由统一 orchestration 管理。
- tool result 应从纯文本结果逐步升级为 `content + details`：截断统计、full output path、bash exit code、grep match count 等结构化信息进入 details，工具级 renderer、TUI/CLI 和后续 compaction 不解析文本；`/diagnostics` 不作为 tool details 的主要消费路径。
- tool output UX 应对齐 `pi-mono`：工具调用阶段展示工具自己的 call summary，结果阶段默认 collapsed 展示工具专属 partial output，expanded 展示更多已返回内容，并用 details 展示 truncation/full output/limit warnings。
- tool-specific preview 策略应由 renderer 决定：`read` 默认展示约 10 行，`grep` 约 15 行，`find`/`ls` 约 20 行，`bash` 展示 tail visual lines；后续 TUI 需要支持 expand/collapse。
- bash 输出应逐步对齐 `pi-mono` 的 streaming accumulator：执行中通过 partial update 刷新输出，内存只保留有界 tail，必要时写临时 full output 文件，并展示 elapsed/took 和 truncation/full output 提示。
- 大工具输出默认在工具层或 request view 层截断；bash 等流式输出可写临时文件供当前运行查看，但不作为通用 session artifact 长期保存。
- tool call / tool result / operations override 是后续 extension/MCP 的核心 hook 边界；先稳定内部 hook，再决定是否开放完整 extension API。

里程碑：

- 已完成：builtin tool registry、metadata 和 governance hook。
- 已完成：ToolResult `content + typed details` 最小边界，以及工具级 `renderCall` / `renderResult -> displayContent` 展示边界。
- 已完成：内部 extension-style tool execution hook 最小边界。
- 已完成：tool-specific collapsed preview 最小边界，`read` / `grep` / `find` / `ls` / `bash` 默认按工具类型展示部分输出。
- 已完成：TUI 最近工具结果 expand/collapse 最小闭环。
- 后续：tool output UX 继续补齐更完整的行/字节统计、RPC partial update 策略和 compaction-time tool result micro-compaction。
- 后续：read-only 并发、write/bash 串行、轻量 tool result budget、临时大输出处理、operations injection。
- 后续：MCP/custom tools 接入同一 registry、metadata 和 hook 模型。

### 5. Permission / Safety

目标：所有高风险操作经过统一、可解释、可测试的权限决策路径。

长期边界：

- permission decision：`allow`、`deny`、`ask`。
- permission modes：`default`、`read-only`、`full-access`。
- `default`：允许读取/编辑当前 workspace 文件和执行本地命令；编辑 workspace 外文件或访问网络时请求权限。
- `read-only`：只允许读取文件和只读工具；写文件、状态修改、网络访问和非只读命令默认拒绝。
- `full-access`：Eva 层不再请求权限，允许 workspace 外文件编辑和网络访问，但仍受底层 sandbox、操作系统和用户环境限制。
- interactive/TUI 可询问用户；headless/RPC 无确认通道时按当前 mode fail-closed 或输出 pending。
- classifier slot 只预留，不在基础规则成熟前自动审批。

里程碑：

- 已完成：tool confirmation 最小治理。
- 已完成：permission pending durable diagnostics。
- 已完成：RPC permission pending approval 最小闭环。
- 后续：permission rule engine、mode 策略、sandbox policy integration。

### 6. Resources / MCP / Skills / Extensions

目标：把外部资源和扩展能力从 builtin tools 中解耦出来，并支持渐进加载。

长期边界：

- ResourceLoader 管 system prompt、project context、skills、prompt templates、MCP config 和 diagnostics。
- skills 是 resource，不是 builtin tool。
- MCP server lifecycle 支持 pending、connected、failed 和 timeout 降级。
- extensions 后续通过清晰 hook 和 package/source discovery 接入。

里程碑：

- 已完成：ResourceLoader 最小边界。
- 已完成：`AGENTS.md` project context request-time 注入。
- 已完成：skills discovery、source metadata、metadata system prompt 注入和 explicit invocation。
- 后续：package/extension source discovery。
- 后续：MCP server lifecycle、tools/resources/prompts loading、approval 和 reload。

### 7. Modes / Interfaces

目标：interactive、print/headless、RPC/SDK、TUI 共享同一 runtime/session 核心。

长期边界：

- mode 层只负责 I/O 和展示。
- session lifecycle 通过 RuntimeHost。
- agent execution 通过 AgentSession。
- 外部协议通过 RPC/SDK 边界适配，不复制 core runtime。

里程碑：

- 已完成：interactive / print 分层。
- 已完成：TUI 最小框架接入共享 runtime。
- 已完成：Headless JSONL RPC 最小闭环。
- 后续：ACP/SDK compatibility、真实终端兼容性 smoke test。

### 8. Provider / Config / Observability

目标：让 provider 差异、配置、诊断和运行数据可观测但不污染核心业务边界。

长期边界：

- provider adapters 和 streaming normalization 留在 `llm` 层，但不把模型能力、认证、请求参数和错误恢复全部塞进单个 client。
- provider subsystem 应逐步对齐 `pi-mono` 的成熟设计：模型注册/解析、认证解析、请求选项、provider adapter 和 session-level retry/recovery 分层。
- `ProviderModel` / `ModelSpec` 记录 provider、api protocol、model id、baseUrl、context window、max output、reasoning/thinking support 和 provider-specific compatibility metadata。
- `ProviderAuthResolver` 统一解析 config/env/runtime auth，当前优先支持 API key，后续再决定是否接入 OAuth 或 provider-specific auth storage。
- `ProviderRequestOptions` 统一承载 reasoning level、temperature、maxTokens、timeout、headers、sessionId、retry cap 和 provider diagnostics hooks。
- Google provider 应按 model metadata 和 reasoning option 生成 `thinkingConfig`：不要无条件开启 `includeThoughts`；Gemini 3.x Flash/Pro 等模型按 provider-specific `thinkingLevel` 或 budget 映射处理。
- config/settings 由 RuntimeServices 读取并校验。
- diagnostics 在 core 收集，在 mode 展示。
- provider request lifecycle 应覆盖 provider/SDK retry、session auto-retry、Retry-After/timeout/abort 和用户可理解错误展示；provider 层只负责请求启动和未输出前的重试，流式中途失败恢复归入 Agent Runtime 的 turn lifecycle。
- usage/cost/timing 通过稳定结构暴露。

里程碑：

- 已完成：Anthropic/OpenAI/Gemini provider adapter 基础边界。
- 已完成：runtime diagnostics 统一结构。
- 已完成：provider usage persistence、provider error display 和 session-level retryable provider error auto-retry 最小闭环。
- 后续：ProviderModel / ProviderRequestOptions / ProviderAuthResolver 最小骨架。
- 后续：Google thinking/reasoning request 构建对齐 `pi-mono`，修正 Gemini 3.x Flash/Pro 等模型的 thinkingConfig 策略。
- 后续：更完整 usage/cost/timing observability、config 命名收敛、model selection policy。

## Stage Roadmap

### M0 Foundation

目标：完成 TypeScript harness 基础和项目命名收敛。

状态：已完成。

### M1 Agent Runtime Skeleton

目标：建立 agent-loop、Agent、AgentSession、RuntimeServices、RuntimeHost 和 mode 分层。

状态：已完成，后续只做稳定性增强。

### M2 Context Management

目标：建立 provider request view、token counting、manual/auto compaction 和 prompt-too-long recovery。

状态：核心路径已完成，后续进入完整 budget engine 和轻量 tool result budget。

### M3 Modes / RPC / TUI

目标：让 interactive、print、TUI、RPC 共享 runtime/session 核心。

状态：最小闭环已完成，后续补 ACP/SDK compatibility 和终端 smoke test。

### M4 Session / Recovery

目标：把 session 从 message-snapshot-first 收敛到 entry-tree-first，并完成可靠恢复。

状态：当前计划内核心架构和 reliability 收口已完成；后续 session 工作作为增强项推进。

### M5 Tool And Permission Governance

目标：完善工具编排、轻量结果预算和权限规则。

状态：已有基础 metadata/governance/pending approval，后续进入更完整 rule/mode/budget，并将超大工具输出从 durable artifact 设计收敛为 `pi-mono` 风格的 preview/临时输出。

### M5.5 Provider Reliability And Request Lifecycle

目标：把 provider 从直接 client wrapper 升级为可解释、可配置、可恢复的请求生命周期边界，优先解决真实使用中的 Gemini high-demand、thinking 配置和 provider retry 体验问题。

状态：session-level retryable provider error auto-retry、ProviderModel / ProviderRequestOptions / ProviderAuthResolver 和 Google thinking/reasoning 构建最小闭环已完成；后续需要补齐流式中途失败时的 Agent Runtime turn lifecycle 恢复。

### M6 Resources / MCP / Extensions

目标：接入 package/extension source discovery 和 MCP lifecycle。

状态：skills/resource 最小边界已完成，MCP lifecycle 未实现。

### M7 Observability And Productization

目标：完善 diagnostics、usage/cost/timing、config migration、SDK/ACP 和真实环境验证。

状态：部分基础已完成，作为后续跨域收口阶段。

## Non-Goals For Current Phase

- 不为了单个小能力提前拆完整 `SessionRepo`。
- 不在工具预算和权限管线稳定前引入自动审批。
- 不在 MCP lifecycle 成熟前把 MCP tools 混入 builtin tools。
- 不把 project context、skills 全文或 runtime marker 默认写入 durable session history。
- 不用 fixed `max_steps` 作为 interactive 长任务的默认会话上限。
