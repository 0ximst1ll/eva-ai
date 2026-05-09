# Eva AI Current

## 当前状态（2026-05-09）

Eva AI 当前处于 M0：稳定当前基线阶段。

当前目标是先确认 runtime/session/mode 的核心路径可靠，再继续推进 resource loader、ContextBuilder、RPC、session tree、MCP、skills 等更大的系统能力。

## 已完成

- 已将旧架构文档重命名为 `docs/architecture.md`。
- 已更新 `docs/architecture.md`，使其匹配当前代码事实。
- 已明确当前 runtime 主要路径：
  - `cli.ts`
  - `RuntimeHost`
  - `createRuntime()`
  - `AgentSession`
  - `Agent`
  - `runAgentLoop()`
- 已明确当前未实现范围，避免把 MCP、skills、RPC、session tree 等路线图能力误写成已实现能力。
- 已新增 `docs/planning.md`，记录 Eva AI 的项目目标和参考策略。
- 当前 interactive 和 print modes 已共享 `RuntimeHost` 与同一套 runtime/session 路径。
- 当前已有 JSONL session persistence、builtin file/search/bash tools、tool registry、高风险工具 confirmation hook、abort 和 queue 基础能力。
- 已增加真实 `test` script，使用 Node test runner + `tsx` 执行 TypeScript 回归测试。
- 已增加 `typecheck` script 和 `tsconfig.json`，使用 `tsc --noEmit` 做静态检查。
- 已增加 retry 行为回归测试。
- 已增加 `SessionManager` memory/jsonl 持久化测试。
- 已增加 agent-loop tool-call continuation 测试。
- 已增加 `RuntimeHost` new/resume/switch 测试。
- 已增加 abort 与 steering/follow-up queue 测试。
- 已修正 `config/system_prompt.md`，避免声明 MCP、skills、RPC 等尚未实现能力。
- interactive mode 已实现 `/new`，通过 `RuntimeHost.newSession()` 创建新会话并显示新旧 session id。
- interactive mode 已实现 `/resume` 和 `/resume <id>`，通过 `RuntimeHost` 恢复 latest session 或切换到指定 session。
- interactive mode 已改进 `/history`，显示当前 session id 和 message count。
- interactive mode 已实现 `/stats`，显示当前 session、message count、token usage、provider、model 和 tool count。
- `SessionManager` 已支持列出当前 workspace sessions，interactive mode 已实现 `/sessions`。
- runtime diagnostics 已统一为 `source`、`level`、`code`、`message`、`details` 结构。
- `createRuntime()` 已收集 config、provider、resource、session diagnostics。
- `loadConfiguredTools()` 已返回统一 tools diagnostics。
- 启动 diagnostics 默认过滤普通 `info`，保留 warning/error 和关键 info。
- interactive mode 已实现 `/diagnostics`，用于查看完整 runtime diagnostics。
- 已新增 `RuntimeServices`，承载 workspace 绑定的 config、provider、tools、session manager 和 diagnostics。
- `createRuntime()` 已改为基于 `RuntimeServices` 创建当前 `AgentSession`。
- 已新增轻量 `ResourceLoader`，承载 system prompt 和 `AGENTS.md` 项目上下文加载。
- `RuntimeServices` 已暴露 `resourceLoader`。
- 已新增最小 `ContextBuilder`，在 LLM call 前构造 request messages。
- `AGENTS.md` 已作为 transient project context 注入模型请求，不写回 session history。
- `RuntimeServices` 已暴露 `contextBuilder`，并增加 context diagnostics。
- `ContextBuilder` 已记录最近一次 context build 摘要。
- `ContextBuilder` 已支持 `project_context_max_chars` 字符预算，默认 20000。
- 超出预算的 project context 会被截断；预算过小时会跳过注入并记录原因。
- interactive mode 的 `/stats` 和 `/diagnostics` 已展示 project context 数量、来源和最近一次 build 状态。
- note tool 相关配置字段、resource warning 和 tool category 已移除。
- 已增加 runtime diagnostics 回归测试。
- 已增加 diagnostics 渲染和 `/diagnostics` 命令测试。
- 已增加 `RuntimeServices` 回归测试。
- 已增加 `ResourceLoader` 回归测试。
- 已增加 `ContextBuilder`、agent-loop transient context 和 AgentSession 持久化边界回归测试。

## 进行中

- 推进 M2 `RuntimeServices` 与 Resource Loader。
- ContextBuilder 最小闭环、diagnostics 展示和 project context budget 已完成，继续评估 resource reload 的优先级。

## 下一步

优先处理 ContextBuilder 后续收敛：

- 评估是否先做 resource reload，或进入 manual `/compact` 和 ContextManager。
- 后续再补 manual `/compact` 和 ContextManager。

## 后续重点计划

- 长任务上下文治理已拆成 `docs/planning.md` 中的 M1.x。
- M1.x 不一定紧接当前 P1 执行，但进入明确路线图。
- M1.x 的方向是对齐 `pi-mono` 的 agent-loop 自然停止语义，不再把固定 `max_steps` 作为 interactive 长任务硬上限。
- ContextBuilder 是 M1.x 的前置最小闭环，用来把资源加载和模型请求上下文构造分开。
- ContextManager 后续负责 token budget、summary、manual/auto compaction、prompt-too-long recovery 和 post-compact reinjection。
- 当前 `max_steps` 后续应迁移为 print/headless/RPC 场景下的可选 runaway guard。
- 长任务能力应通过 token accounting、context rebuild、compaction entry 和手动 `/compact` 建立最小闭环。
- 完整 auto-compaction、prompt-too-long recovery、tool result micro-compaction 和 post-compact resource budgets 放入后续 Context Management 增强。

## 已知问题

- `logger.ts` 仍是占位文件。
- `ResourceLoader` 仍是最小骨架，尚未支持 reload 或预算控制。
- `ContextBuilder` 仍是最小骨架，尚未支持完整 token budget、summary、compaction reinjection 或 provider token estimation。
- skills、MCP 相关配置字段已解析，但还没有接入 tool/resource loader。
- interactive mode 尚未实现 `/fork`、`/compact`。
- 当前 `max_steps` 仍作为 agent loop 硬停止条件存在，尚未对齐 `pi-mono` 的自然停止语义。
- RPC mode 尚不存在。
- session history 仍是 flat JSONL，尚未升级为 session tree。
- tool result budget、超大输出持久化、完整 permission pipeline 尚未实现。
