# Eva AI Current

## 当前状态（2026-05-09）

Eva AI 当前处于 M0：稳定当前基线阶段。

当前目标是先确认 runtime/session/mode 的核心路径可靠，再继续推进 `RuntimeServices`、resource loader、RPC、session tree、MCP、skills 等更大的系统能力。

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
- 已明确当前未实现范围，避免把 MCP、skills、RPC、session tree、`RuntimeServices` 等路线图能力误写成已实现能力。
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
- 已修正 `config/system_prompt.md`，避免声明 MCP、skills、note、RPC 等尚未实现能力。
- interactive mode 已实现 `/new`，通过 `RuntimeHost.newSession()` 创建新会话并显示新旧 session id。
- interactive mode 已实现 `/resume` 和 `/resume <id>`，通过 `RuntimeHost` 恢复 latest session 或切换到指定 session。
- interactive mode 已改进 `/history`，显示当前 session id 和 message count。
- interactive mode 已实现 `/stats`，显示当前 session、message count、token usage、provider、model 和 tool count。
- `SessionManager` 已支持列出当前 workspace sessions，interactive mode 已实现 `/sessions`。
- runtime diagnostics 已统一为 `source`、`level`、`code`、`message`、`details` 结构。
- `createRuntime()` 已收集 config、provider、resource、session diagnostics。
- `loadConfiguredTools()` 已返回统一 tools diagnostics。
- 已增加 runtime diagnostics 回归测试。

## 进行中

- 收尾 P1 会话命令与 diagnostics。

## 下一步

优先处理 P1：

- 复核 diagnostics 渲染体验，并决定是否补充 `/diagnostics` 或启动摘要过滤。

## 后续重点计划

- 长任务上下文治理已拆成 `docs/planning.md` 中的 M1.x。
- M1.x 不一定紧接当前 P1 执行，但进入明确路线图。
- M1.x 的方向是对齐 `pi-mono` 的 agent-loop 自然停止语义，不再把固定 `max_steps` 作为 interactive 长任务硬上限。
- 当前 `max_steps` 后续应迁移为 print/headless/RPC 场景下的可选 runaway guard。
- 长任务能力应通过 token accounting、context rebuild、compaction entry 和手动 `/compact` 建立最小闭环。
- 完整 auto-compaction、prompt-too-long recovery、tool result micro-compaction 和 post-compact resource budgets 放入后续 Context Management 增强。

## 已知问题

- `logger.ts` 仍是占位文件。
- `createRuntime()` 职责仍偏多，尚未拆出 `RuntimeServices`。
- resource loading 目前仅限 system prompt，尚未加载 `AGENTS.md` 等项目上下文。
- note、skills、MCP 相关配置字段已解析，但还没有接入 tool/resource loader。
- interactive mode 尚未实现 `/fork`、`/compact`。
- 当前 `max_steps` 仍作为 agent loop 硬停止条件存在，尚未对齐 `pi-mono` 的自然停止语义。
- RPC mode 尚不存在。
- session history 仍是 flat JSONL，尚未升级为 session tree。
- tool result budget、超大输出持久化、完整 permission pipeline 尚未实现。
