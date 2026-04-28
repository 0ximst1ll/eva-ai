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
- [x] 恢复 CLI 工具装配：按配置加载 builtin file/search/bash tools（MCP/skills 后续迁入 resource loader）
- [ ] 建立最小工具治理策略：区分 read-only / write / bash / MCP，支持启用集、禁用集和高风险确认
  - [x] 按 pi-mono 风格拆分 tools 结构，新增 `ToolDefinition / ToolRegistry` 与工具元数据
  - [x] 为文件写入/编辑增加串行写操作队列
  - [x] 补齐只读搜索工具：`list_files / find_files / grep_files`
  - [x] 增强 bash：`AbortSignal`、进程树终止、输出截断、完整日志路径
  - [ ] 基于工具元数据实现真正的禁用集、并发策略和高风险确认
- [ ] 增加基础会话命令：`/new`、`/resume`、`/history`、`/stats`
- [ ] 建立统一 diagnostics 收集与展示策略，覆盖配置、provider、tools、MCP、session 初始化
- [ ] 建立核心回归测试：session JSONL、tool loop、retry、runtime 创建、CLI 默认新会话

## P1.5（Agent 抽象重建，先规划，RuntimeHost 前后落地）

- [x] 标记当前 `src/agent.ts` 为 legacy/deprecated，明确它只是旧兼容外壳，不再作为主路径扩展
- [x] 新增底层 `core/agent-loop.ts`：拆出纯推理循环，负责 LLM turn、tool call 执行、事件发射，不直接管理 session 文件或 CLI 输出
- [x] 新增新的 `core/agent.ts`：有状态 Agent，持有 messages/tools/runtime state，提供 `prompt() / continue() / abort() / subscribe() / waitForIdle()`
- [x] 为 Agent 增加 steering/follow-up queue，并下沉到 agent-loop 双层循环中处理
- [x] 将 `AgentSession` 收缩为会话/持久化/工作区绑定层：订阅 Agent 事件并写入 `SessionManager`，不再直接承载完整 loop
- [x] 统一 AgentEvent 协议基础版：补齐 `agent_start / turn_start / tool_execution_start / tool_execution_end / turn_end / agent_end` 等更细事件
- [x] AgentLoop 双层循环：支持 inner tool loop + steering 注入、outer follow-up loop
- [x] 将 tool 调度治理迁入 agent-loop：支持 `toolExecution`、`beforeToolCall`、`afterToolCall`、`ToolMetadata.isConcurrencySafe` 并发/串行基础策略
- [ ] 高风险工具确认：基于 `ToolMetadata.requiresConfirmation / riskLevel` 接入用户确认流程
- [ ] 让 RuntimeHost 持有 `AgentSession`，由 `AgentSession` 持有/管理 Agent，CLI/print/RPC 不直接操作底层 AgentLoop
- [ ] 为新 Agent 抽象增加回归测试：prompt、continue、abort、queue、tool loop、事件顺序、session 持久化桥接

## P2（对齐 pi-mono 的可扩展骨架）

- [ ] 新增 `RuntimeHost`，持有当前 runtime/session，并支持 `newSession()`、`switchSession()`，后续扩展 `fork()`
- [ ] 拆分 mode 层：`interactive-mode`、`print-mode`、`rpc-mode`，CLI 入口只负责参数解析与模式分发
- [ ] 新增 `RuntimeServices`，集中管理 cwd 绑定的 config、resource loader、tool loader、diagnostics 等基础设施
- [ ] 实现最小 RPC mode（JSONL stdin/stdout）：`prompt / get_state / abort / new_session`
- [ ] 让 CLI、print、RPC 共享同一个 RuntimeHost/session 内核，避免双装配路径漂移
- [ ] 增加会话恢复增强：`/resume <id>`、按当前 workspace 列出 session、显示 session id/path
- [ ] 增加模型/思考级别切换与状态同步，并写入 session 事件
- [ ] 增加资源加载器：system prompt / skills / context / MCP config，并支持 reload（MCP/skills 不再放在 tools 目录）
- [ ] 引入基础可观测性：tool 耗时、LLM retry 次数、token usage、关键路径 timings
- [ ] 为 RuntimeHost、mode 分发、RPC 协议增加回归测试

## P2.5（tools 后续升级，等 RuntimeHost/resource loader 稳定后再做）

- [ ] ToolDefinition 深化：补充 execution mode、prepareArguments、tool details、prompt metadata 等字段
- [ ] Operations 注入：为 read/write/edit/bash 增加可替换后端，支持测试 mock、远程 workspace、容器/SSH 执行
- [ ] edit-diff：新增编辑 diff 生成与展示数据，为后续 TUI/审查确认做准备
- [ ] read 能力增强：支持图片/二进制识别、多内容类型返回、更统一的截断详情
- [ ] bash 能力增强：流式 onUpdate、shell/env 配置、可配置日志目录、长输出查看命令
- [ ] tool wrapper 深化：区分 ToolDefinition、runtime AgentTool、UI/render adapter，避免 index.ts 承担过多职责
- [ ] path/truncate/search 公共能力打磨：忽略规则配置、glob 支持、二进制文件跳过、结果排序策略

## P3（吸收 claude-code 的工程能力）

- [ ] 工具并发编排：已具备 `isConcurrencySafe / riskLevel` 与文件写队列，待实现 AgentSession 层 read-only 并发、write/bash 串行调度
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
