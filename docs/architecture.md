# Eva AI 架构文档

> 当前代码架构快照。当 runtime 边界、会话行为、工具加载或 mode 职责发生变化时更新此文档。

## 当前快照

当前版本：2026-05-09

Eva AI 是一个 TypeScript CLI 编码 Agent Harness。当前实现围绕 workspace 绑定的 `RuntimeServices`、可复用 runtime、负责会话切换的 `RuntimeHost`、轻量 mode 层、有状态 `Agent` 包装器，以及更底层的 agent loop 组织。

项目目前已经有 `RuntimeServices` 和轻量 `ResourceLoader`。完整 RPC mode、session tree、MCP loader 和 skills system 仍未实现。部分配置字段已经为这些方向预留，但它们目前还不是完整运行时能力。

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
  |     |-- loadConfiguredTools() -> ToolRegistry -> Tool[]
  |     `-- SessionManager
  `-- AgentSession
        |
        v
      Agent
        |
        v
      runAgentLoop()
        |-- LLMClient.generateStream()
        `-- Tool.execute()
```

### 入口与 Modes

- `src/cli.ts` 将 workspace 解析为 `process.cwd()`，创建 `RuntimeHost`，渲染启动 diagnostics，然后选择运行 mode。
- 如果命令行参数非空，则通过 `runPrintMode()` 执行单次任务后退出。
- 如果没有命令行参数，则通过 `runInteractiveMode()` 启动 readline 交互循环。
- mode 层只负责终端输入输出，不直接持有 runtime/session 的内部装配逻辑。
- `src/modes/cli-ui.ts` 负责渲染 `AgentSessionEvent`，并在 interactive mode 中提供工具确认提示。

当前 interactive slash commands：

- `/exit`、`/quit`、`/q`：退出。
- `/new`：通过 `RuntimeHost.newSession()` 创建并切换到新会话。
- `/resume`、`/resume <id>`：通过 `RuntimeHost` 恢复 latest session 或切换到指定 session。
- `/clear`：将当前会话重置为 system prompt。
- `/history`：打印当前 session id 和消息数量。
- `/stats`：打印当前 session、message count、token usage、provider、model 和 tool count。
- `/diagnostics`：打印当前 runtime 的完整 diagnostics。
- `/sessions`：列出当前 workspace 下的 sessions，并标记当前 active session 和 latest session。
- `/log`：当前是忽略型占位命令。

## Runtime

`src/core/runtime-services.ts` 中的 `createRuntimeServices()` 创建 workspace 绑定服务；`src/core/runtime.ts` 中的 `createRuntime()` 使用这些 services 选择/创建当前 session，并创建 `AgentSession`。

`createRuntimeServices()` 负责：

- 通过 `Config.getDefaultConfigPath()` 查找配置；
- 通过 `Config.fromYaml()` 解析 YAML；
- 校验 provider 是否为 `anthropic`、`openai` 或 `google`；
- 创建 retry 配置，并接入 provider diagnostic；
- 通过 `createResourceLoader()` 加载 system prompt 和项目上下文资源；
- 通过 `loadConfiguredTools()` 加载内置工具；
- 创建 `SessionManager`，默认使用 `jsonl` 模式；
- 返回统一 diagnostics。

`createRuntime()` 负责：

- 选择或创建 session；
- 创建带工具治理 hook 的 `AgentSession`。
- 将 `RuntimeServices` 暴露为 `runtime.services`。

当前 runtime diagnostics 使用统一结构：

- `source`：`config`、`provider`、`tools`、`session`、`resource`。
- `level`：`info`、`warning`、`error`。
- `code`：稳定机器可读标识。
- `message`：面向 CLI 的简短说明。
- `details`：可选结构化上下文。

`createRuntimeServices()` 负责收集 config/provider/resource/session-manager diagnostics；`createRuntime()` 追加当前 session 选择/创建 diagnostics；`loadConfiguredTools()` 返回 tools diagnostics；mode 层通过 `renderRuntimeDiagnostics()` 只负责展示。

启动时 diagnostics 默认只展示 warning/error 和少量关键 info，避免普通 info 淹没终端。完整 diagnostics 可通过 interactive mode 的 `/diagnostics` 查看。

