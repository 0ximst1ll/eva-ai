# Eva AI Current

## 当前状态（2026-05-30）

## 已完成

- interactive、print、TUI 和 RPC modes 已共享 `RuntimeHost` 与同一套 runtime/session 路径。
- `RuntimeServices` 已承载 workspace 绑定的 config、provider、tools、session manager、resource loader、context builder、context manager、token counter 和 diagnostics。
- `AgentMessage` / `LlmMessage` 最小类型边界已引入，agent-loop 会在 provider call 前执行 `transformContext()` 和 `convertToLlm()`。
- `ResourceLoader` 已支持 system prompt、`AGENTS.md` project context、配置目录 skills discovery、skills source metadata、metadata system prompt 注入、explicit skill invocation 和 skills/resource diagnostics 展示。
- `ContextBuilder` 已收敛为 provider request view builder；`ContextManager` 已提供 token estimate、usage percent、compaction recommendation、skills/resource 和 permission pending/denied diagnostics 的最小聚合。
- `TokenCounter` 已支持 provider/local 计数边界，Anthropic 和 Gemini provider 优先使用 countTokens API。
- manual `/compact`、auto compaction、prompt-too-long compact-and-retry、post-compact resource budget 最小闭环已实现。
- durable `internal` session entry 和 permission pending/denied durable diagnostics 已实现。
- TUI 已接入共享 runtime，支持 tool confirmation、Ctrl-C abort/exit、session/entry navigation 和低噪音 streaming event 渲染。
- Headless JSONL RPC 最小闭环已实现，支持 prompt、state、abort、session lifecycle 和 permission approve/deny。
- M4 session tree 核心路径已完成：entry-tree-first session model、active leaf path rebuild、fork/clone/branch/import/export、branch summary、entry navigation、schema validation、latest fallback 和 recovery smoke cases。
- `SessionManager` 已收敛为 public lifecycle facade；storage backend、entry store、session model、log parser、context rebuilder 和 fork/create/load helper 已拆出。
- M5 Tool Execution Orchestration 最小闭环已实现：安全 read-only batch 并发，write/bash/high-risk/unknown 工具串行，tool result 按模型 tool call 原始顺序写回。
- M5 三模式 permission rule/mode 最小闭环已实现：`default`、`read-only`、`full-access` 已落地到 runtime/tool governance，并记录 pending/denied 关键事实；网络/敏感系统命令识别已覆盖常见远端 git、包管理器、容器/云工具和系统包管理器命令；permission result 已明确表达 workspace 外、网络和系统资源 capability，并标记当前不提供 OS 级 sandbox enforcement。
- M5 Tool Result Budget 当前已有最小实现：agent-loop 写回边界会对超预算 tool result 做 preview 截断，并保留原始长度/预算 metadata。
- ToolResult `content + typed details` 最小闭环已实现：agent-loop 会透传工具结构化 details，`read_file`、`bash`、`grep_files`、`find_files`、`list_files` 已输出工具专属 details 类型，包含 truncation、行数/结果数、exit code、full output path 等结构化信息。
- 工具级 `renderResult` 最小边界已实现：工具定义可基于 typed details 生成 `displayContent`，CLI/TUI 优先展示该字段；模型写回和 session 持久化仍使用原始 `content`。
- 超大工具输出 session sidecar artifact 路径已拆除：tool result 不再保存 artifact reference、不再写 `tool_result_artifact` internal entry，session storage 不再暴露 tool result artifact API。
- 工具层大输出截断已开始按工具类型收敛：`read_file` 保留 head 并提示 offset continuation，`bash` 保留 tail 并只在截断/中断时写系统临时 log，`grep_files` / `find_files` / `list_files` 保留 head 并提示缩小范围。
- 工具执行 abort lifecycle 已收敛：agent-loop 在工具批次边界停止后续执行，foreground bash 会响应 abort，已 abort 的同步文件工具不会继续读写。
- Tool operation injection 最小边界已实现：文件工具可注入 `FileToolOperations`，foreground bash 可注入 `BashOperations.exec`，background bash 可注入 `BashOperations.spawn`，默认实现仍使用本地 fs/shell。
- 工具执行状态保持 pi-mono 风格的 lifecycle event 归约：`Agent` 基于 `tool_execution_start/end` 维护 `pendingToolCalls`，暂不引入独立 tool execution diagnostics 聚合层。

## 进行中

- M5 Tool / Permission Governance 继续推进。
- 当前 ToolResult `content + typed details` 和工具级 `renderResult` 最小边界已完成；下一步可继续推进 compaction-time tool result micro-compaction 或 extension-style tool call/result hooks。

## 下一步

- Tool System 后续继续吸收 `pi-mono` 的 `ToolDefinition + typed details + render boundary + tool_call/tool_result hook` 设计；下一步可在现有 `renderResult` 边界上补 extension-style hook，不直接引入完整 extension system。
- 下一步建议：继续细化 TUI/CLI 的工具展示体验，让展示层只消费 `displayContent` 和 lifecycle state，不解析工具文本。
- 继续细化工具输出体验：更准确的行/字节统计、bash streaming accumulator、背景任务输出滚动窗口和 compaction-time tool result micro-compaction。
- 保持 permission diagnostics 简单，继续沿用 pending/denied 关键事实；`/diagnostics` 不承载 tool result details 展示。
- 或进入 MCP lifecycle 最小闭环：server pending/connected/failed/timeout 状态与 tools/resources/prompts loading 边界。

## 已知问题

- 工具层大输出已具备 head/tail 基础策略，但仍缺更完整的行/字节统计、streaming accumulator 和 compaction-time tool result micro-compaction。
- Tool Result 已有 `content + typed details` 和工具级 `renderResult` 最小边界；尚未形成 compaction-time micro-compaction。
- abort lifecycle 已覆盖当前内置工具的主要路径，但仍缺更细的 abort reason 和队列状态；工具执行诊断暂保持 lifecycle event + pending state 的简单边界。
- operation injection 目前是最小边界，尚未提供统一 remote workspace adapter、sandbox adapter 或 extension wrapper。
- `ContextManager` 仍未支持完整 token budget 或 OpenAI provider countTokens。
- manual `/compact` 仍是最小版：没有工具结果 micro-compaction。
- skills 已有 resource discovery、source metadata、metadata system prompt 注入和 `/skill:name` 全文按需展开；尚未支持 package/extension source discovery。
- MCP 相关配置字段已解析，但当前只报告 extension boundary diagnostic，尚未接入 MCP server lifecycle。
- session 当前有意暂不拆完整 `SessionRepo`；跨 session parent/child entry graph、完整 tree navigation 交互和 branch summarization pipeline 仍未实现。
- 三模式 permission rule/mode 已落地到 runtime/tool governance，并已有 pending/denied 记录、常见网络/敏感系统命令识别和 execution capability flags；当前只在 Eva 层做 policy gating，尚未接入底层 sandbox enforcement。
- TUI 已有最小单元测试，但仍缺真实终端兼容性 smoke test。
