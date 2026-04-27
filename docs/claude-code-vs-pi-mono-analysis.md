# claude-code 架构分析与 pi-mono 对比（面向 Eva AI）

## 1. 结论先行

- `claude-code` 的核心优势是工程化深度：并发工具编排、分层权限策略、会话恢复细节、MCP 渐进接入、指标与特性开关体系都较完整。
- `pi-mono` 的核心优势是内核边界清晰：`runtime / services / session / modes` 分层明确，长期可维护性与可演进性更强。
- 对 `eva-ai` 而言，最佳路径不是“二选一”，而是“以 `pi-mono` 为架构骨架，吸收 `claude-code` 的治理能力”。

## 2. claude-code 架构拆解

### 2.1 启动与状态模型

- 在 headless 分支中，`main.tsx` 先构造 `headlessInitialState`，再通过轻量 store 管理状态。
- store 为最小实现：`getState/setState/subscribe`，`setState` 只在引用变化时触发更新和订阅通知。
- 该方案降低了状态耦合，便于把 MCP、权限上下文、任务状态拼入同一个状态容器。

对应代码：

- `src/main.tsx`（headless 初始化与状态装配）
- `src/state/store.ts`

### 2.2 工具执行编排（并发 + 串行）

- `runTools()` 会先按“是否并发安全”分批：只读工具批量并发，写操作工具串行。
- 并发批次先缓存 context modifier，再按原顺序回放，避免并发导致上下文更新竞态。
- 并发上限由环境变量控制，避免无限并发压垮系统。

对应代码：

- `src/services/tools/toolOrchestration.ts`

### 2.3 权限系统（规则 + 分类器 + 交互）

- `hasPermissionsToUseTool()` 先跑规则与模式，再在 auto mode 下按条件触发 classifier。
- auto mode 下存在“快速放行路径”（acceptEdits 判定、safe allowlist），降低分类器成本。
- 对高风险场景（如非 classifier-approvable safetyCheck）保持 fail-closed，且在无交互上下文时可直接 deny。
- `useCanUseTool()` 将 config 判定、协调器、swarm、交互对话串为统一决策管线。

对应代码：

- `src/utils/permissions/permissions.ts`
- `src/utils/permissions/permissionSetup.ts`
- `src/hooks/useCanUseTool.tsx`

### 2.4 会话持久化与恢复

- transcript 采用 JSONL 路径规则，按 `project + sessionId` 组织。
- 除主 transcript 外，还维护 agent metadata / remote-agent metadata sidecar 文件，提升恢复保真度。
- 恢复逻辑不仅恢复消息，还恢复 file history、attribution、todo 等衍生状态。

对应代码：

- `src/utils/sessionStorage.ts`
- `src/utils/sessionRestore.ts`
- `src/history.ts`

### 2.5 MCP 连接策略（渐进 + 超时兜底）

- print/headless 模式下通过 `connectMcpBatch()` 先推 pending 客户端，再按 server settle 增量更新 tools/commands。
- 对 claude.ai 连接设置超时窗口，超时后不阻塞首轮，后台继续连接。
- 对 plugin/connector 重复项做签名去重，并清理重复客户端与资源引用。

对应代码：

- `src/main.tsx`（`connectMcpBatch` 及 claude.ai dedup/timeout）

## 3. 与 pi-mono 的核心差异

### 3.1 架构重心

- `pi-mono`：内核分层优先，`main.ts -> runtime factory -> services -> session -> mode` 路径清晰。
- `claude-code`：业务能力优先，主流程中集成大量策略与 feature gate，功能密度高。

### 3.2 mode 复用方式

- `pi-mono`：`print/rpc/interactive` 明确复用同一个 `AgentSessionRuntime`。
- `claude-code`：也存在共享状态与复用，但在启动主流程中策略分支更多，理解成本更高。

### 3.3 会话管理粒度

- `pi-mono`：围绕 session lifecycle（new/resume/fork/import）抽象 `AgentSessionRuntime`。
- `claude-code`：围绕“可恢复运行现场”扩展，除了会话消息还管理 todo、attribution、remote-agent metadata 等。

### 3.4 安全策略深度

- `pi-mono`：当前偏“基础可用”的权限和运行边界控制。
- `claude-code`：形成多层权限防线（规则、模式、分类器、交互、无交互 deny）。

## 4. 优劣势对比

### 4.1 claude-code

优势：

- 工具编排成熟：并发/串行混合执行能显著优化首轮与多工具场景性能。
- 权限治理完善：对 auto mode、headless、安全兜底处理细致。
- 恢复能力强：恢复的不只是消息，还包含较完整运行上下文。
- MCP 工程化强：连接、去重、超时与渐进可用性平衡得好。

劣势：

- 主流程复杂度高：`main.tsx` 承担大量策略与分支，阅读和二次开发门槛高。
- feature flag 较重：行为受构建条件与 gate 影响较大，定位问题成本高。
- 部分模块耦合偏“横向扩展”：能力很强，但抽象层次不总是最简洁。

### 4.2 pi-mono

优势：

- 架构边界清晰：runtime/session/services/modes 职责清楚，适合持续演进。
- 心智模型统一：mode 仅负责 I/O，核心行为集中在 session/runtime。
- 迁移和扩展成本低：新增 mode 或替换外壳不容易破坏核心。

劣势：

- 工程治理深度相对轻：在权限策略、恢复细节、运营级指标上不如 claude-code 完整。
- 对复杂生产场景的“防御性机制”还可继续增强。

## 5. Eva AI 可直接学习的点（按优先级）

### P0（立即落地）

1. 采用 `pi-mono` 的 runtime/session 分层骨架  
   目标：先解耦 `src/agent.ts` 的“推理 + 工具 + 输出 + 状态”混杂问题。

2. 引入 `claude-code` 的工具编排思想  
   目标：在不破坏语义前提下，支持“只读工具并发、写工具串行”。

3. 核心层事件化，UI/CLI 订阅渲染  
   目标：让 `AgentSession` 只发事件，不直接 `console.log`。

### P1（高优先级）

1. 引入分层权限管线（规则 -> 模式 -> 交互）  
   先做简化版，不上分类器；保留 future slot。

2. 会话持久化升级为 JSONL + sidecar metadata  
   先实现 transcript，再增加 agent metadata（如子任务上下文）。

3. MCP 接入改为“渐进可用”  
   pending -> connected 增量更新，慢连接不阻塞首轮。

### P2（中优先级）

1. 加入可观测性基线  
   至少覆盖工具耗时、重试次数、token 使用、关键路径 checkpoint。

2. 加入恢复增强  
   除消息外恢复 todo/file-history 等衍生状态。

3. 预留策略开关体系  
   用配置开关代替硬编码分支，为后续实验功能留出灰度空间。

## 6. 推荐组合策略（给 Eva AI）

- 架构层：优先对齐 `pi-mono`，保证长期可维护。
- 执行层：吸收 `claude-code` 的并发工具编排和 MCP 渐进接入。
- 治理层：逐步引入 `claude-code` 风格权限管线与恢复体系。
- 节奏上保持“先骨架、后能力、再治理”，避免一开始被复杂策略拖垮。

## 7. 与现有迭代计划的关系

- 本文与 `docs/eva-ai-iteration-plan.md` 互补：
  - 该计划文档负责里程碑与任务分解；
  - 本文负责“为什么这样做”与“从 claude-code 具体学什么”。
- 建议后续在每个里程碑的验收清单中，加入本文对应学习项的完成状态。
