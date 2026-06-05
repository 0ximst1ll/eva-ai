# Eva AI Architecture

本文记录 Eva AI 当前代码架构事实。它不记录短期任务、细碎能力清单或未来计划；这些内容放在 `docs/current.md` 和 `docs/planning.md`。

维护规则：

- 只有核心分层、架构域边界或长期职责发生变化时才更新本文。
- 本文描述“现在代码如何组织”，不把规划中的能力写成已实现能力。
- 具体命令、诊断 code、测试用例、单个 entry 类型、短期 backlog 不放在本文。

## Snapshot

当前日期：2026-05-27

Eva AI 是一个 TypeScript CLI 编码 Agent Harness。当前核心架构围绕以下边界组织：

- `RuntimeHost`：持有当前 active runtime，负责 session lifecycle 和 reload。
- `RuntimeServices`：创建 workspace 绑定服务，包括 config、provider、resources、tools、sessions、context 和 diagnostics。
- `AgentSession`：连接 Agent、session persistence、tool governance 和 UI-facing events。
- `Agent` / `agent-loop`：执行 LLM turn、tool execution、event emission 和 abort handling。
- `SessionManager`：session lifecycle facade，内部委托 storage、model、entry store 和 parser。
- modes：interactive、print、TUI、RPC 共享同一 runtime/session 核心，只负责 I/O。

## High-Level Flow

```text
cli.ts
  |
  v
RuntimeHost
  |
  v
createRuntime()
  |-- RuntimeServices
  |     |-- Config
  |     |-- LLMClient
  |     |-- ResourceLoader
  |     |-- ContextBuilder
  |     |-- ContextManager
  |     |-- TokenCounter
  |     |-- ToolRegistry / Tools
  |     `-- SessionManager
  `-- AgentSession
        |
        v
      Agent
        |
        v
      agent-loop
        |-- transformContext()
        |-- convertToLlm()
        |-- ContextBuilder.build()
        |-- LLMClient.generateStream()
        `-- Tool.execute()
