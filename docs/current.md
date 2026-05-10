# Eva AI Current

## 当前状态（2026-05-10）

Eva AI 当前已完成 M0 基线稳定、M2 RuntimeServices / ResourceLoader 主要骨架、manual `/compact` 最小闭环、Context diagnostics 最小展示，以及 assistant usage 持久化最小闭环。

当前计划启动 TUI 实现：采用 pi-mono 风格的轻量自研 TUI 方案（差分渲染引擎 + 原生 TypeScript 组件），逐步替换当前 readline interactive mode。

## 已完成

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
- interactive mode 的 `/stats` 和 `/diagnostics` 已展示 project context 数量、来源和最近一次 build 状态。
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
- TUI 调研已完成：评估了 pi-mono（自研 TS）、claude-code/gemini-cli（Ink fork）、OpenCode（OpenTUI/Zig）、Codex（ratatui/Rust）等方案，确定采用 pi-mono 风格自研路线。
- **TUI 实现 Phase 0 基础设施已完成**：
  - 实现了 `src/tui/terminal.ts` (`ProcessTerminal`，控制 raw mode)。
  - 实现了 `src/tui/tui.ts` 差分渲染引擎。
  - 实现了 `src/tui/components/text.ts` 和 `editor.ts`。
  - 实现了 `src/modes/tui-mode.ts` 并连通了 RuntimeHost 和 slash commands。
  - CLI 已支持 `--tui` 和 `EVA_TUI=1` 启动参数。

- **TUI 实现 Phase 1 流式渲染与 Markdown 已完成**：
  - 引入了 `marked` 库。
  - 实现了 `Markdown` 组件，将 AST 转换为 ANSI 着色的文本行。
  - 实现了 `Loader` 组件，支持 80ms 的 spinner 动画，并主动触发 TUI 重绘。
  - 实现了 `AssistantMessage` 复合组件，协调 `thinking`、`content` 和 `loader` 的组合渲染，支持流式内容追加。
  - 在 `tui-mode.ts` 中完成了 `AgentSessionEvent` 到 `AssistantMessage` 的状态映射。

- **TUI 实现 Phase 2 工具执行展示与交互覆盖层（Overlay）已完成**：
  - 实现了 `ToolExecution` 组件，支持 `[ ] Running...` 动画和 `[v] Result...` 的内联状态切换。
  - 实现了 `ConfirmationDialog` 确认框组件，可在拦截高风险工具时渲染在当前输出流的最下方。
  - 结合 `tui-mode.ts` 和 `tui.ts` 底部 diff 清理特性，无需重写复杂的 z-index 绝对定位 Overlay 系统，直接利用组件挂载和卸载实现了无缝的底部确认框拦截。

## 进行中

- TUI 基础设施与核心体验均已完成，准备进入 Phase 3。

## 下一步

### TUI Phase 3：Editor 完善 + Footer

目标：编辑体验完善。

1. **[已完成]** Editor 升级为多行（word-wrap、左右光标移动）
2. **[已完成]** 实现 Footer 组件（model、token usage、session info）
3. **[已完成]** 实现 slash command 自动补全
4. **[已完成]** 实现 Header 组件

验收：编辑体验流畅，有完整的状态信息展示。

## 后续重点计划

- TUI Phase 4：主题系统、代码高亮、diff 展示优化、Kitty keyboard protocol。
- provider token estimation 或 ContextManager 最小骨架。
- auto compaction、prompt-too-long recovery 和 post-compact resource budget。
- MCP loader、skills loader。
- RPC mode。
- session tree / fork。

## 已知问题

- `logger.ts` 仍是占位文件。
- `ResourceLoader` 仍是最小骨架，尚未支持自动监听或更细粒度 reload。
- `ContextBuilder` 仍未支持完整 token budget、provider token estimation 或 post-compact resource budget。
- manual `/compact` 仍是最小版：没有自动阈值、prompt-too-long recovery 或工具结果 micro-compaction。
- skills、MCP 相关配置字段已解析，但还没有接入 tool/resource loader。
- 当前 `max_steps` 字段名仍偏模糊，后续应迁移为 `max_steps_per_run` 或同类命名。
- RPC mode 尚不存在。
- session history 仍是 flat JSONL，尚未升级为 session tree。
- tool result budget、超大输出持久化、完整 permission pipeline 尚未实现。
- `src/tui/` 目录尚不存在，TUI 代码尚未开始编写。
