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
- 治理层优先可解释、可测试、fail-closed。
- 节奏上遵循“先骨架、后能力、再治理”。

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
- sidecar store 后续保存大对象、artifact、file history、todo/memory/subagent metadata。

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
- project context、skills、tool results 都以 request-time context 进入 provider request，不默认写回 durable session history。

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
- read-only tools 可并发；write/bash tools 应串行。
- tool result ordering、预算和大输出持久化应由统一 orchestration 管理。

里程碑：

- 已完成：builtin tool registry、metadata 和 governance hook。
- 后续：read-only 并发、write/bash 串行、result budget、大输出持久化、operations injection。
- 后续：MCP/custom tools 接入同一 registry 和 metadata 模型。

### 5. Permission / Safety

目标：所有高风险操作经过统一、可解释、可测试的权限决策路径。

长期边界：

- permission decision：`allow`、`deny`、`ask`。
- permission modes：default、plan、accept-edits、bypass、dont-ask。
- interactive 可询问用户；headless/RPC 无确认通道时 fail-closed。
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

- provider adapters 和 streaming normalization 留在 `llm` 层。
- config/settings 由 RuntimeServices 读取并校验。
- diagnostics 在 core 收集，在 mode 展示。
- usage/cost/timing 通过稳定结构暴露。

里程碑：

- 已完成：Anthropic/OpenAI/Gemini provider adapter 基础边界。
- 已完成：runtime diagnostics 统一结构。
- 已完成：provider usage persistence 和 provider error display 收敛。
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

状态：核心路径已完成，后续进入完整 budget engine 和 tool result budget。

### M3 Modes / RPC / TUI

目标：让 interactive、print、TUI、RPC 共享 runtime/session 核心。

状态：最小闭环已完成，后续补 ACP/SDK compatibility 和终端 smoke test。

### M4 Session / Recovery

目标：把 session 从 message-snapshot-first 收敛到 entry-tree-first，并完成可靠恢复。

状态：当前计划内核心架构和 reliability 收口已完成；后续 session 工作作为增强项推进。

### M5 Tool And Permission Governance

目标：完善工具编排、结果预算和权限规则。

状态：已有基础 metadata/governance/pending approval，后续进入更完整 rule/mode/budget。

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