```

## Agent Runtime

`src/core/runtime-services.ts` 负责 workspace 绑定服务装配。它加载配置、provider、resources、context builder/manager、token counter、tools 和 session manager，并收集启动 diagnostics。

`src/core/runtime.ts` 负责选择或创建 session，并创建 `AgentSession`。它不直接做 terminal I/O。

`src/core/runtime-host.ts` 包装当前 runtime，提供 new/resume/switch/fork/clone/import/export/reload 等 session lifecycle 边界。mode 层需要改变 session 时通过 `RuntimeHost` 完成。

`src/core/agent-session.ts` 是 runtime 与 agent 之间的会话桥接层。它负责把用户消息写入 session、运行 agent、持久化 assistant/tool/usage/compaction/internal state，并把 agent events 暴露给 UI/RPC。

`src/core/agent.ts` 和 `src/core/agent-loop.ts` 负责实际执行。核心层只发事件，不直接打印终端输出。

## Message Boundary

Eva AI 已引入最小 `AgentMessage` / `LlmMessage` 双层消息边界：

- `AgentMessage` 表示 Eva 内部、session 和 harness 消息层。
- `LlmMessage` 表示 provider API 请求消息层。
- `transformContext()` 在内部消息层做上下文变换。
- `convertToLlm()` 是发送 provider 前的唯一转换边界。

内部 marker 默认不会发送给 provider。需要跨 resume 恢复的 harness metadata 使用 durable `internal` session entry。

## Session / Recovery

Session 当前采用 entry-tree-first 模型。append-only `SessionEntry` tree 是主要事实源，当前 active context 从 active leaf path 派生。

主要模块：

- `src/core/session-manager.ts`：public lifecycle facade，负责 create/load/latest/list/fork/clone/branch/import/export/reset 编排。
- `src/core/session-store.ts`：`SessionStorage` backend 边界，当前有 JSONL 和 memory backend。
- `src/core/session-model.ts`：单 session 语义状态容器，负责 metadata、lineage、format、entry store 和 active state cache。
- `src/core/session-entry-store.ts`：单 session entry tree、path traversal、active entry id 和 tree view。
- `src/core/session-log-parser.ts`：JSONL parser、session id 读取和 import rewrite。
- `src/core/session-context-rebuilder.ts`：从 active entry path 派生 session/context view。

当前事实：

- 新写入和可加载的 durable path entries 必须带有 `entryId` / `parentEntryId`。
- load/import/fork/clone/branch 都基于 active entry path，不再把旧 flat JSONL 当作有效 active context。
- active leaf 切换和 branch summary 已作为 durable session log 语义的一部分。
- session diagnostics 覆盖 parse/load/import/list/latest 路径。
- latest manifest 指向不可加载 session 时会诊断并 fallback 到最近可加载 session；没有 fallback 时 runtime 创建新 session。

当前未实现：

- 完整 `SessionRepo` 分层。
- 跨 session parent/child entry graph。
- sidecar metadata / artifact store。
- 自动 schema migration framework。
- branch summarization pipeline。

## Context Management

`src/core/context-builder.ts` 是无状态 provider request view builder。它负责把 system prompt、provider-facing messages、project context 和 skills invocation 组合为本次 provider request。

`src/core/context-manager.ts` 聚合 context diagnostics，包括 active messages、token estimate、context usage、compaction recommendation、skills/resource metadata 和 permission pending 状态。

`src/core/token-counter.ts` 提供 provider/local token count 边界。Anthropic 和 Gemini 当前优先使用 provider countTokens；其他 provider 可回退本地估算。

manual `/compact`、auto compaction、prompt-too-long compact-and-retry、post-compact resource budget 已有最小闭环。完整 token budget engine、tool result micro-compaction 和 OpenAI provider countTokens 仍未完成。

## Tool System

工具通过 registry 和 metadata 暴露给 agent loop。

当前 tool metadata 包含 source、category、risk level、read-only、requires confirmation 等治理信息。内置工具和 custom/extension-style tools 会进入同一个 active `ToolRegistry`，并统一应用 enabled/disabled tools、disabled categories、duplicate detection 和 metadata diagnostics。active tools 同时驱动 agent-loop 可执行工具、provider schema、token counter 和 `ContextBuilder` 的 dynamic tool prompt。agent-loop 在 tool call 前经过统一 governance hook。

工具展示当前采用 `renderCall + contentBlocks + durable typed details + displayContent` 最小边界。工具定义可通过 `renderCall(args)` 生成 tool call 摘要；`content` 仍保留为兼容文本，`contentBlocks` 已支持 text block 并可随 tool message 持久化到 session；`details` 承载工具结构化信息，例如截断统计、bash exit code、full output path、行数或结果数。默认 provider request 转换会把 block content flatten 为文本，并剥离 durable details，只发送 provider 需要的 tool result 文本。工具定义可通过 `renderResult` 基于 details 和 `expanded/isPartial` render options 生成 `displayContent`。`ToolResultRenderer` service 会把 runtime result 与 durable tool message 归一到同一套 plain text renderer，CLI/TUI 和最小 export text 边界可复用；`/diagnostics` 不作为 tool details 的主要消费路径。

当前核心内置工具真实名已按 `pi-mono` 收敛为 `read/write/edit/ls/grep/find/bash`；后台 bash 辅助工具 `bash_output` / `bash_kill` 暂保留 Eva 现有后台命令协议。内置工具 renderer 已开始按 `pi-mono` 风格做 tool call 摘要和 tool-specific collapsed preview：bash call 显示 `$ command`，read/grep/find/ls/write/edit call 显示关键路径、pattern、limit 等参数；`read` result 展示前 10 行，`grep` 展示前 15 行，`find` / `ls` 展示前 20 行，`bash` 按 terminal-width visual lines 展示 tail 5 行。TUI/CLI 展示层可用 tool definition 和 tool args 重新渲染结果；TUI 已支持通过 `Ctrl-T` 全局切换工具结果的 collapsed/expanded 展示。foreground bash 已支持 streaming partial update，并在截断时写系统临时 full output log。

agent-loop 支持内部 `ToolExecutionHook[]` 边界。hook 可在 tool call 前合并 execution context，也可在 tool result 后补充受限结果字段，例如 details、displayContent、content/error 覆盖；observer lifecycle hook 可订阅 tool start/update/end，用于 telemetry、audit 或 extension-side event interception，不改变工具执行结果。当前 runtime permission governance 已作为命名 hook 接入；该边界仍是内部机制，不是完整 extension API。

当前内置工具仍是主要工具来源。custom tools 已有最小 registry/governance/prompt metadata 边界；MCP/extension package source discovery、完整 ownership、remote adapters 和更复杂 orchestration 尚未实现。

## Permission / Safety

工具治理当前采用统一 decision 语义：`allow`、`deny`、`ask`。

当前 permission mode 包含 `default`、`read-only`、`full-access`。`default` 允许 workspace 内读写和本地命令，对 workspace 外文件访问和疑似网络命令请求权限；`read-only` 只允许只读工具；`full-access` 在 Eva 层放行工具调用，但仍受底层 sandbox 和系统权限限制。

interactive/TUI mode 可以询问用户。无确认通道时默认 fail-closed，并可写入 durable `permission_pending` internal entry。RPC mode 已有 pending permission approval 最小闭环，可输出 pending event 并接受 approve/deny。

完整 classifier slot、sandbox policy integration 和更细的网络/危险命令识别尚未完成。

## Resources / MCP / Skills / Extensions

`src/core/resource-loader.ts` 负责 system prompt、`AGENTS.md` project context、skills discovery、skills source metadata 和 resource diagnostics。

Skills 当前作为 resource 处理，而不是 builtin tool。ResourceLoader 发现 skills 后，`ContextBuilder` 默认注入 skill metadata；用户显式 `/skill:name` 时，下一次 provider request 注入 skill 全文，且不写入 durable session history。

MCP 配置字段已解析，但当前只报告 extension boundary diagnostic，尚未接入 MCP server lifecycle。package/extension source discovery 仍是后续方向。

## Modes / Interfaces

mode 层只负责输入输出和展示，不重新装配 core runtime。

当前 modes：

- interactive readline mode。
- print/headless single-run mode。
- TUI mode，复用 RuntimeHost、AgentSession、interactive slash command 和 permission handling。
- JSONL RPC mode，复用 RuntimeHost 和 AgentSession，支持 prompt、state、abort、session lifecycle 和 permission approval。

TUI 是 Eva 自建最小 terminal UI 框架，不引入第二套 agent/runtime。

## Provider / Config / Observability

provider 差异留在 `src/llm/` adapter 层。Runtime/session/mode 不直接处理 provider API 细节。

配置由 `src/config.ts` 加载并校验。RuntimeServices 基于配置创建 provider、resources、tools、context 和 session services。

diagnostics 使用统一结构：

- `source`：`config`、`provider`、`tools`、`session`、`resource`、`context`。
- `level`：`info`、`warning`、`error`。
- `code`：稳定机器可读标识。
- `message`：面向 CLI 的简短说明。
- `details`：可选结构化上下文。

mode 层负责展示 diagnostics；core 层负责收集 diagnostics。
