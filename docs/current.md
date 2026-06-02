# Eva AI Current

## 当前状态（2026-06-02）

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
- Tool call renderer 边界已对齐 `pi-mono`：工具定义可提供 `renderCall(args)`，TUI 通过工具 renderer 展示 bash `$ command`、read path、grep pattern/path 等关键参数，未知工具保留 fallback 摘要。
- 工具运行时 schema 校验最小闭环已对齐 `pi-mono`：agent-loop 会在 hooks/execute 前校验 tool arguments，非法参数返回工具错误，不再进入具体工具执行。
- AgentSession 已补任务级 auto-retry：provider/SDK 层 retry 耗尽后，503/429/timeout 等可恢复 LLM 错误会按会话层指数退避继续同一个任务，中间失败事件默认不结束用户任务。
- ProviderModel / ProviderRequestOptions / ProviderAuthResolver 最小骨架已实现：RuntimeServices 会创建结构化 provider runtime context，LLMClient 保持旧构造兼容并可接收结构化 model/auth/request options。
- Google provider thinkingConfig 已对齐 `pi-mono` 的分层策略：ProviderModel 判断 reasoning 能力，GoogleClient 按 Gemini family 映射 `thinkingLevel` / `thinkingBudget`，不再无条件 `includeThoughts`。
- ProviderRequestOptions 已接入具体 provider adapter：OpenAI/Anthropic/Gemini 会消费 request-time `temperature`、`maxTokens`，并把 `headers`、`timeoutMs`、`maxRetries` 传入对应 SDK transport/client 边界。
- Provider request lifecycle 测试已补最小覆盖：auth resolver 优先级、OpenAI/Anthropic/Gemini transport options、timeout error 分类、session-level retry cap 和成功 auto-retry 路径已被测试固定。
- Provider abort propagation 最小闭环已实现：agent-loop 会把 run `AbortSignal` 传入 LLM request options，OpenAI/Anthropic adapter 会转交 SDK request options，Google adapter 会在请求前和 stream 消费中 fail-fast；AbortError 不再进入通用 retry，agent-loop 会归一为用户取消结果。
- Provider Retry-After 最小闭环已实现：provider error formatter 会从常见 header/json/text 结构解析 `retryAfterMs`，AgentSession auto-retry 会优先使用该 delay，并继续受 `maxDelayMs` 上限保护。
- TUI 工具输出展开/折叠已对齐 `pi-mono` 的全局模式：`Ctrl-T` 切换所有工具结果，新增工具结果继承当前全局展开状态。
- Bash streaming partial update 最小闭环已实现：foreground bash 会通过 `tool_execution_update` 透传有界 tail preview，TUI 对同一个 tool call 原地刷新 running/completed 状态，截断时复用同一个系统临时 full output log 路径。
- RPC 已将 `tool_execution_update` 作为稳定 JSONL event 边界透出，保留 partial result 的 `content`、`displayContent`、`details` 和 tool args，客户端可按 `toolCallId` 消费 partial update。
- Bash visual-line tail preview 最小闭环已实现：TUI/CLI 会把终端宽度传给工具 renderer，bash collapsed/partial preview 可按 terminal-width visual lines 取尾部输出。
- 超大工具输出 session sidecar artifact 路径已拆除：tool result 不再保存 artifact reference、不再写 `tool_result_artifact` internal entry，session storage 不再暴露 tool result artifact API。
- 工具层大输出截断已开始按工具类型收敛：`read_file` 保留 head 并提示 offset continuation，`bash` 保留 tail 并只在截断/中断时写系统临时 log，`grep_files` / `find_files` / `list_files` 保留 head 并提示缩小范围。
- 工具输出截断元数据已对齐 `pi-mono` 的 lines/bytes 双限制模型：`truncation` details 同时保留 Eva 旧 renderer 兼容字段和 `truncatedBy`、`totalLines`、`outputLines`、`totalBytes`、`outputBytes`、`maxLines`、`maxBytes` 等结构化字段。
- 工具执行 abort lifecycle 已收敛：agent-loop 在工具批次边界停止后续执行，foreground bash 会响应 abort，已 abort 的同步文件工具不会继续读写。
- Tool operation injection 最小边界已实现：文件工具可注入 `FileToolOperations`，foreground bash 可注入 `BashOperations.exec`，background bash 可注入 `BashOperations.spawn`，默认实现仍使用本地 fs/shell。
- 工具执行状态保持 pi-mono 风格的 lifecycle event 归约：`Agent` 基于 `tool_execution_start/end` 维护 `pendingToolCalls`，暂不引入独立 tool execution diagnostics 聚合层。
- Extension-style tool execution hook 最小边界已实现：agent-loop 支持 `ToolExecutionHook[]`，可在 tool call 前合并 execution context、在 tool result 后补充 details/displayContent 等受限字段；runtime permission governance 已接入命名 hook，旧 `beforeToolCall/afterToolCall` 参数保留兼容。

