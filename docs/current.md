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
- M5 三模式 permission rule/mode 最小闭环已实现：`default`、`read-only`、`full-access` 已落地到 runtime/tool governance，并记录 pending/denied 关键事实；网络/敏感系统命令识别已覆盖常见远端 git、包管理器、容器/云工具和系统包管理器命令。
- M5 Tool Result Budget 当前已有最小实现：agent-loop 写回边界会对超预算 tool result 做 preview 截断，并保留原始长度/预算 metadata。
- 超大工具输出 session sidecar artifact 路径已拆除：tool result 不再保存 artifact reference、不再写 `tool_result_artifact` internal entry，session storage 不再暴露 tool result artifact API。
- 工具层大输出截断已开始按工具类型收敛：`read_file` 保留 head 并提示 offset continuation，`bash` 保留 tail 并只在截断/中断时写系统临时 log，`grep_files` / `find_files` / `list_files` 保留 head 并提示缩小范围。
- 工具执行 abort lifecycle 已收敛：agent-loop 在工具批次边界停止后续执行，foreground bash 会响应 abort，已 abort 的同步文件工具不会继续读写。
- Tool operation injection 最小边界已实现：文件工具可注入 `FileToolOperations`，foreground bash 可注入 `BashOperations.exec`，background bash 可注入 `BashOperations.spawn`，默认实现仍使用本地 fs/shell。
- 工具执行状态保持 pi-mono 风格的 lifecycle event 归约：`Agent` 基于 `tool_execution_start/end` 维护 `pendingToolCalls`，暂不引入独立 tool execution diagnostics 聚合层。

## 进行中

- M5 Tool / Permission Governance 继续推进。
- 当前网络/危险命令识别补强已完成，下一步可转向 permission 与底层 sandbox enforcement 的边界梳理，或继续推进 tool result budget 的细化。

## 下一步

- 梳理 Eva permission policy 与底层 sandbox enforcement 的职责边界，明确哪些能力只做 Eva 层提示，哪些需要交给运行环境强制执行。
- 保持 permission diagnostics 简单，继续沿用 pending/denied 关键事实和 `/diagnostics` 摘要展示。
- 后续可继续细化工具输出体验：更准确的行/字节统计、bash streaming accumulator、背景任务输出滚动窗口和 compaction-time tool result micro-compaction。

## 已知问题

- 工具层大输出已具备 head/tail 基础策略，但仍缺更完整的行/字节统计、streaming accumulator 和 compaction-time tool result micro-compaction。
- abort lifecycle 已覆盖当前内置工具的主要路径，但仍缺更细的 abort reason 和队列状态；工具执行诊断暂保持 lifecycle event + pending state 的简单边界。
- operation injection 目前是最小边界，尚未提供统一 remote workspace adapter、sandbox adapter 或 extension wrapper。
- `ContextManager` 仍未支持完整 token budget 或 OpenAI provider countTokens。
- manual `/compact` 仍是最小版：没有工具结果 micro-compaction。
- skills 已有 resource discovery、source metadata、metadata system prompt 注入和 `/skill:name` 全文按需展开；尚未支持 package/extension source discovery。
- MCP 相关配置字段已解析，但当前只报告 extension boundary diagnostic，尚未接入 MCP server lifecycle。
- session 当前有意暂不拆完整 `SessionRepo`；跨 session parent/child entry graph、完整 tree navigation 交互和 branch summarization pipeline 仍未实现。
- 三模式 permission rule/mode 已落地到 runtime/tool governance，并已有 pending/denied 记录和常见网络/敏感系统命令识别；当前只在 Eva 层做 policy gating，尚未接入底层 sandbox enforcement。
- TUI 已有最小单元测试，但仍缺真实终端兼容性 smoke test。
