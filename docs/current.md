# Eva AI Current

## 当前状态（2026-05-16）

Eva AI 当前已完成 M0 基线稳定、M2 RuntimeServices / ResourceLoader 主要骨架、manual `/compact` 最小闭环、Context diagnostics 最小展示、assistant usage 持久化最小闭环、最小 `ContextManager` diagnostics 聚合、TokenCounter provider/local 计数边界、Anthropic/Gemini countTokens 最小接入、可选 context usage percent、auto compaction 最小执行闭环、prompt-too-long recovery 最小闭环、post-compact resource budget 最小闭环、Provider / Observability 最小闭环、M2.x Agent Core Alignment 最小闭环、durable `internal` session entry、permission pending durable diagnostics、自建最小 TUI 框架与 `tui-mode.ts`、TUI 稳定化第一轮、M3 Headless RPC 最小闭环，以及 M4 Session Tree 最小 lineage/fork schema 和 `SessionContextRebuilder` snapshot 边界。

当前 M3 Headless RPC 已完成最小实现：`--rpc` 启动 JSONL stdin/stdout 协议，RPC mode 共享 `RuntimeHost` / `AgentSession` 路径，不新增第二套 agent 实现。RPC 真实 CLI 子进程 smoke test 已补齐，用于验证 stdout 协议纯净性。M3.1 RPC permission pending approval 最小闭环已实现：默认 fail-closed，`permission_mode=request` 时可通过 RPC event 和审批命令完成 tool permission 决策。

当前 M4 已完成前两步：`SessionManager` 支持向后兼容的 lineage metadata、`forkSession()`、旧 JSONL root fallback；`RuntimeHost` 暴露 `forkSession()`；interactive/TUI 可通过 `/fork [id]` 创建当前 session 分支；`SessionContextRebuilder` 已提供最小 `flat_snapshot` rebuild 边界。

## 已完成

- interactive、print、TUI 和 RPC modes 已共享 `RuntimeHost` 与同一套 runtime/session 路径。
- 已实现 `RuntimeHost` 的 `newSession()`、`resumeLatestSession()`、`switchSession()` 和 `reloadResources()`。
- 当前已有 JSONL session persistence、builtin file/search/bash tools、tool registry、高风险工具 confirmation hook、最小 permission pending 语义、abort 和 queue 基础能力。
- 已建立 `test` 和 `typecheck` script，并覆盖 retry、SessionManager、agent-loop、RuntimeHost、abort、queue 等核心路径。
- interactive mode 已实现 `/new`、`/resume`、`/resume <id>`、`/clear`、`/history`、`/stats`、`/diagnostics`、`/reload` 和 `/sessions`。
- runtime diagnostics 已统一为 `source`、`level`、`code`、`message`、`details` 结构。
- `RuntimeServices` 已承载 workspace 绑定的 config、provider、tools、session manager、resource loader、context builder 和 diagnostics。
- `ResourceLoader` 已支持 system prompt 与 `AGENTS.md` project context 加载，并对尚未接入的 skills、MCP 返回 diagnostics。
- `ContextBuilder` 已收敛为 provider request view builder，并支持 project context 字符预算、截断、跳过原因、post-compact 保守资源预算和 token estimate。
- `TokenCounter` 已支持 provider/local 计数边界，Anthropic 和 Gemini provider 优先使用 countTokens API，失败或不支持时回退本地估算。
- `ContextManager` 已作为最小状态聚合器，汇总 active messages、step guard、compaction、usage、project context metadata、token count source、可选 context usage percent、compaction recommendation 和 permission pending 概要。
- `AgentSession.run()` 已支持基于 `reserve_reached` recommendation 的 auto compaction 最小执行闭环。
- `AgentSession.run()` 已支持 prompt-too-long recovery 最小闭环：识别 context/prompt overflow 错误，执行一次 compact-and-retry。
- interactive mode 的 `/stats` 和 `/diagnostics` 已通过 `ContextManager` 展示 project context、token estimate、context usage percent、count source、compaction recommendation 和最近一次 build 状态。
- interactive mode 已实现 `/reload` 和 `/compact [custom instructions]`。
- `SessionManager` 已支持 flat JSONL 兼容的 `message`、`compaction`、`usage` 和 durable `internal` entry。
- `AgentMessage` / `LlmMessage` 最小类型边界已引入，agent-loop 会在 provider call 前执行 `transformContext()` 和 `convertToLlm()`。
- internal `AgentMessage` 最小类型已可存在于 agent-loop working history，默认不会发送给 provider，也不会写入当前 flat JSONL message log。
- 每次 `ContextBuilder` 构造 provider request view 后，agent-loop 会追加 `resource_context` internal marker。
- `AgentSession.compact()` 成功后会向 Agent working history 追加 `compaction_summary` internal marker。
- tool governance 在 permission pending 时会写入 `permission_pending` durable internal entry，`ContextManager` 会聚合 pending 数量和最近一条记录，interactive `/diagnostics` 会显示 pending 概要。
- 自建最小 TUI 框架 `src/tui/`：差量渲染引擎、`Component` / `Container`、terminal 输入解析、文本/markdown/input/footer/spinner/select-list 等基础组件。
- 新增 `tui-mode.ts`，布局为 header、chat、status、input、footer，复用 slash command 处理和 session lifecycle。
- TUI mode 支持 tool confirmation、Ctrl-C abort/exit、`/sessions` 选择器和 streaming event 渲染。
- CLI 在无 task 且 stdin/stdout 都是 TTY 时默认启动 TUI；`--no-tui` 或非 TTY 环境会回退 readline interactive mode。
- TUI mode 已改为通过 promise resolve 结束，不再直接 `process.exit()`。
- `ProcessTerminal.destroy()` 会移除 stdin/stdout process listeners，避免重复创建 TUI 时泄漏监听器。
- TUI 默认事件展示已收敛：忽略 thinking delta，只显示 assistant content、tool call 摘要、tool result 摘要和 error message。
- `test/tui.test.ts` 已覆盖 `StdinBuffer`、text utils、`Input`、`MultilineInput` 和 `TUI` renderer 基础行为。
- `src/modes/rpc-mode.ts` 已实现 JSONL RPC envelope：`response`、`event` 和 `error`。
- CLI 已支持 `--rpc`，并在 RPC 模式下保持 stdout 只输出 JSONL 协议内容。
- RPC 已支持 `prompt`、`get_state`、`abort`、`new_session` 和 `resume_session`。
- RPC `prompt` 会输出包裹后的 `AgentSessionEvent`，结束后返回 final response 和 state。
- RPC 允许 active prompt 期间处理 `abort` 和 `get_state`；其他 session 变更命令会返回 `run_in_progress`。
- RPC CLI smoke test 已覆盖真实 `src/cli.ts --rpc` 子进程、非法 JSON、`get_state` 和 stdout JSONL envelope 纯净性。
- M3.1 RPC permission pending 设计已明确：默认 fail-closed，可通过 request 模式输出 `permission_pending` event，并通过 `approve_permission` / `deny_permission` 命令解析审批结果。
- RPC `permission_mode=request` 已支持 `permission_pending` event、`approve_permission` / `deny_permission` 命令、pending timeout、abort cancel 和 durable `permission_pending` internal entry。
- RPC `get_state` 已包含 pending permission 摘要。
- RPC permission tests 已覆盖 approve、deny、timeout 和 pending state summary。
- `SessionManager` 的 `session_start` 已支持 `parentSessionId`、`rootSessionId` 和 `forkedFromMessageIndex`。
- 旧 JSONL session 没有 lineage metadata 时会被视为 root session。
- `SessionManager.forkSession()` 会复制当前 active context messages 到新 session，并写入 lineage metadata；父子 session 后续消息互不影响。
- `RuntimeHost.forkSession()` 已作为 mode 层统一 fork 边界。
- interactive/TUI slash command 已支持 `/fork [id]`。
- `SessionContextRebuilder` 已支持旧 flat JSONL、forked session 和 compacted fork session 的 snapshot rebuild。
- `SessionContextRebuilder` 当前返回 active messages、lineage、branch path、compaction、usage 和 internal entries。

