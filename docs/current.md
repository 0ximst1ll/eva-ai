# Eva AI Current

## 当前状态（2026-05-14）

Eva AI 当前已完成 M0 基线稳定、M2 RuntimeServices / ResourceLoader 主要骨架、manual `/compact` 最小闭环、Context diagnostics 最小展示、assistant usage 持久化最小闭环、最小 `ContextManager` diagnostics 聚合、TokenCounter provider/local 计数边界、Anthropic/Gemini countTokens 最小接入、可选 context usage percent、auto compaction 最小执行闭环、prompt-too-long recovery 最小闭环、post-compact resource budget 最小闭环、Provider / Observability 最小闭环、M2.x `AgentMessage` / `LlmMessage` 最小类型边界、`ContextBuilder` provider request view 边界收敛、internal `AgentMessage` 最小闭环、`resource_context` / `compaction_summary` internal marker，以及规划文档中的长期架构域视图整理。

当前刚完成 M2.x Agent Core Alignment 的 resource context marker 与 compaction summary marker 最小闭环，证明 internal `AgentMessage` 可以承载真实 harness 状态，同时保持 provider request 和 flat JSONL message log 不被 internal message 污染。

## 已完成

- interactive 和 print modes 已共享 `RuntimeHost` 与同一套 runtime/session 路径。
- 已实现 `RuntimeHost` 的 `newSession()`、`resumeLatestSession()`、`switchSession()` 和 `reloadResources()`。
- 当前已有 JSONL session persistence、builtin file/search/bash tools、tool registry、高风险工具 confirmation hook、最小 permission pending 语义、abort 和 queue 基础能力。
- 已建立 `test` 和 `typecheck` script，并覆盖 retry、SessionManager、agent-loop、RuntimeHost、abort、queue 等核心路径。
- interactive mode 已实现 `/new`、`/resume`、`/resume <id>`、`/clear`、`/history`、`/stats`、`/diagnostics`、`/reload` 和 `/sessions`。
- runtime diagnostics 已统一为 `source`、`level`、`code`、`message`、`details` 结构。
- `RuntimeServices` 已承载 workspace 绑定的 config、provider、tools、session manager、resource loader、context builder 和 diagnostics。
- `ResourceLoader` 已支持 system prompt 与 `AGENTS.md` project context 加载，并对尚未接入的 skills、MCP 返回 diagnostics。
- `ContextBuilder` 已在每次 provider call 前构造 provider request view。
- `AGENTS.md` 已作为 transient project context 注入模型请求，不写回 session history。
- `ContextBuilder` 已支持 `project_context_max_chars` 字符预算、截断、跳过原因和最近一次 build 摘要。
- `ContextBuilder` 已支持 compact 后的保守 project context 有效预算，避免 compact 后的 request view 重新被资源上下文撑大。
- `ContextBuilder` 已记录最近一次 provider request view 和 project context 的本地 token estimate。
- `TokenCounter` 已支持 provider/local 计数边界，Anthropic 和 Gemini provider 优先使用 countTokens API，失败或不支持时回退本地估算。
- `ContextManager` 已作为最小状态聚合器，汇总 `ContextBuilder.latestBuild`、active messages、step guard、compaction、usage、project context metadata、token count source、可选 context usage percent 和 compaction recommendation。
- compaction recommendation 已使用 `compaction.enabled` / `compaction.reserve_tokens` 嵌套配置。
- `AgentSession.run()` 已支持基于 `reserve_reached` recommendation 的 auto compaction 最小执行闭环。
- `AgentSession.run()` 已支持 prompt-too-long recovery 最小闭环：识别 context/prompt overflow 错误，执行一次 compact-and-retry。
- interactive mode 的 `/stats` 和 `/diagnostics` 已通过 `ContextManager` 展示 project context 数量、来源、token estimate、context usage percent、count source、compaction recommendation 和最近一次 build 状态。
- interactive mode 已实现 `/reload`，可重新加载 system prompt 和 project context，并保持当前 session 不变。
- interactive mode 已实现 `/compact [custom instructions]`，用于手动压缩当前 session context。
- `AgentSession.compact()` 已支持调用当前 LLM 生成摘要，并在成功后重建当前活动上下文。
- `SessionManager` 已支持 flat JSONL 兼容的 `compaction` entry。
- compact 后当前活动上下文会变为 system prompt、summary 和最近保留消息；原始历史 message entries 仍保留在 JSONL log 中。
- compaction 失败不会修改当前 session messages。
- agent-loop 已支持可选 `maxSteps` guard，`null` / `undefined` 表示不限制。
- 配置未显式设置 `max_steps` 时默认无上限。
- CLI 在 interactive mode 下创建 runtime 时会传入 `maxSteps: null`，覆盖任何显式配置。
- print/headless mode 只有显式配置 `max_steps` 时才启用单次 run guard。
- `SessionManager` 已暴露最近一次 compaction metadata。
- `AgentSession` 已暴露有效 step guard 和 compaction 状态。
- `/stats` 已展示 step guard 与 compaction 简要状态。
- `/diagnostics` 已展示 active messages、step guard、compaction metadata 和 ContextBuilder 状态。
- `SessionManager` 已支持独立 `usage` entry，并能在 reload session 后恢复累计 usage 与最近一次 usage。
- `AgentSession` 已暴露 usage 状态，并会持久化 assistant response usage 和 compact LLM usage。
- `/stats` 与 `/diagnostics` 已展示 token usage、最近一次 usage 来源和时间。
- note tool 相关配置字段、resource warning 和 tool category 已移除。
- tool permission decision 已支持 `allow` / `deny` / `ask`，并兼容旧 boolean confirmation handler。
- print/headless 当前没有确认通道时会将需要确认的 tool call 视为 pending permission 并 fail-closed。
- provider transient error 已有最小 classification 和用户可读 message formatting，原始错误细节保留在 `error` event 的 `error` 字段。
- `AgentSessionEvent` 已透传 `agent_start` / `agent_end`，CLI 以单行 `Working...` 展示 run 生命周期，不展示过细 provider lifecycle。
- `AgentMessage` / `LlmMessage` 最小类型边界已引入，agent-loop 会在 provider call 前执行 `transformContext()` 和 `convertToLlm()`。
- `ContextBuilder` 已收敛为 provider request view builder，`ContextManager` 优先使用 `latestProviderRequestView` 做 context usage diagnostics。
- internal `AgentMessage` 最小类型已可存在于 agent-loop working history，默认不会发送给 provider，也不会写入当前 flat JSONL message log。
- 每次 `ContextBuilder` 构造 provider request view 后，agent-loop 会追加 `resource_context` internal marker，用于记录注入资源、provider request message count 和 token estimate。
- `AgentSession.compact()` 成功后会向 Agent working history 追加 `compaction_summary` internal marker，用于记录压缩摘要和 compaction metadata。

