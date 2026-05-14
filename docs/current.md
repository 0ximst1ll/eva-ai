# Eva AI Current

## 当前状态（2026-05-14）

Eva AI 当前已完成 M0 基线稳定、M2 RuntimeServices / ResourceLoader 主要骨架、manual `/compact` 最小闭环、Context diagnostics 最小展示、assistant usage 持久化最小闭环、最小 `ContextManager` diagnostics 聚合、TokenCounter provider/local 计数边界、Anthropic/Gemini countTokens 最小接入、可选 context usage percent、auto compaction 最小执行闭环、prompt-too-long recovery 最小闭环、post-compact resource budget 最小闭环、Provider / Observability 最小闭环、M2.x Agent Core Alignment 最小闭环、durable `internal` session entry、permission pending durable diagnostics，以及自建最小 TUI 框架与 `tui-mode.ts`。

当前刚从远程 `origin/eva-tui-cc` 合入 TUI 框架。CLI 在无 task 时默认启动 TUI，`--no-tui` 回退到原 readline interactive mode；print/headless task 路径保持不变。TUI mode 复用 `RuntimeHost`、`AgentSession`、`handleInteractiveCommand()` 和当前 `allow` / `deny` / `ask` 权限模型。

## 已完成

- interactive、print 和 TUI modes 已共享 `RuntimeHost` 与同一套 runtime/session 路径。
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

## 进行中

- 正在验证远程 TUI 合并后的当前代码是否仍通过 typecheck 和 test。

## 下一步

- 若验证通过，提交 TUI 合并。
- 进入 TUI 稳定化：补最小 TUI 测试，并评估默认 TUI 的终端兼容性。
- 之后进入 M3 Headless RPC 前置设计：定义最小 JSONL stdin/stdout 协议、命令集和事件输出边界。

## 后续重点计划

- RPC/TUI/MCP/Extensions 应基于当前 M2.x 消息边界继续演进，避免重新绑定 provider-facing `LlmMessage[]`。
- ContextManager 后续再承接完整 token budget 和 skills/resource reinjection 策略。
- 当前 `max_steps` 后续应进一步迁移为 print/headless/RPC 场景下的命名更明确的可选 runaway guard。
- 长任务能力应通过 token accounting、context rebuild、compaction entry 和手动 `/compact` 逐步建立。
- 完整 session tree、fork、clone 和 path-aware context rebuild 放入后续 session model 阶段。
- 完整 permission pipeline 后续继续补 permission modes、rules、diagnostics 和 RPC/ACP pending event。

## 已知问题

- `logger.ts` 仍是占位文件。
- `ResourceLoader` 仍是最小骨架，尚未支持自动监听或更细粒度 reload。
- 运行期 `resource_context` / `compaction_summary` internal marker 仍默认不持久化；只有明确需要跨 resume 恢复的 harness metadata 才应写入 durable `internal` entry。
- `ContextManager` 仍未支持完整 token budget 或 OpenAI provider countTokens。
- manual `/compact` 仍是最小版：没有工具结果 micro-compaction。
- skills、MCP 相关配置字段已解析，但还没有接入 tool/resource loader。
- 当前 `max_steps` 字段名仍偏模糊，后续应迁移为 `max_steps_per_run` 或同类命名。
- RPC mode 尚不存在。
- session history 仍是 flat JSONL，尚未升级为 session tree。
- tool result budget、超大输出持久化、完整 permission pipeline 尚未实现。
- TUI 框架尚未覆盖测试。
