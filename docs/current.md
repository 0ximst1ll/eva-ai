# Eva AI Current

## 当前状态（2026-05-11）

Eva AI 当前已完成 M0 基线稳定、M2 RuntimeServices / ResourceLoader 主要骨架、manual `/compact` 最小闭环、Context diagnostics 最小展示、assistant usage 持久化最小闭环、最小 `ContextManager` diagnostics 聚合、本地 request token estimation、可选 context usage percent，以及规划文档中的长期架构域视图整理。

刚完成的任务是在不引入完整 context budget engine 的前提下，为 `ContextManager` 增加可选 model context window 与 usage percent 诊断。先通过 `context_window_tokens` 配置提供窗口大小，用本地 request token estimate 计算百分比；暂不接入 provider API countTokens 或自动压缩策略。

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
- `ContextBuilder` 已记录最近一次 request messages 和 project context 的本地 token estimate。
- `ContextManager` 已作为最小状态聚合器，汇总 `ContextBuilder.latestBuild`、active messages、step guard、compaction、usage、project context metadata、本地 token estimate 和可选 context usage percent。
- interactive mode 的 `/stats` 和 `/diagnostics` 已通过 `ContextManager` 展示 project context 数量、来源、token estimate、context usage percent 和最近一次 build 状态。
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

- 后续评估 provider API countTokens。
- 后续基于 context window 设计 auto compaction 阈值配置。
- 后续再实现 auto compaction、prompt-too-long recovery 和 post-compact resource budget。
- 规划 print/headless/RPC 场景下 permission pending 的处理策略。

## 后续重点计划

- 当前 manual `/compact` 只做最小闭环，不实现自动阈值 compaction。
- ContextManager 后续再承接 token accounting、auto compaction、prompt-too-long recovery 和 post-compact resource reinjection。
- 当前 `max_steps` 后续应进一步迁移为 print/headless/RPC 场景下的命名更明确的可选 runaway guard。
- 长任务能力应通过 token accounting、context rebuild、compaction entry 和手动 `/compact` 逐步建立。
- 完整 session tree、fork、clone 和 path-aware context rebuild 放入后续 session model 阶段。

## 已知问题

- `logger.ts` 仍是占位文件。
- `ResourceLoader` 仍是最小骨架，尚未支持自动监听或更细粒度 reload。
- `ContextManager` 仍未支持完整 token budget、provider API countTokens、自动策略或 post-compact resource budget。
- manual `/compact` 仍是最小版：没有自动阈值、prompt-too-long recovery 或工具结果 micro-compaction。
- skills、MCP 相关配置字段已解析，但还没有接入 tool/resource loader。
- 当前 `max_steps` 字段名仍偏模糊，后续应迁移为 `max_steps_per_run` 或同类命名。
- RPC mode 尚不存在。
- session history 仍是 flat JSONL，尚未升级为 session tree。
- tool result budget、超大输出持久化、完整 permission pipeline 尚未实现。
