# Eva AI 架构文档

> 当前代码架构快照。当 runtime 边界、会话行为、工具加载或 mode 职责发生变化时更新此文档。

## 当前快照

当前版本：2026-05-14

Eva AI 是一个 TypeScript CLI 编码 Agent Harness。当前实现围绕 workspace 绑定的 `RuntimeServices`、可复用 runtime、负责会话切换的 `RuntimeHost`、轻量 mode 层、有状态 `Agent` 包装器，以及更底层的 agent loop 组织。

项目目前已经有 `RuntimeServices`、轻量 `ResourceLoader`、最小 `ContextBuilder`、最小 `ContextManager` diagnostics 聚合、TokenCounter provider/local 计数边界、Anthropic/Gemini countTokens 最小接入、可选 context window usage percent、auto compaction 最小执行闭环、prompt-too-long recovery 最小闭环、post-compact resource budget 最小闭环、manual `/compact`、provider usage 持久化、provider 错误展示收敛、`AgentMessage` / `LlmMessage` 最小类型边界、internal `AgentMessage` 最小闭环、`resource_context` / `compaction_summary` internal marker、durable `internal` session entry 最小边界、permission pending durable diagnostics、最小 Headless RPC mode，以及 RPC permission pending approval 最小闭环。当前双层消息模型仍是最小骨架：internal message 默认会被 `convertToLlm()` 过滤，运行期 marker 默认不写入当前 flat JSONL message log；需要跨 resume 恢复的 harness metadata 可写入独立 `internal` session entry。session tree、MCP loader、skills system、OpenAI provider countTokens 和完整 context budget engine 仍未实现。部分配置字段已经为这些方向预留，但它们目前还不是完整运行时能力。

## 分层结构

```text
cli.ts
  |
  v
RuntimeHost
  |
  v
createRuntime()
  |-- createRuntimeServices()
  |     |-- Config
  |     |-- LLMClient
  |     |-- ResourceLoader
  |     |-- ContextBuilder
  |     |-- ContextManager
  |     |-- TokenCounter
  |     |-- loadConfiguredTools() -> ToolRegistry -> Tool[]
  |     `-- SessionManager
  `-- AgentSession
        |
        v
      Agent
        |
        v
      runAgentLoop()
        |-- transformContext()
        |-- convertToLlm()
        |-- ContextBuilder.build()
        |-- LLMClient.generateStream()
        `-- Tool.execute()
