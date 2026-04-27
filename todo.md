# Eva AI TODO（按优先级）

> 当前清单基于对 `pi-mono` 与 `claude-code` 的二次复核更新。旧版总体计划见 `docs/eva-ai-iteration-plan.md`，其中部分现状描述已过期。

## P0（已完成基线）

- [x] 抽离 `AgentSession`（迁移推理循环、工具执行、取消控制）
- [x] 定义统一会话事件协议（`message_start/content_delta/thinking_delta/tool_call/usage/message_end/error`）
- [x] CLI 改为事件订阅渲染，核心层移除直接终端输出
- [x] 新增 `SessionManager` 内存版并接管消息生命周期
- [x] 新增 `SessionManager` JSONL 持久化版
- [x] 修复 `src/retry.ts` 重试边界与命名问题
- [x] CLI 默认创建新 session，不再启动时自动恢复 latest session

## P1（当前优先级：让 Agent 真正可用）

- [x] 新增 `createRuntime()`，统一装配 `config / llm / tools / session / system prompt`
- [ ] 恢复 CLI 工具装配：按配置加载 file tools、bash、note、skills、MCP
- [ ] 建立最小工具治理策略：区分 read-only / write / bash / MCP，支持启用集、禁用集和高风险确认
- [ ] 增加基础会话命令：`/new`、`/resume`、`/history`、`/stats`
- [ ] 建立统一 diagnostics 收集与展示策略，覆盖配置、provider、tools、MCP、session 初始化
- [ ] 建立核心回归测试：session JSONL、tool loop、retry、runtime 创建、CLI 默认新会话

## P2（对齐 pi-mono 的可扩展骨架）

- [ ] 新增 `RuntimeHost`，持有当前 runtime/session，并支持 `newSession()`、`switchSession()`，后续扩展 `fork()`
- [ ] 拆分 mode 层：`interactive-mode`、`print-mode`、`rpc-mode`，CLI 入口只负责参数解析与模式分发
- [ ] 新增 `RuntimeServices`，集中管理 cwd 绑定的 config、resource loader、tool loader、diagnostics 等基础设施
- [ ] 实现最小 RPC mode（JSONL stdin/stdout）：`prompt / get_state / abort / new_session`
- [ ] 让 CLI、print、RPC 共享同一个 RuntimeHost/session 内核，避免双装配路径漂移
- [ ] 增加会话恢复增强：`/resume <id>`、按当前 workspace 列出 session、显示 session id/path
- [ ] 增加模型/思考级别切换与状态同步，并写入 session 事件
- [ ] 增加资源加载器：system prompt / skills / context / MCP config，并支持 reload
- [ ] 引入基础可观测性：tool 耗时、LLM retry 次数、token usage、关键路径 timings
- [ ] 为 RuntimeHost、mode 分发、RPC 协议增加回归测试

## P3（吸收 claude-code 的工程能力）

- [ ] 工具并发编排：为 Tool 增加 `isConcurrencySafe` 或 `riskLevel`，read-only 并发，write/bash 串行
- [ ] MCP 渐进加载：pending -> connected/failed 增量更新，慢连接不阻塞首轮
- [ ] 扩展钩子框架：`before_prompt / after_response / before_tool / after_tool / session_*`
- [ ] 上下文压缩：手动 compact -> 自动阈值触发
- [ ] 升级 `SessionManager` 为 entry tree：每条记录具备 `id / parentId / timestamp`，支持 leaf、branch、fork、context rebuild
- [ ] sidecar metadata：为后续 subagent、todo、file history 等可恢复运行现场预留

## P4（体验与长期治理）

- [ ] TUI 交互增强：状态条、工具进度、隐藏/折叠 thinking、session selector
- [ ] 更完整的权限系统：规则 -> 模式 -> 交互确认；暂不引入 classifier，但保留接口位
- [ ] 安全加固：命令沙盒、路径保护、审计脱敏、危险命令确认
- [ ] 策略开关体系：用配置开关代替硬编码分支，支持实验功能灰度
- [ ] 导出与导入工具：session export/import