## 进行中

- M5 Tool output UX 继续收口。
- 当前已完成工具输出截断元数据对齐；后续进入 compaction-time tool result micro-compaction 前置设计。

## 下一步

- 第一优先级：继续 Tool output UX 后续项，为 compaction-time tool result micro-compaction 做准备。
- 第二优先级：根据真实使用反馈决定是否需要暴露 reasoning 配置；默认仍使用模型 metadata 的 conservative default。
- 第三优先级：后续进入 MCP lifecycle 最小闭环，接入同一 registry、metadata 和 hook 边界，不直接引入完整 extension system。
- 保持 permission diagnostics 简单，继续沿用 pending/denied 关键事实；`/diagnostics` 不承载 tool result details 展示。

## 已知问题

- Provider 层仍偏薄：模型能力、认证解析和请求选项已有最小结构化边界，OpenAI/Anthropic/Gemini 已消费主要 ProviderRequestOptions；abort propagation 和 Retry-After 已有最小闭环，但 provider-specific error metadata 仍未形成完整 lifecycle 边界。
- Provider auth 当前已有 API key resolver，支持 runtime/config/env 优先级；尚未支持 OAuth 或 provider-specific auth storage。
- 工具层大输出已具备 head/tail 基础策略、lines/bytes truncation details、tool-specific collapsed line preview、TUI 全局工具结果 expand/collapse、bash streaming partial update、RPC partial update event 和 bash visual-line tail preview，但仍缺 compaction-time tool result micro-compaction。
- Tool Result 已有 `content + typed details` 和工具级 `renderResult` 最小边界；尚未形成 compaction-time micro-compaction。
- abort lifecycle 已覆盖当前内置工具的主要路径，但仍缺更细的 abort reason 和队列状态；工具执行诊断暂保持 lifecycle event + pending state 的简单边界。
- operation injection 和 tool execution hook 目前是内部最小边界，尚未提供统一 remote workspace adapter、sandbox adapter 或完整 extension wrapper。
- `ContextManager` 仍未支持完整 token budget 或 OpenAI provider countTokens。
- manual `/compact` 仍是最小版：没有工具结果 micro-compaction。
- skills 已有 resource discovery、source metadata、metadata system prompt 注入和 `/skill:name` 全文按需展开；尚未支持 package/extension source discovery。
- MCP 相关配置字段已解析，但当前只报告 extension boundary diagnostic，尚未接入 MCP server lifecycle。
- session 当前有意暂不拆完整 `SessionRepo`；跨 session parent/child entry graph、完整 tree navigation 交互和 branch summarization pipeline 仍未实现。
- 三模式 permission rule/mode 已落地到 runtime/tool governance，并已有 pending/denied 记录、常见网络/敏感系统命令识别和 execution capability flags；当前只在 Eva 层做 policy gating，尚未接入底层 sandbox enforcement。
- TUI 已有最小单元测试，但仍缺真实终端兼容性 smoke test。