```

### 入口与 Modes

- `src/cli.ts` 将 workspace 解析为 `process.cwd()`，创建 `RuntimeHost`，渲染启动 diagnostics，然后选择运行 mode。
- 如果命令行参数非空，则通过 `runPrintMode()` 执行单次任务后退出。
- 如果没有命令行参数，则通过 `runTuiMode()` 启动 TUI；`--no-tui` 回退到 `runInteractiveMode()` readline 交互循环。
- 如果传入 `--rpc`，则通过 `runRpcMode()` 启动 JSONL stdin/stdout RPC；RPC 模式会抑制 stdout 上的启动 diagnostics 和 retry 文本，避免污染协议输出。
- CLI 默认不启用固定 step 上限；只有显式配置 `max_steps` 的 print/headless 运行才会启用单次 run guard。
- mode 层只负责终端输入输出，不直接持有 runtime/session 的内部装配逻辑。
- `src/modes/cli-ui.ts` 负责渲染 `AgentSessionEvent`，以低噪音 `Working...` 展示 run 生命周期，并在 interactive mode 中提供工具确认提示。
- `src/modes/tui-mode.ts` 负责 TUI 编排，复用 `RuntimeHost`、`AgentSession`、`handleInteractiveCommand()` 和当前 tool permission decision。
- `src/modes/rpc-mode.ts` 负责 Headless RPC 编排，复用 `RuntimeHost` 和 `AgentSession`，不重新装配 runtime。

## TUI

`src/tui/` 是 Eva 自建的最小 terminal UI 框架，不引入第二套 agent/runtime 实现。

当前 TUI 框架包含：

- `TUI` 差量渲染器，支持 16ms render 节流、terminal resize、cursor marker 和 synchronized output；
- `ProcessTerminal` 与 `StdinBuffer`，负责 raw mode、bracketed paste 和 ESC/key sequence 分发；
- `Component` / `Container` 组件模型；
- 基础组件：Text、Markdown、Input、MultilineInput、Footer、Spinner、SelectList；
- 输入编辑辅助：kill ring、undo stack 和 key matching。

`tui-mode.ts` 采用 header、chat、status、input、footer 布局。普通消息通过 `AgentSession.addUserMessage()` 和 `AgentSession.run()` 驱动；slash commands 复用 readline interactive mode 的 `handleInteractiveCommand()`；tool confirmation 在 TUI 内替换 input 区域并返回 `allow` 或 `deny`。TUI 当前仍是最小框架，已有基础组件和 renderer 单元测试，但尚未做完整终端兼容性矩阵验证。

当前 interactive slash commands：

- `/exit`、`/quit`、`/q`：退出。
- `/new`：通过 `RuntimeHost.newSession()` 创建并切换到新会话。
- `/resume`、`/resume <id>`：通过 `RuntimeHost` 恢复 latest session 或切换到指定 session。
- `/fork [id]`：通过 `RuntimeHost.forkSession()` 从当前 active session 创建分支 session。
- `/clear`：将当前会话重置为 system prompt。
- `/compact [custom instructions]`：手动压缩当前 session context，生成摘要并保留最近消息。
- `/history`：打印当前 session id 和消息数量。
- `/stats`：打印当前 session、message count、token usage、context usage、compaction recommendation、provider、model 和 tool count。
- `/diagnostics`：打印当前 runtime 的完整 diagnostics。
- `/reload`：重新加载 runtime resources，并保持当前 session 不变。
- `/sessions`：列出当前 workspace 下的 sessions，并标记当前 active session 和 latest session。
- `/log`：当前是忽略型占位命令。

## Headless RPC

`src/modes/rpc-mode.ts` 是当前最小 Headless RPC mode。它使用 JSONL stdin/stdout 协议，每行输入一个 request，每行输出一个 envelope。

当前 envelope 类型：

- `response`：命令完成后的结构化结果；
- `event`：运行中的 `AgentSessionEvent`，包在 RPC envelope 内输出；
- `error`：结构化错误，包含稳定 `code` 和 `message`。

当前命令：

- `prompt`：追加 user message，调用 `AgentSession.run()`，运行中输出 event envelope，结束后输出 final response。
- `get_state`：返回 session id、message count、usage、compaction、step guard、provider/model 和 diagnostics 摘要。
- `abort`：中止当前 active prompt run；没有 active run 时返回 `aborted: false`。
- `new_session`：通过 `RuntimeHost.newSession()` 创建并切换新 session。
- `resume_session`：无 `session_id` 时恢复 latest session；有 `session_id` 时通过 `RuntimeHost.switchSession()` 切换。
- `approve_permission`：按 `permission_id` 批准当前 pending tool permission。
- `deny_permission`：按 `permission_id` 拒绝当前 pending tool permission。

RPC mode 允许 `prompt` 运行期间继续处理 `abort`、`get_state`、`approve_permission` 和 `deny_permission`，但同一时间只允许一个 active prompt run。其他会改变 session 的命令会在 active run 期间返回 `run_in_progress`。

RPC permission 默认仍是 fail-closed。如果 `prompt.params.permission_mode` 不是 `request`，工具治理需要确认时会沿用 runtime 的 fail-closed 行为，并写入 durable `permission_pending` internal entry。

如果 `prompt.params.permission_mode` 为 `request`，RPC mode 会为当前 active run 建立轻量 permission broker。工具治理需要确认时，broker 会输出 `permission_pending` event，包含 `permission_id`、tool call metadata、risk/source/category、只读信息、reason 和截断后的 `args_preview`；客户端随后通过 `approve_permission` 或 `deny_permission` 返回决定。pending permission 有 timeout，超时后默认 deny，避免 headless run 无限悬挂。`abort` active run 时会取消所有 pending permission。

## Runtime

`src/core/runtime-services.ts` 中的 `createRuntimeServices()` 创建 workspace 绑定服务；`src/core/runtime.ts` 中的 `createRuntime()` 使用这些 services 选择/创建当前 session，并创建 `AgentSession`。

`createRuntimeServices()` 负责：

- 通过 `Config.getDefaultConfigPath()` 查找配置；
- 通过 `Config.fromYaml()` 解析 YAML；
- 校验 provider 是否为 `anthropic`、`openai` 或 `google`；
- 创建 retry 配置，并接入 provider diagnostic；
- 通过 `createResourceLoader()` 加载 system prompt 和项目上下文资源；
- 通过 `createContextBuilder()` 创建 provider request view 构造器；
- 通过 `createContextManager()` 创建 context diagnostics 聚合器；
- 通过 `createTokenCounter()` 创建 provider/local token count 边界；
- 通过 `loadConfiguredTools()` 加载内置工具；
- 创建 `SessionManager`，默认使用 `jsonl` 模式；
- 返回统一 diagnostics。
- 支持 reload resources，重新加载 system prompt 和 project context，重建 `ContextBuilder`，并同步更新 `ContextManager`。

`createRuntime()` 负责：

- 选择或创建 session；
- 创建带工具治理 hook 的 `AgentSession`。
- 将 `RuntimeServices` 暴露为 `runtime.services`。
- 将 `ContextManager` 传给 `AgentSession`，用于 run 前 auto compaction 检查。
- 支持 `reloadResources()`，在不切换当前 session 的情况下同步新的 resources 和 context builder。

当前 runtime diagnostics 使用统一结构：

- `source`：`config`、`provider`、`tools`、`session`、`resource`、`context`。
- `level`：`info`、`warning`、`error`。
- `code`：稳定机器可读标识。
- `message`：面向 CLI 的简短说明。
- `details`：可选结构化上下文。

`createRuntimeServices()` 负责收集 config/provider/resource/context/session-manager diagnostics；`createRuntime()` 追加当前 session 选择/创建 diagnostics；`loadConfiguredTools()` 返回 tools diagnostics；mode 层通过 `renderRuntimeDiagnostics()` 只负责展示。

启动时 diagnostics 默认只展示 warning/error 和少量关键 info，避免普通 info 淹没终端。完整 diagnostics 可通过 interactive mode 的 `/diagnostics` 查看。

当前 resource diagnostics 会报告 system prompt 加载状态、`AGENTS.md` 项目上下文加载状态，以及 skills、MCP 已配置但尚未接入 loader 的情况。runtime context diagnostics 会报告 ContextBuilder 的基础装配状态，interactive context diagnostics 通过 `ContextManager` 聚合当前 session 的上下文状态。

`RuntimeHost` 包装当前 active runtime，并暴露：

- `newSession()`；
- `resumeLatestSession()`；
- `switchSession(sessionId)`；
- `forkSession(sessionId?)`；
- `reloadResources()`；
- `runtime`、`session`、`sessionId` getter。

当 mode 需要改变会话生命周期时，应该通过 `RuntimeHost` 这个边界完成，不应该直接重新装配 runtime 内部对象。

## Config

`src/config.ts` 会从第一个存在的位置加载 `config.yaml`：

1. `./eva_ai/config/config.yaml`
2. `~/.eva-ai/config/config.yaml`
3. package 内的 `config/config.yaml`

如果没有找到配置文件，启动时会抛出 `RuntimeConfigNotFoundError`，并打印手动配置说明。

当前重要字段：

- LLM：`api_key`、`api_base`、`model`、`provider`、`retry`。
- Agent：`max_steps`、`workspace_dir`、`system_prompt_path`、`project_context_max_chars`、`context_window_tokens`、`compaction.enabled`、`compaction.reserve_tokens`。
- Tools：`enable_file_tools`、`enable_bash`、`enabled_tools`、`disabled_tools`、`disabled_categories`、`require_confirmation`、`confirm_risk_levels`。

已解析但尚未接入 loader 的预留字段：

- `enable_skills`
- `skills_dir`
- `enable_mcp`
- `mcp_config_path`
- `tools.mcp`

## Resources

`src/core/resource-loader.ts` 当前是轻量资源加载器。

它负责：

- 加载 system prompt；
- 在 system prompt 缺失时返回默认 system prompt 和 warning diagnostic；
- 加载 workspace 根目录下的 `AGENTS.md` 作为 project context；
- 对 skills、MCP 已配置但尚未实现 loader 的情况返回 warning diagnostics。

当前 `AGENTS.md` 作为 `runtime.services.resourceLoader.projectContext` 暴露，并由 `ContextBuilder` 在每次 provider call 前临时注入 provider request view。它不会写回 `SessionManager` 的 durable session history。

`RuntimeServices.reloadResources()` 会重新创建 `ResourceLoader` 和 `ContextBuilder`，并更新 `ContextManager` 持有的 builder。当前 `AgentSession` 会继续保留原 session history，但下一次 provider request view 会使用 reload 后的 system prompt 和 project context。

## Context Builder

`src/core/context-builder.ts` 当前是无状态 provider request view 构造器。

它负责：

- 接收 system prompt、provider-facing `LlmMessage[]` 和 project context；
- 在第一条 system message 后插入 transient project context user message；
- 在没有 system message 时使用当前 system prompt 补一条 system message；
- 按 `project_context_max_chars` 控制 project context 注入字符数，默认 20000；
- 超预算时截断 project context，并保留截断说明和 closing tag；
- 如果预算小到无法容纳 project context framing，则跳过注入并记录原因；
- 返回用于本次 provider call 的 request view；
- 返回 context diagnostics metadata；
- 记录最近一次 context build 摘要；
- 使用本地 tokenizer 记录最近一次 provider request view 和 project context 的估算 token 数。
- 当 active messages 已包含 compaction summary 时，对 project context 使用更保守的 post-compact 有效预算，避免 compact 后又被资源上下文撑大。

当前注入格式：

```text
<project_context>