## 进行中

- M4 后续：path-aware context rebuild、clone/import/export、session tree 展示与 branch navigation 尚未实现。

## 下一步

- 继续 M4 path-aware context rebuild 设计，或先将 `SessionContextRebuilder` 接入 `SessionManager.loadSession()` 内部路径。
- 后续进入 MCP/Skills/Extensions 前置骨架。

## 后续重点计划

- RPC/TUI/MCP/Extensions 应基于当前 M2.x 消息边界继续演进，避免重新绑定 provider-facing `LlmMessage[]`。
- ContextManager 后续再承接完整 token budget 和 skills/resource reinjection 策略。
- 当前 `max_steps` 后续应进一步迁移为 print/headless/RPC 场景下的命名更明确的可选 runaway guard。
- 长任务能力应通过 token accounting、context rebuild、compaction entry 和手动 `/compact` 逐步建立。
- 完整 session tree、clone、import/export 和 path-aware context rebuild 放入后续 session model 阶段。
- 完整 permission pipeline 后续继续补 permission modes、rules、diagnostics 和 RPC/ACP pending event。

## 已知问题

- `logger.ts` 仍是占位文件。
- `ResourceLoader` 仍是最小骨架，尚未支持自动监听或更细粒度 reload。
- 运行期 `resource_context` / `compaction_summary` internal marker 仍默认不持久化；只有明确需要跨 resume 恢复的 harness metadata 才应写入 durable `internal` entry。
- `ContextManager` 仍未支持完整 token budget 或 OpenAI provider countTokens。
- manual `/compact` 仍是最小版：没有工具结果 micro-compaction。
- skills、MCP 相关配置字段已解析，但还没有接入 tool/resource loader。
- 当前 `max_steps` 字段名仍偏模糊，后续应迁移为 `max_steps_per_run` 或同类命名。
- RPC mode 仍是最小闭环，尚未支持完整 ACP 兼容层。
- session history 仍主要是 flat JSONL，已有最小 lineage/fork schema，但尚未支持完整 session tree/path-aware rebuild。
- tool result budget、超大输出持久化、完整 permission pipeline 尚未实现。
- TUI 已有最小单元测试，但仍缺真实终端兼容性 smoke test。