当前 resource diagnostics 会报告 system prompt 加载状态、`AGENTS.md` 项目上下文加载状态，以及 note、skills、MCP 已配置但尚未接入 loader 的情况。

`RuntimeHost` 包装当前 active runtime，并暴露：

- `newSession()`；
- `resumeLatestSession()`；
- `switchSession(sessionId)`；
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
- Agent：`max_steps`、`workspace_dir`、`system_prompt_path`。
- Tools：`enable_file_tools`、`enable_bash`、`enabled_tools`、`disabled_tools`、`disabled_categories`、`require_confirmation`、`confirm_risk_levels`。

已解析但尚未接入 loader 的预留字段：

- `enable_note`
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
- 对 note、skills、MCP 已配置但尚未实现 loader 的情况返回 warning diagnostics。

当前 `AGENTS.md` 只作为 `runtime.services.resourceLoader.projectContext` 暴露，还没有注入模型上下文。后续 project context 注入应通过 Resource Loader 和 context budget 统一处理。

## LLM 层

`LLMClient` 是 provider 门面。它会创建其中一个 adapter：

- `AnthropicClient`
- `OpenAIClient`
- `GoogleClient`

对于 MiniMax 域名，`LLMClient` 会规范化 `api_base`，自动追加 provider 对应后缀：

- Anthropic provider -> `/anthropic`
- OpenAI 或 Google 风格 provider path -> `/v1`

所有 adapter 都暴露：

- `generate(messages, tools)`
- `generateStream(messages, tools)`

基类中的 streaming 实现可以将非流式响应适配成 `thinking_delta`、`content_delta`、`tool_call`、`usage` 和 `done` 事件。具体 provider adapter 可以覆盖该行为。

## Agent Loop

`src/core/agent-loop.ts` 中的 `runAgentLoop()` 是底层执行循环。

主要职责：

- 发射 `agent_start`、`turn_start`、`message_start`、`assistant_message`、`tool_result`、`agent_end` 等生命周期事件；
- 调用 `llmClient.generateStream(messages, tools)`；
- 将 assistant message 追加到工作消息列表；
- 执行 LLM 返回的 tool calls；
- 追加 tool result messages；
- 只要模型继续返回 tool calls，就继续循环；
- 通过 callback 接收 steering/follow-up 队列消息；
- 在 abort、达到 max steps 或 LLM 调用失败时停止。

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

`src/core/agent-session.ts` 中的 `AgentSession` 负责在 `Agent`、持久化和 UI-facing events 之间做桥接。

它持有：

- 当前 `sessionId`；
- system prompt；
- `addUserMessage()`；
- `clear()`；
- `steer()` 和 `followUp()`；
- `run({ signal, onEvent })`。

持久化行为：

- user messages 在 run 开始前追加；
- assistant messages 通过 `assistant_message` 事件持久化；
- tool result messages 通过 `tool_result` 事件持久化；
- legacy UI events 会转发给 mode renderer。

## Sessions

`SessionManager` 支持两种模式：

- `memory`：进程内 `Map<sessionId, Message[]>`；
- `jsonl`：写入 `~/.eva-ai/sessions/<encoded-workspace>/` 下的 append-only 文件。

JSONL 模式下：

- 每个 session 对应 `<sessionId>.jsonl`；
- 创建或 reset session 时写入 `session_start`；
- 每条 message 都写成一个 `message` entry；
- `manifest.json` 记录 `latestSessionId`。
- `listSessions()` 可列出当前 workspace 下的 session id、message count、updatedAt 和 latest 标记。

当前 session model 是扁平结构。还不支持 parent/child entries、fork、compaction entries、import/export，也不支持从 session tree 做确定性 context rebuild。

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

如果某个 tool 需要确认但当前没有 confirmation handler，runtime 会阻止该 tool call。在 interactive mode 中，`createToolConfirmationPrompt()` 会提供确认 handler。

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
  |
  v
AgentSession 持久化已发射的 assistant/tool messages
```

## 当前未接入范围

以下能力可能出现在配置字段或规划文档中，但当前 runtime 尚未实现：

- `RuntimeServices`
- project context resource loader
- MCP loader
- skills loader
- RPC mode
- session tree / fork / compact
- 完整 permission pipeline