Contents of AGENTS.md:

...

</project_context>
```

`ContextBuilder` 只负责 project context 字符预算和 compact 后的保守资源预算，不负责完整 token budget、compaction、summary 或 skills/resource reinjection 策略。这些仍属于后续 ContextManager 演进范围。

## Token Counter

`src/core/token-counter.ts` 当前提供最小 token count 边界：

- 优先调用 provider countTokens；
- provider 不支持或失败时回退到本地 `gpt-tokenizer` estimate；
- 返回 `source`，区分 `provider` 和 `local`；
- 返回 `method`，当前为 `anthropic_count_tokens`、`google_count_tokens` 或 `gpt-tokenizer`。

当前 provider countTokens 已接入 Anthropic 和 Google Gemini adapter。OpenAI adapter 暂时返回 `null`，由 TokenCounter 回退到本地估算。

## Context Manager

`src/core/context-manager.ts` 当前是最小状态聚合器。它持有当前 `ContextBuilder`，并通过 `SessionManager` 汇总当前 session 的 context diagnostics。

它当前负责：

- 暴露当前 `ContextBuilder`；
- 在 resources reload 后接收新的 `ContextBuilder`；
- 汇总 active message count；
- 汇总 step guard 状态；
- 读取 session compaction metadata；
- 读取 session usage metadata；
- 读取 durable `permission_pending` internal entries；
- 暴露 active messages 的估算 token 数；
- 暴露 project context 资源、字符预算和最近一次 context build 摘要；
- 暴露最近一次 request/project context token estimate。
- 如果配置了 `context_window_tokens`，基于 TokenCounter 结果计算 context usage percent；未配置时显示 unknown；
- 基于 `compaction` 配置输出 compaction recommendation diagnostics。

它当前不负责 OpenAI provider countTokens、summary 生成、skills/resource reinjection 策略或完整 token budget。

`AgentSession.run()` 会在进入 agent loop 前使用 `ContextManager` 基于 active messages 计算 compaction recommendation。如果 `compaction.enabled=true` 且 reason 为 `reserve_reached`，会先调用现有 `compact()`；compact 失败时不会修改当前 session，并继续本次 run。

如果 LLM call 返回 context/prompt overflow 类错误，`AgentSession.run()` 会尝试执行一次现有 `compact()` 并重试当前 run。恢复成功时抑制第一次 overflow error 事件；恢复失败时保留原错误结果，并且不修改 session messages。

interactive mode 当前通过 `ContextManager` 展示 context 状态：

- `/stats`：显示 step guard、compaction 简要状态、token usage、token estimate、context usage percent、count source、compaction recommendation、project context 数量和最近一次 context build 状态；
- `/diagnostics`：显示 active messages、step guard、compaction metadata、token usage、token estimate、context usage percent、count source、compaction recommendation、project context 资源名称、路径、字符数和最近一次 build 状态。

## LLM 层

`LLMClient` 是 provider 门面。它会创建其中一个 adapter：

- `AnthropicClient`
- `OpenAIClient`
- `GoogleClient`

对于 MiniMax 域名，`LLMClient` 会规范化 `api_base`，自动追加 provider 对应后缀：

- Anthropic provider -> `/anthropic`
- OpenAI 或 Google 风格 provider path -> `/v1`

所有 adapter 都暴露：

- `generate(messages: LlmMessage[], tools)`
- `generateStream(messages: LlmMessage[], tools)`
- `countTokens(messages: LlmMessage[], tools)`

基类中的 streaming 实现可以将非流式响应适配成 `thinking_delta`、`content_delta`、`tool_call`、`usage` 和 `done` 事件。具体 provider adapter 可以覆盖该行为。

当前 `AnthropicClient.countTokens()` 和 `GoogleClient.countTokens()` 调用 provider API。OpenAI adapter 继承基类默认 `null` 返回，由 TokenCounter fallback 处理。

## Agent Loop

`src/core/agent-loop.ts` 中的 `runAgentLoop()` 是底层执行循环。

主要职责：

- 发射 `agent_start`、`turn_start`、`message_start`、`assistant_message`、`tool_result`、`agent_end` 等生命周期事件；
- 持有本次 run 的 `AgentMessage[]` working history；
- 在每次 provider call 前执行 `transformContext(AgentMessage[])`；
- 执行 `convertToLlm(AgentMessage[])`，得到 provider-facing `LlmMessage[]`；
- 通过 `ContextBuilder` 从 `LlmMessage[]` 构造本次 provider request view；
- 调用 `llmClient.generateStream(requestMessages, tools)`；
- 将 assistant message 追加到工作消息列表；
- 执行 LLM 返回的 tool calls；
- 追加 tool result messages；
- 只要模型继续返回 tool calls，就继续循环；
- 通过 callback 接收 steering/follow-up 队列消息；
- 在 abort、显式 max steps guard 触发或 LLM 调用失败时停止。

`maxSteps` 在 agent-loop 层是可选 guard。`number` 表示启用单次 run 上限，`null` 或 `undefined` 表示不限制。当前配置未显式设置 `max_steps` 时默认无上限；interactive mode 会覆盖为无上限，print/headless 只有在显式配置 `max_steps` 时才启用 guard。

LLM 调用失败时，agent-loop 会把 provider 原始错误格式化成用户可读的 `error.message`，同时把原始错误细节保留在 `error.error`。当前最小 classification 覆盖 context overflow、rate limit、provider unavailable、timeout 和常见 transient status code。CLI 只展示友好文本；原始错误供日志、测试或未来 RPC 消费。

工具执行策略具备基础并发感知：

- 如果 `toolExecution` 是 `sequential`，所有 tool call 串行执行；
- 如果 `toolExecution` 是 `parallel`，tool calls 通过 `Promise.all` 并行执行；
- 如果未显式设置，只要任意 tool 的 `metadata.isConcurrencySafe === false`，整个 batch 就会串行执行。

当前 loop 使用原始 tool-call 顺序构造 `Promise.all`，因此并行执行时仍会保持结果顺序。

## Agent 与 Session

`src/core/agent.ts` 中的 `Agent` 是 `runAgentLoop()` 的有状态包装器。

它持有：

- 当前 messages；
- 可用 tools；
- streaming 状态；
- pending tool-call IDs；
- active run 的 abort controller；
- steering 和 follow-up 队列。

当前 `Agent` 与 agent-loop 已引入 `AgentMessage` / `LlmMessage` 最小边界。默认 `transformContext()` 是 identity，默认 `convertToLlm()` 会保留 provider 可理解的 system/user/assistant/tool 消息，并过滤 `role: 'internal'` 的 internal agent message。每次 `ContextBuilder` 生成 provider request view 后，agent-loop 会追加一个 `kind: 'resource_context'` 的 internal marker，记录资源注入、provider request message count 和 token estimate。`AgentSession.compact()` 成功后会在 Agent working history 中追加 `kind: 'compaction_summary'` internal marker，记录 summary 内容和 compaction metadata。运行期 internal marker 默认保持 transient；需要跨 resume 恢复的 harness metadata 通过独立 durable `internal` session entry 持久化。

`src/core/agent-session.ts` 中的 `AgentSession` 负责在 `Agent`、持久化和 UI-facing events 之间做桥接。

它持有：

- 当前 `sessionId`；
- system prompt；
- `addUserMessage()`；
- `clear()`；
- `compact(customInstructions?)`；
- `steer()` 和 `followUp()`；
- `run({ signal, onEvent })`。

持久化行为：

- user messages 在 run 开始前追加；
- assistant messages 通过 `assistant_message` 事件持久化；
- tool result messages 通过 `tool_result` 事件持久化；
- assistant response usage 通过 `message_end.response.usage` 持久化为独立 `usage` entry，不写入 durable messages；
- manual compact 会先调用 LLM 生成摘要，成功后追加 `compaction` entry，并将当前活动上下文重建为 system prompt、summary 和最近保留消息；
- compact 成功后会向 Agent working history 追加 transient `compaction_summary` internal marker，provider request 和 flat JSONL message log 都不会包含该 marker；
- compact LLM 调用返回的 usage 会以 `compaction` source 写入 `usage` entry；
- compaction 失败时不会写入 `compaction` entry，也不会修改当前 session messages；
- `compaction` getter 暴露最近一次 compaction metadata，用于 `/stats` 和 `/diagnostics`；
- `usage` getter 暴露累计 usage、最近一次 usage、来源和时间；没有 provider usage 时返回 count 为 0 的空状态；
- `maxSteps` getter 暴露当前 session 的有效 step guard，`null` / `undefined` 表示无固定上限；
- UI-facing events 会转发给 mode renderer，包括 `agent_start`、`agent_end`、message streaming、tool result、usage 和 error。`AgentSession` 在 prompt-too-long recovery 成功时会抑制第一次隐藏 overflow attempt 的 error 和 agent end，只暴露 retry 后的最终 lifecycle。

## Sessions

`SessionManager` 支持两种模式：

- `memory`：进程内 `Map<sessionId, Message[]>`；
- `jsonl`：写入 `~/.eva-ai/sessions/<encoded-workspace>/` 下的 append-only 文件。

JSONL 模式下：

- 每个 session 对应 `<sessionId>.jsonl`；
- 创建或 reset session 时写入 `session_start`；
- `session_start` 支持向后兼容的 lineage metadata：`parentSessionId`、`rootSessionId`、`forkedFromMessageIndex`；
- 每条 message 都写成一个 `message` entry；
- manual compact 会追加 `compaction` entry，包含 summary、`firstKeptMessageIndex`、压缩前后 message 数和可选 custom instructions；
- provider 返回的 token usage 会追加 `usage` entry，包含 source、timestamp 和 prompt/completion/total token 数；
- durable harness metadata 可以追加 `internal` entry，包含 kind、timestamp、可选 content 和 metadata；这些 entries 可 reload/resume，但不会进入 `getMessages()` 或 provider request view；
- `manifest.json` 记录 `latestSessionId`。
- `listSessions()` 可列出当前 workspace 下的 session id、message count、updatedAt、latest 标记和 lineage metadata。
- `getCompactionInfo()` 返回当前 session 最近一次 compaction metadata；如果尚未 compact，则返回 `compacted: false`。
- `getUsageInfo()` 返回当前 session 累计 usage 和最近一次 usage；usage entries 不影响 message count，也不会进入 provider request view。
- `getInternalEntries()` 返回当前 session 的 durable internal entries，可按 kind 过滤；internal entries 不影响 message count，也不会进入 provider request view。
- `getLineageInfo()` 返回当前 session 的 root/parent/fork point 信息；旧 JSONL session 会被视为 root session。
- `forkSession()` 会复制当前 active context messages 到新 session，并写入 lineage metadata；fork 后父子 session 的后续消息互不影响。

`src/core/session-context-rebuilder.ts` 是当前最小 session context rebuild 边界。它从 `SessionManager` 读取当前 session snapshot，返回 active messages、lineage、branch path、compaction、usage 和 internal entries。当前策略标记为 `flat_snapshot`，用于保持现有 flat JSONL 兼容；后续 path-aware rebuild 可以替换该边界，而不让 mode 或 agent loop 直接拼 session entries。

当前 session model 仍主要是扁平 JSONL 文件，但已经有最小 lineage schema、fork session 能力和 `SessionContextRebuilder` snapshot 边界。它支持 flat JSONL 兼容的 compaction entry、usage entry、internal entry、lineage metadata、fork session 和基于最新 compaction 的 context rebuild；还不支持完整 parent/child entry graph、clone、import/export，也不支持从 session tree 做确定性 path-aware context rebuild。

## Tools

`loadConfiguredTools()` 当前只加载内置工具。

内置工具：

- `read_file`
- `write_file`
- `edit_file`
- `list_files`
- `find_files`
- `grep_files`
- `bash`
- `bash_output`
- `bash_kill`

工具 metadata 通过 `ToolRegistry` 附加：

- category：`read`、`write` 或 `bash`；
- risk level：`low` 或 `high`；
- source：`builtin`；
- 是否 read-only；
- 是否 concurrency-safe；
- 可选的 confirmation requirement。

当前工具治理支持：

- `enabled_tools` allowlist；
- `disabled_tools`；
- `disabled_categories`；
- 对显式要求确认的工具，或 risk level 命中 `confirm_risk_levels` 的工具，执行前请求确认。
- tool permission decision 已统一为 `allow`、`deny`、`ask`，并保留 boolean confirmation handler 兼容。

如果某个 tool 需要确认但当前没有 confirmation handler，runtime 会把它视为 pending permission 并 fail-closed，返回被阻止的 tool result。在 interactive mode 中，`createToolConfirmationPrompt()` 会提供确认 handler，并把用户输入转换为 `allow` 或 `deny`。print/headless 当前没有交互确认通道，因此遇到 `ask` 时会阻止 tool call。RPC 默认同样 fail-closed；只有当 `prompt.params.permission_mode=request` 时，RPC mode 才会提供 permission broker，把审批转换为 `permission_pending` event 和 `approve_permission` / `deny_permission` 命令。

当 tool governance 返回 permission pending 时，如果当前 runtime 已绑定 session，`SessionManager` 会追加 `kind: 'permission_pending'` 的 durable `internal` entry，记录 reason、tool name、tool call id、risk level、source、category 和 read-only metadata。该 entry 可通过 reload/resume 恢复，并由 `ContextManager` 汇总到 diagnostics；它不会进入 `getMessages()` 或 provider request view。

## 核心数据流

```text
User input
  |
  v
mode
  |
  v
AgentSession.addUserMessage()
  |
  v
SessionManager.appendMessage(user)
  |
  v
AgentSession.run()
  |
  v
Agent.continue()
  |
  v
runAgentLoop()
  |
  |-- LLMClient.generateStream()
  |     `-- provider adapter
  |
  |-- emit streaming/render events
  |
  |-- execute tool calls
  |     |-- beforeToolCall governance
  |     |-- Tool.execute(args, context)
  |     `-- afterToolCall hook
  |
  |-- append assistant/tool messages
  |-- append usage entry when provider returns usage
  |
  v
AgentSession 持久化已发射的 assistant/tool messages 和 usage metadata
```

## 当前未接入范围

以下能力可能出现在配置字段或规划文档中，但当前 runtime 尚未实现：

- MCP loader
- skills loader
- 完整 session tree / path-aware rebuild
- clone / import / export
- 完整 permission pipeline
