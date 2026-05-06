# Eva AI 架构文档

> 当前代码架构快照。当 runtime 边界、会话行为、工具加载或 mode 职责发生变化时更新此文档。

## 当前快照

当前版本：2026-05-06

Eva AI 是一个 TypeScript CLI 编码 Agent Harness。当前实现围绕可复用 runtime、负责会话切换的 `RuntimeHost`、轻量 mode 层、有状态 `Agent` 包装器，以及更底层的 agent loop 组织。

项目目前还没有实现计划中的 `RuntimeServices`、resource loader、RPC mode、session tree、MCP loader 和 skills system。部分配置字段已经为这些方向预留，但它们目前还不是运行时能力。

## 目录结构

```text
.
├── config/
│   ├── config.yaml             # 本地运行配置，通常是用户私有配置
│   ├── config-example.yaml     # 带注释的配置示例
│   ├── mcp-example.json        # 未来 MCP 配置示例
│   └── system_prompt.md        # 通过配置路径加载的默认 system prompt
├── docs/
│   ├── architecture.md         # 当前架构快照
│   ├── planning.md             # 项目目标、参考策略和阶段规划
│   ├── current.md              # 当前任务状态快照
│   └── changelog.md            # 重大架构更新记录
├── src/
│   ├── cli.ts                  # 进程入口：创建 host，选择运行 mode
│   ├── agent.ts                # legacy 兼容外壳
│   ├── config.ts               # YAML 配置加载与默认值
│   ├── logger.ts               # 占位文件
│   ├── retry.ts                # RetryConfig、withRetry、RetryExhaustedError
│   ├── schema.ts               # message、LLM、tool、event 共享类型
│   ├── core/
│   │   ├── runtime.ts          # createRuntime 工厂与 runtime diagnostics
│   │   ├── runtime-host.ts     # 当前 runtime 持有者；new/resume/switch session
│   │   ├── agent-session.ts    # Agent 事件与 SessionManager 之间的桥接层
│   │   ├── agent.ts            # 有状态 Agent 包装器，负责队列和 abort
│   │   ├── agent-loop.ts       # LLM/tool 循环与事件发射
│   │   └── session-manager.ts  # memory/jsonl 会话持久化
│   ├── modes/
│   │   ├── index.ts            # mode/UI 导出
│   │   ├── interactive-mode.ts # readline 循环与 slash commands
│   │   ├── print-mode.ts       # 单次任务执行模式
│   │   └── cli-ui.ts           # 终端渲染与工具确认提示
│   ├── llm/
│   │   ├── base.ts             # provider adapter 基类
│   │   ├── llm-client.ts       # provider 门面与 MiniMax API base 规范化
│   │   ├── anthropic-client.ts
│   │   ├── openai-client.ts
│   │   └── google-client.ts
│   ├── tools/
│   │   ├── index.ts            # ToolRegistry 与内置工具加载
│   │   ├── base.ts             # Tool、ToolDefinition、metadata、schema 转换
│   │   ├── bash.ts             # bash、bash_output、bash_kill
│   │   ├── read.ts             # read_file
│   │   ├── write.ts            # write_file
│   │   ├── edit.ts             # edit_file
│   │   ├── find.ts             # find_files
│   │   ├── grep.ts             # grep_files
│   │   ├── ls.ts               # list_files
│   │   ├── file-mutation-queue.ts
│   │   ├── path-utils.ts       # workspace 路径解析与边界检查
│   │   ├── truncate.ts
│   │   └── tool-definition-wrapper.ts
│   └── utils/
│       └── terminal.ts         # 颜色与终端显示宽度工具
├── package.json
└── AGENTS.md                   # AI 编码行为规则
```

## 分层结构

```text
cli.ts
  |
  v
RuntimeHost
  |
  v
createRuntime()
  |-- Config
  |-- LLMClient
  |-- loadConfiguredTools() -> ToolRegistry -> Tool[]
  |-- SessionManager
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
- `/clear`：将当前会话重置为 system prompt。
- `/history`：打印当前会话消息数量。
- `/log`：当前是忽略型占位命令。

## Runtime

`src/core/runtime.ts` 中的 `createRuntime()` 是当前组合根。

它负责：

- 通过 `Config.getDefaultConfigPath()` 查找配置；
- 通过 `Config.fromYaml()` 解析 YAML；
- 校验 provider 是否为 `anthropic`、`openai` 或 `google`；
- 创建 retry 配置，并接入 retry diagnostic；
- 通过 `Config.findConfigFile(config.agent.systemPromptPath)` 加载 system prompt；
- 通过 `loadConfiguredTools()` 加载内置工具；
- 创建 `SessionManager`，默认使用 `jsonl` 模式；
- 选择或创建 session；
- 创建带工具治理 hook 的 `AgentSession`。

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
