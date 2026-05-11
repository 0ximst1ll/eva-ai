# Eva AI Current

## 当前状态（2026-05-11）

Eva AI 当前已完成 M0 基线稳定、M2 RuntimeServices / ResourceLoader 主要骨架、manual `/compact` 最小闭环、Context diagnostics 最小展示、assistant usage 持久化最小闭环、最小 `ContextManager` diagnostics 聚合、本地 request token estimation，以及自建最小 TUI 框架（`src/tui/`）并接入 `tui-mode.ts`。

刚完成的任务是参考 pi-mono 的 `pi-tui` 设计，为 Eva 自建了最小 TUI 框架，并新增 `tui-mode.ts` 作为并行 interactive mode。通过 `--tui` flag 启动，原 `interactive-mode.ts` 保留不变。

## 已完成

- 自建最小 TUI 框架 `src/tui/`：差量渲染引擎（16ms 节流、`cursorRow` 精确追踪、CSI 2026 synchronized output）、`Component` 接口 + `Container`、`utils`（visibleWidth/wrapText/truncate）、`StdinBuffer`（ESC 序列解析）、`ProcessTerminal`、`Text`/`Separator`/`Spacer`/`Input`/`Footer` 组件。
- 新增 `tui-mode.ts`，布局为 header → chatContainer → statusContainer → inputContainer → footer，inline 追加 + 终端 scrollback，与 pi-mono 方案一致。
- `--tui` flag 启动 TUI mode，原 `interactive-mode.ts` 保留不变，两种 mode 并行。
- TUI mode 复用 `handleInteractiveCommand()` 处理所有 slash commands，复用 `AbortController` 处理 Ctrl-C abort。

- interactive 和 print modes 已共享 `RuntimeHost` 与同一套 runtime/session 路径。
- 已实现 `RuntimeHost` 的 `newSession()`、`resumeLatestSession()`、`switchSession()` 和 `reloadResources()`。
- 当前已有 JSONL session persistence、builtin file/search/bash tools、tool registry、高风险工具 confirmation hook、abort 和 queue 基础能力。
- 已建立 `test` 和 `typecheck` script，并覆盖 retry、SessionManager、agent-loop、RuntimeHost、abort、queue 等核心路径。
- interactive mode 已实现 `/new`、`/resume`、`/resume <id>`、`/clear`、`/history`、`/stats`、`/diagnostics`、`/reload` 和 `/sessions`。
- runtime diagnostics 已统一为 `source`、`level`、`code`、`message`、`details` 结构。
- `RuntimeServices` 已承载 workspace 绑定的 config、provider、tools、session manager、resource loader、context builder 和 diagnostics。
- `ResourceLoader` 已支持 system prompt 与 `AGENTS.md` project context 加载，并对尚未接入的 skills、MCP 返回 diagnostics。
- `ContextBuilder` 已在每次 LLM call 前构造 request messages。
- `AGENTS.md` 已作为 transient project context 注入模型请求，不写回 session history。
- `ContextBuilder` 已支持 `project_context_max_chars` 字符预算、截断、跳过原因和最近一次 build 摘要。
- `ContextBuilder` 已记录最近一次 request messages 和 project context 的本地 token estimate。
- `ContextManager` 已作为最小状态聚合器，汇总 `ContextBuilder.latestBuild`、active messages、step guard、compaction、usage、project context metadata 和本地 token estimate。
- interactive mode 的 `/stats` 和 `/diagnostics` 已通过 `ContextManager` 展示 project context 数量、来源、token estimate 和最近一次 build 状态。
- interactive mode 已实现 `/reload`，可重新加载 system prompt 和 project context，并保持当前 session 不变。
- interactive mode 已实现 `/compact [custom instructions]`，用于手动压缩当前 session context。
- `AgentSession.compact()` 已支持调用当前 LLM 生成摘要，并在成功后重建当前活动上下文。
- `SessionManager` 已支持 flat JSONL 兼容的 `compaction` entry。
- compact 后当前活动上下文会变为 system prompt、summary 和最近保留消息；原始历史 message entries 仍保留在 JSONL log 中。
- compaction 失败不会修改当前 session messages。
- agent-loop 已支持可选 `maxSteps` guard，`null` / `undefined` 表示不限制。
- 配置未显式设置 `max_steps` 时默认无上限。
- CLI 在 interactive mode 下创建 runtime 时会传入 `maxSteps: null`，覆盖任何显式配置。
- print/headless mode 只有显式配置 `max_steps` 时才启用单次 run guard。
- `SessionManager` 已暴露最近一次 compaction metadata。
- `AgentSession` 已暴露有效 step guard 和 compaction 状态。
- `/stats` 已展示 step guard 与 compaction 简要状态。
- `/diagnostics` 已展示 active messages、step guard、compaction metadata 和 ContextBuilder 状态。
- `SessionManager` 已支持独立 `usage` entry，并能在 reload session 后恢复累计 usage 与最近一次 usage。
- `AgentSession` 已暴露 usage 状态，并会持久化 assistant response usage 和 compact LLM usage。
- `/stats` 与 `/diagnostics` 已展示 token usage、最近一次 usage 来源和时间。
- note tool 相关配置字段、resource warning 和 tool category 已移除。

## 进行中

- 暂无正在实施的开发任务。

## 下一步

按优先级排列：

1. **TUI 体验完善**（当前最近完成，有明确待补项）
   - TUI mode 补全所有 slash commands 的输出渲染（当前 `/stats`、`/diagnostics` 等输出是纯文本追加，可考虑格式化）
   - `tui-mode.ts` 设为默认启动（去掉 `--tui` flag，或将其设为默认值），`--no-tui` 回退到 readline mode
   - TUI mode 补全 tool confirmation 的更好展示（当前是简单文本替换 input）
   - `architecture.md` 补充 TUI 框架章节

2. **M3：Headless RPC**
   - JSONL stdin/stdout 协议（`prompt`、`get_state`、`abort`、`new_session`）
   - interactive、print、RPC 共享 `RuntimeHost`

3. **Context Management 补齐**
   - provider API countTokens / model context window 百分比
   - auto compaction 阈值触发
   - prompt-too-long recovery

4. **M4：Session Tree**
   - session entry schema（`id`、`parentId`、`timestamp`）
   - `/fork`、path-aware context rebuild

## 已知问题

- `logger.ts` 仍是占位文件。
- `ResourceLoader` 仍是最小骨架，尚未支持自动监听或更细粒度 reload。
- `ContextManager` 仍未支持完整 token budget、provider API countTokens、model context window、自动策略或 post-compact resource budget。
- manual `/compact` 仍是最小版：没有自动阈值、prompt-too-long recovery 或工具结果 micro-compaction。
- skills、MCP 相关配置字段已解析，但还没有接入 tool/resource loader。
- 当前 `max_steps` 字段名仍偏模糊，后续应迁移为 `max_steps_per_run` 或同类命名。
- RPC mode 尚不存在。
- session history 仍是 flat JSONL，尚未升级为 session tree。
- tool result budget、超大输出持久化、完整 permission pipeline 尚未实现。
- TUI 框架尚未覆盖测试；`src/tui/` 中无单元测试。
- TUI mode 的 `architecture.md` 章节尚未补充。