## 进行中

- 暂无正在实施的代码任务。

## 下一步

- 继续 M2.x Agent Core Alignment：评估是否迁入 permission pending internal marker，或先收敛 session entry schema 与 durable internal message 策略。

## 后续重点计划

- 当前 manual `/compact`、auto compaction、prompt-too-long recovery 和 post-compact resource budget 都只做最小闭环。
- M2.x 应先于 RPC/TUI/MCP/Extensions 完成核心消息边界对齐，避免后续接口绑定当前临时的单层 `Message[]`。
- ContextManager 后续再承接完整 token budget 和 skills/resource reinjection 策略。
- 当前 `max_steps` 后续应进一步迁移为 print/headless/RPC 场景下的命名更明确的可选 runaway guard。
- 长任务能力应通过 token accounting、context rebuild、compaction entry 和手动 `/compact` 逐步建立。
- 完整 session tree、fork、clone 和 path-aware context rebuild 放入后续 session model 阶段。
- 完整 permission pipeline 后续继续补 permission modes、rules、diagnostics 和 RPC/ACP pending event。

## 已知问题

- `logger.ts` 仍是占位文件。
- `ResourceLoader` 仍是最小骨架，尚未支持自动监听或更细粒度 reload。
- 当前 internal `AgentMessage` 仍不持久化到 flat JSONL message log；完整持久化需要后续 session entry schema。
- `ContextManager` 仍未支持完整 token budget 或 OpenAI provider countTokens。
- manual `/compact` 仍是最小版：没有工具结果 micro-compaction。
- skills、MCP 相关配置字段已解析，但还没有接入 tool/resource loader。
- 当前 `max_steps` 字段名仍偏模糊，后续应迁移为 `max_steps_per_run` 或同类命名。
- RPC mode 尚不存在。
- session history 仍是 flat JSONL，尚未升级为 session tree。
- tool result budget、超大输出持久化、完整 permission pipeline 尚未实现。
