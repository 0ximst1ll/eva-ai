# Eva AI Current

## 当前状态（2026-05-06）

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

## 进行中

- 稳定 M0 当前基线。
- 梳理 M0/M1 的下一批可执行任务。

## 下一步

优先处理 P0：

- 增加真实 `test` script。
- 增加 `typecheck` script。
- 增加 retry 行为回归测试。
- 增加 `SessionManager` memory/jsonl 持久化测试。
- 增加 agent-loop tool-call continuation 测试。
- 增加 `RuntimeHost` new/resume/switch 测试。
- 增加 abort 与 steering/follow-up queue 测试。

随后推进 P1：

- 实现 `/new`。
- 实现 `/resume` 和 `/resume <id>`。
- 改进 `/history`，显示 session id 和 message count。
- 实现 `/stats`。
- 显示当前 workspace 下的 session list。
- 收敛 config、provider、tools、session、resource diagnostics。

## 已知问题

- 还没有真正的测试脚本。
- 还没有 `typecheck` 脚本。
- 当前缺少覆盖核心 runtime/session/tool loop 的回归测试。
- `logger.ts` 仍是占位文件。
- `createRuntime()` 职责仍偏多，尚未拆出 `RuntimeServices`。
- resource loading 目前仅限 system prompt，尚未加载 `AGENTS.md` 等项目上下文。
- `config/system_prompt.md` 可能仍描述了 MCP/skills 等当前未实现能力，需要修正。
- note、skills、MCP 相关配置字段已解析，但还没有接入 tool/resource loader。
- interactive mode 尚未实现 `/new`、`/resume`、`/stats`、`/fork`、`/compact`。
- RPC mode 尚不存在。
- session history 仍是 flat JSONL，尚未升级为 session tree。
- tool result budget、超大输出持久化、完整 permission pipeline 尚未实现。
