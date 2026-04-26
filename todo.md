# Eve-Agent TODO（按优先级）

参考规划文档：`docs/eve-agent-iteration-plan.md`

## P0（必须先做）

- [x] 抽离 `AgentSession`（迁移推理循环、工具执行、取消控制）
- [x] 定义统一会话事件协议（`message_start/content_delta/thinking_delta/tool_call/usage/message_end/error`）
- [x] CLI 改为事件订阅渲染，核心层移除直接终端输出
- [x] 新增 `SessionManager` 内存版并接管消息生命周期
- [x] 新增 `SessionManager` JSONL 持久化版
- [x] 修复 `src/retry.ts` 重试边界与命名问题

## P1（高优先级）

- [ ] 新增 `createRuntime()` 统一装配 `config/llm/tools/session`
- [ ] 实现最小 RPC mode（`prompt/get_state/abort/new_session`）
- [ ] 增加会话命令：`/new` `/resume` `/fork` `/stats`
- [ ] 增加模型/思考级别切换与状态同步
- [ ] 引入工具治理策略（启用集、白名单、风险确认）
- [ ] 建立统一 diagnostics 收集与展示策略

## P2（中优先级）

- [ ] 扩展钩子框架（`before_prompt/after_response/tool_call/session_*`）
- [ ] 资源加载器（system prompt/skills/context/mcp）及 reload 机制
- [ ] 上下文压缩（手动 compact -> 自动阈值触发）
- [ ] 会话树分叉与 branch summary 能力
- [ ] 可观测性（timings/trace id/retry metrics）
- [ ] 建立核心回归测试（session/stream/rpc/tool-loop）

## P3（优化项）

- [ ] TUI 交互增强（状态条、工具进度、隐藏 thinking 策略）
- [ ] 安全与权限系统（命令沙盒、路径保护、审计脱敏）
