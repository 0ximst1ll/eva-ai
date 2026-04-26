# Eve-Agent 全面迭代计划（参考 pi-mono）

## 1. 背景与目标

本文基于对 `pi-mono/packages/coding-agent` 的设计与实现分析，目标是在不直接改动 `pi-mono` 的前提下，将其稳定、可扩展的架构思想迁移到 `Eve-Agent`。

核心目标：

- 建立“内核稳定、壳层可替换”的分层架构
- 让流式事件、会话管理、工具执行具备可观测与可恢复能力
- 为后续 RPC/TUI/扩展系统预留演进空间

## 2. pi-mono 关键设计启发

### 2.1 启动装配与运行时解耦

- `main.ts` 负责参数与模式分发，不承载核心业务
- `agent-session-services.ts` 创建 cwd 绑定的基础设施服务
- `sdk.ts` 创建底层 Agent + AgentSession
- `agent-session-runtime.ts` 统一处理会话替换（new/resume/fork/import）

启发：

- Eve-Agent 需要 `createRuntime()` 层，统一装配 `config + llm + tools + session`

### 2.2 事件驱动内核

- `AgentSession` 负责 prompt 编排、流式处理、扩展钩子、重试与压缩协调
- 壳层（interactive/print/rpc）只订阅事件和发送命令

启发：

- Eve-Agent 需要把当前 `Agent` 中的输出逻辑抽离到 mode 层
- 核心层只发事件，不直接 `console.log`

### 2.3 会话树与 append-only 持久化

- `SessionManager` 采用树结构（id/parentId/leaf）
- JSONL append-only，支持恢复、分叉、上下文解析与摘要压缩

启发：

- Eve-Agent 先实现内存会话管理，再升级 JSONL 持久化
- 逐步支持 `/resume` `/fork` `/clone`

### 2.4 Provider 差异隔离

- `streamFn` 是 provider 聚合入口
- 会话层不感知 provider 细节

启发：

- Eve-Agent 保持 `llm/*-client.ts` 的 provider 适配边界
- 会话层消费统一事件协议

## 3. Eve-Agent 现状诊断

优势：

- 已有统一 Tool 接口：`src/tools/base.ts`
- 已有多 provider 客户端封装：`src/llm/*`
- 已有基础流式事件类型：`src/schema.ts`

主要问题：

- `src/agent.ts` 职责过重（会话状态、流式渲染、工具执行、CLI 输出耦合）
- `src/cli.ts` 装配与交互逻辑混杂
- 缺少会话持久化/恢复/分叉机制
- 缺少 runtime 工厂与诊断收敛层
- 重试实现存在明显缺陷（`src/retry.ts` 的重试边界判断和命名问题）

## 4. 总体架构目标（落地到 Eve-Agent）

建议分层：

- `core`：`AgentSession`、`SessionManager`、`Runtime`
- `llm`：provider 适配与统一事件
- `modes`：`cli`、`print`、`rpc`（后续可扩）
- `tools`：工具实现与治理策略

建议新增核心接口：

- `AgentSessionEvent`：`message_start/content_delta/thinking_delta/tool_call/usage/message_end/error`
- `Runtime`：持有当前 session 与 services，并支持会话替换

## 5. 里程碑计划

### M1（P0）：架构解耦，功能等价

目标：

- 把核心会话逻辑从 `Agent` 中抽离
- 核心层不再直接进行终端输出

交付：

- 新增 `src/core/agent-session.ts`
- CLI 改为事件订阅渲染
- 行为与当前版本保持一致

验收标准：

- 交互式问答、工具调用、取消行为不回归
- 输出内容和当前版本一致（允许格式细节微调）

### M2（P0）：会话管理基础能力

目标：

- 引入统一会话管理与状态边界

交付：

- 新增 `src/core/session-manager.ts`（先内存版）
- 接入 JSONL 持久化版（`~/.eve-agent/sessions/...`）
- CLI 支持 `/new` `/resume` `/history` `/clear`

验收标准：

- 可重启恢复最近会话
- 清空与历史查看不再直接操作裸 `messages` 数组

### M3（P1）：运行时工厂与协议层

目标：

- 建立可复用 runtime 装配与最小 RPC 能力

交付：

- 新增 `src/core/runtime.ts`（`createRuntime()`）
- 新增最小 RPC mode（JSONL stdin/stdout）
- 提供 `prompt/get_state/abort/new_session`

验收标准：

- CLI 与 RPC 共享同一会话内核
- RPC 可稳定驱动多轮对话

### M4（P1/P2）：扩展能力与长期演进

目标：

- 接近 pi-mono 的可扩展内核能力

交付：

- 扩展钩子机制（输入变换、请求前后、工具调用、会话生命周期）
- 上下文压缩（手动 -> 自动）
- 会话树分叉能力（fork/clone/branch summary）

验收标准：

- 扩展可插拔，不破坏核心循环
- 长会话 token 受控，分叉路径上下文正确

## 6. TODO 清单（含优先级）

### P0（必须先做）

- [ ] 抽离 `AgentSession`：迁移推理循环、工具执行、取消控制
- [ ] 定义统一会话事件协议并在核心层发射
- [ ] CLI 改为事件订阅渲染，移除核心层直接输出
- [ ] 新增 `SessionManager` 内存版并接管消息生命周期
- [ ] 新增 `SessionManager` JSONL 持久化版
- [ ] 修复 `src/retry.ts` 的重试边界逻辑与命名问题

### P1（高优先级）

- [ ] 新增 `createRuntime()`，集中装配 config/llm/tools/session
- [ ] 实现最小 RPC mode：`prompt/get_state/abort/new_session`
- [ ] 增加会话命令：`/new` `/resume` `/fork` `/stats`
- [ ] 增加模型/思考级别切换与状态同步
- [ ] 引入工具治理策略（启用集、白名单、风险确认）
- [ ] 建立统一 diagnostics 收集与展示策略

### P2（中优先级）

- [ ] 扩展钩子框架：`before_prompt/after_response/tool_call/session_*`
- [ ] 资源加载器（system prompt/skills/context/mcp）及 reload 机制
- [ ] 上下文压缩（先手动 compact，再自动阈值触发）
- [ ] 会话树分叉与 branch summary 能力
- [ ] 可观测性（timings/trace id/retry metrics）
- [ ] 建立核心回归测试（session/stream/rpc/tool-loop）

### P3（优化项）

- [ ] TUI 交互增强（状态条、工具进度、隐藏 thinking 策略）
- [ ] 安全与权限系统（命令沙盒、路径保护、审计脱敏）

## 7. 建议节奏

- 第 1 周：完成全部 P0（架构解耦 + 会话基础）
- 第 2 周：完成 P1（runtime + rpc + 命令体系）
- 第 3-4 周：推进 P2（扩展 + 压缩 + 分叉 + 测试）
- 第 5 周后：P3（体验与安全加固）

## 8. 风险与回滚策略

- 风险 1：拆分 `Agent` 导致行为回归  
  对策：M1 采用“功能等价迁移”，每步保留旧逻辑对照

- 风险 2：引入持久化后状态不一致  
  对策：先内存版稳定，再接 JSONL；每次会话操作保持 append-only

- 风险 3：RPC 与 CLI 行为漂移  
  对策：强制两者复用同一 `AgentSession` 内核与同一事件协议

