# Eva AI Current

## 当前状态（2026-05-28）

## 已完成

- interactive、print、TUI 和 RPC modes 已共享 `RuntimeHost` 与同一套 runtime/session 路径。
- `RuntimeServices` 已承载 workspace 绑定的 config、provider、tools、session manager、resource loader、context builder、context manager、token counter 和 diagnostics。
- `AgentMessage` / `LlmMessage` 最小类型边界已引入，agent-loop 会在 provider call 前执行 `transformContext()` 和 `convertToLlm()`。
- `ResourceLoader` 已支持 system prompt、`AGENTS.md` project context、配置目录 skills discovery、skills source metadata、metadata system prompt 注入、explicit skill invocation 和 skills/resource diagnostics 展示。
- `ContextBuilder` 已收敛为 provider request view builder；`ContextManager` 已提供 token estimate、usage percent、compaction recommendation、skills/resource 和 permission pending diagnostics 的最小聚合。
- `TokenCounter` 已支持 provider/local 计数边界，Anthropic 和 Gemini provider 优先使用 countTokens API。
- manual `/compact`、auto compaction、prompt-too-long compact-and-retry、post-compact resource budget 最小闭环已实现。
- durable `internal` session entry 和 permission pending durable diagnostics 已实现。
- TUI 已接入共享 runtime，支持 tool confirmation、Ctrl-C abort/exit、session/entry navigation 和低噪音 streaming event 渲染。
- Headless JSONL RPC 最小闭环已实现，支持 prompt、state、abort、session lifecycle 和 permission approve/deny。
- M4 session tree 核心路径已完成：entry-tree-first session model、active leaf path rebuild、fork/clone/branch/import/export、branch summary、entry navigation、schema validation、latest fallback 和 recovery smoke cases。
- `SessionManager` 已收敛为 public lifecycle facade；storage backend、entry store、session model、log parser、context rebuilder 和 fork/create/load helper 已拆出。
- M5 Tool Execution Orchestration 最小闭环已实现：安全 read-only batch 并发，write/bash/high-risk/unknown 工具串行，tool result 按模型 tool call 原始顺序写回。
- M5 三模式 permission rule/mode 最小闭环已实现：`default`、`read-only`、`full-access` 已落地到 runtime/tool governance。
- M5 Tool Result Budget 当前已有最小实现：agent-loop 写回边界会对超预算 tool result 做 preview 截断，并保留原始长度/预算 metadata。
- 超大工具输出 session sidecar artifact 路径已拆除：tool result 不再保存 artifact reference、不再写 `tool_result_artifact` internal entry，session storage 不再暴露 tool result artifact API。

## 进行中

- M5 Tool / Permission Governance 继续推进。
- 当前重点调整为 tool result 大输出策略收敛：durable session artifact 已拆除，后续继续补更接近 `pi-mono` 的工具层截断 / 临时输出模型。

## 下一步

- 将大输出处理边界前移到工具层或 request view 层：文件类工具通过 offset/limit/缩小查询继续读取，bash 类流式输出后续可按需使用临时文件提示，但不作为 session sidecar 长期保存。
- 按工具类型细化截断策略：文件类工具优先 head/continuation，bash 类工具优先 tail/临时输出提示。
- 继续推进权限治理：补更细的网络/危险命令识别、sandbox policy integration 和 permission diagnostics 展示。
- 继续补强工具执行治理：abort 下的工具执行生命周期、tool operation injection 和更细的 tool execution diagnostics。

## 已知问题

- 当前工具大输出截断仍是统一字符预算，尚未按工具类型区分 head/tail 策略，也没有 `pi-mono` 式的 read offset continuation 或 bash tail/temp output 细化。
- `ContextManager` 仍未支持完整 token budget 或 OpenAI provider countTokens。
- manual `/compact` 仍是最小版：没有工具结果 micro-compaction。
- skills 已有 resource discovery、source metadata、metadata system prompt 注入和 `/skill:name` 全文按需展开；尚未支持 package/extension source discovery。
- MCP 相关配置字段已解析，但当前只报告 extension boundary diagnostic，尚未接入 MCP server lifecycle。
- session 当前有意暂不拆完整 `SessionRepo`；跨 session parent/child entry graph、完整 tree navigation 交互和 branch summarization pipeline 仍未实现。
- 三模式 permission rule/mode 已落地到 runtime/tool governance，但网络命令识别仍是最小启发式，尚未接入底层 sandbox policy。
- TUI 已有最小单元测试，但仍缺真实终端兼容性 smoke test。
