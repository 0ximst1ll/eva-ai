1. 从 mini-agent Python 版本迁移到 TypeScript 版本
2. 支持 google-client 和流式输出
3. 抽离 AgentSession + SessionManager + Runtime
4. 更名为 eva-ai
5. 工具系统升级
6. Agent 抽象重建
7. 工具治理闭环
8. RuntimeHost 基础层
9. mode 分层（interactive / print）




# 核心架构升级

## 抽离 AgentSession + SessionManager + Runtime（早期阶段） 

核心优点是**职责分离**，每一层只做自己该做的事。用对比来说明：

---

### 重构前（旧 Agent 一把抓）

```
Agent
├── 持有 messages 数组（会话状态）
├── 调用 LLM（推理逻辑）
├── 执行工具（工具逻辑）
├── console.log 输出（渲染逻辑）
└── 保存历史（持久化逻辑）
```

所有东西堆在一起，牵一发动全身。

---

### 重构后（三层各司其职）

**`SessionManager`** — 只管数据
- 负责消息的增删改查和持久化
- 不知道 LLM 是什么，不知道工具是什么
- 可以独立测试：给它一组消息，验证存取是否正确

**`AgentSession`** — 只管推理循环
- 负责"问 LLM → 执行工具 → 追加消息"的循环逻辑
- 不知道终端长什么样，只 `emit(event)`
- 不关心消息怎么存，委托给 `SessionManager`

**`Runtime`** — 只管装配
- 负责把 config、llm、tools、session 组装起来
- 是各层之间的"胶水"，统一入口

---

### 带来的具体好处

**① 同一内核，多种前端**

`AgentSession` 不输出任何内容，只发事件，所以同一套推理逻辑可以接不同的"壳"：

```
AgentSession
├── CLI 壳 → console.log 渲染
├── RPC 壳 → 通过 stdin/stdout 发 JSON
└── TUI 壳 → 富文本界面渲染
```

没有分离之前，输出逻辑写死在核心里，无法复用。

**② 会话可以独立管理**

`SessionManager` 独立后，可以做：
- `/resume` — 恢复上次会话
- `/fork` — 从当前会话分叉出新会话
- 多会话并发管理

没有分离之前，`messages` 只是 `Agent` 里的一个数组，无法跨生命周期管理。

**③ 每层可以独立测试**

```typescript
// 只测 SessionManager，不需要启动 LLM
const sm = new SessionManager({ mode: 'memory' });
await sm.createSession('system prompt');
await sm.appendMessage(id, { role: 'user', content: 'hello' });
assert(sm.getMessages(id).length === 2);

// 只测 AgentSession，用 mock LLM
const session = new AgentSession({ llmClient: mockLLM, ... });
```

没有分离之前，测试 Agent 就必须 mock 所有东西。

**④ 重试、取消、错误边界更清晰**

`AgentSession` 负责捕获 `RetryExhaustedError` 并发 `error` 事件，`SessionManager` 负责保证消息写入不丢失，两者的错误边界不交叉，出问题很容易定位在哪一层。

---

### 一句话总结

> 分离让每一层**可以独立演进**——换一种持久化方式不影响推理逻辑，加一种前端不改动核心，测试时可以单独验证每一层。

## 工具系统升级：对齐 pi-mono 的 builtin tools 结构

这次升级的重点不是继续往 `tools/` 里塞更多能力，而是把工具层收敛成稳定的 builtin tool 系统。`MCP / Skills / Note` 这类能力后续会迁到 resource loader、memory 或 extension 层，不再混在 tools 目录里。

---

### 重构前（工具能力混在一起）

```
tools/
├── base.ts
├── bash-tool.ts        # bash / bash_output / bash_kill
├── file-tools.ts       # read / write / edit
├── search-tools.ts     # ls / find / grep
├── mcp-loader.ts       # MCP 连接与工具加载
├── skill-loader.ts     # Skills 发现
├── skill-tool.ts       # get_skill 工具
├── note-tool.ts        # session note 工具
└── tool-registry.ts    # 工具注册与装配
```

问题是工具层边界不清晰：本地 coding tools、外部资源加载、记忆能力、MCP 连接都放在同一个目录里。后续做 RuntimeHost、resource loader、extension 时会互相缠住。

---

### 重构后（pi-mono 风格 builtin tools）

```
tools/
├── index.ts                    # 统一导出、ToolRegistry、builtin tool 装配
├── base.ts                     # Tool / ToolDefinition / metadata
├── bash.ts                     # bash / bash_output / bash_kill
├── read.ts                     # read_file
├── write.ts                    # write_file
├── edit.ts                     # edit_file
├── find.ts                     # find_files
├── grep.ts                     # grep_files
├── ls.ts                       # list_files
├── file-mutation-queue.ts      # 文件写入/编辑串行队列
├── path-utils.ts               # workspace 路径解析与边界保护
├── truncate.ts                 # 输出截断工具
└── tool-definition-wrapper.ts  # ToolDefinition 包装/转换
```

现在 `tools/` 只保留本地 builtin 工具：file/search/bash。MCP 和 Skills 后续由 resource loader 管，Note/Memory 后续由 session metadata 或 memory 层处理。

---

### 带来的具体好处

**① 工具边界更清晰**

`tools/` 只负责能被模型调用的 builtin 操作能力，不再负责 MCP 连接、Skills 扫描、长期记忆这些资源/状态能力。

**② 每个核心工具可以独立演进**

`read / write / edit / find / grep / ls / bash` 都拆成独立模块，后续补测试、替换实现、加 operations 注入时不会继续扩大单个大文件。

**③ 安全边界前移**

文件工具现在统一经过 `path-utils.ts` 做 workspace 边界保护，避免工具读写越出当前工作区。

**④ 写操作串行化**

`write_file` 和 `edit_file` 通过 `file-mutation-queue.ts` 按文件路径串行，避免并发写同一文件时互相覆盖。

**⑤ 工具元数据成为治理入口**

`ToolDefinition / ToolMetadata` 已经包含：
- `category`
- `riskLevel`
- `source`
- `isReadOnly`
- `isConcurrencySafe`
- `requiresConfirmation`

这些元数据已经接入工具治理闭环，支持禁用集、高风险确认和基础并发策略。

**⑥ bash 更接近可控执行**

`bash` 已支持：
- `AbortSignal` 取消
- 进程树终止
- 输出截断
- 完整日志路径

这让长命令、异常命令和大量输出更容易被上层 runtime 管理。

---

### 和 pi-mono 仍然存在的差距

当前只是对齐了目录形态和基础 builtin 工具能力，还没有完全达到 pi-mono 工具系统深度。后续还需要：

- richer `ToolDefinition`：execution mode、prepareArguments、details、prompt metadata
- operations 注入：支持 mock、远程 workspace、容器/SSH 执行
- `edit-diff`：为 TUI/审查确认提供 diff 数据
- read 多内容类型：图片、二进制识别、更完整截断信息
- tool wrapper 分层：区分 ToolDefinition、runtime AgentTool、UI/render adapter

这些已记录到 `todo.md` 的 P2.5，等 RuntimeHost 和 resource loader 稳定后再继续推进。

---

### 一句话总结

> 工具层从“功能杂糅目录”升级为“builtin tool 子系统”——先把边界理清，让后续 RuntimeHost、resource loader、权限治理可以在清晰的接口上继续演进。


## Agent 抽象重建：对齐 pi-mono 的 agent / agent-loop 分层

这次升级把 Eva 原本集中在 `AgentSession` 里的推理循环拆成三层：底层 loop、有状态 Agent、会话持久化桥接。目标是先对齐 pi-mono 的核心 agent 调度语义，再继续做 RuntimeHost 和 mode 分层。

---

### 重构前（AgentSession 承担完整 loop）

`AgentSession` 同时负责：

- 持有/读取消息
- 调用 LLM 流式生成
- 收集 thinking/content/tool_call
- 执行工具
- 追加 assistant/tool 消息到 `SessionManager`
- 发射 CLI 事件
- 处理取消和错误

这让 `AgentSession` 既像 loop，又像 runtime state，又像 session persistence bridge。继续加 RuntimeHost、RPC、TUI 时会越来越难拆。

---

### 重构后（三层拆分）

`core/agent-loop.ts` — 纯推理循环
- 接收 messages、tools、LLM client、signal、callbacks
- 负责 LLM turn、tool calls、事件发射
- 不知道 session 文件，也不依赖 CLI

`core/agent.ts` — 有状态 Agent
- 持有 messages/tools/runtime state
- 提供 `prompt() / continue() / abort() / subscribe() / waitForIdle()`
- 管理 steering/follow-up queue
- 把 queue drain callback 交给 agent-loop

`core/agent-session.ts` — 会话桥接层
- 持有 Agent
- 订阅 AgentLoopEvent
- 把 assistant/tool/input 消息写入 `SessionManager`
- 对 CLI 保持旧的 `AgentSessionEvent` 兼容输出

---

### 双层循环语义

Eva 现在的 `agent-loop` 已支持接近 pi-mono 的双层循环：

```text
outer loop:
  inner loop:
    处理 pending steering messages
    调用 LLM
    执行 tool calls
    turn_end 后再次检查 steering messages

  如果没有 tool calls / steering，则检查 follow-up messages
  有 follow-up 则回到 outer loop
  没有则 agent_end
```

这比之前“runOnce 结束后再处理 queue”的语义更准确：steering 可以在工具批次结束后更及时插入下一轮。

---

### 工具调度治理入口

`AgentLoopConfig` 现在支持：

- `getSteeringMessages`
- `getFollowUpMessages`
- `toolExecution: parallel | sequential`
- `beforeToolCall`
- `afterToolCall`

并且 agent-loop 已基于 `ToolMetadata.isConcurrencySafe` 做基础并发/串行策略：不安全工具批次串行，安全工具可以并行。

---

### 带来的具体好处

**① AgentSession 职责变轻**

`AgentSession` 不再直接承载完整推理循环，而是作为 session persistence bridge 存在。后面 RuntimeHost 可以持有 AgentSession，而 mode 层不需要理解底层 loop。

**② 运行中干预语义更清晰**

steering/follow-up queue 已经下沉到 agent-loop，后续 RPC/TUI 可以在运行中插入消息，而不是等整个 agent loop 完全停止。

**③ hooks 和权限治理有了入口**

`beforeToolCall / afterToolCall` 已用于高风险确认，并继续为权限规则、工具结果改写、审计日志提供统一入口。

**④ 更接近 pi-mono 的后续演进路径**

当前结构已经接入 RuntimeHost，后续可以自然承载 mode 分层、resource loader、compaction 和 extension hooks，不需要继续把功能塞进 AgentSession。

---

### 仍待完成

- 更完整的 AgentEvent / message_update 流式状态
- model/thinking state 管理
- interactive / print / rpc mode 分层
- 系统化回归测试

---

### 一句话总结

> Agent 从“Session 里的推理方法”升级为“agent-loop + stateful Agent + session bridge”的三层结构，底层调度语义已经稳定，并已接入 RuntimeHost 作为后续多 mode 的承载点。



## 工具治理闭环

在工具系统重构之后，进一步把工具元数据接入 runtime 和 agent-loop 的执行策略：

- `enabled_tools / disabled_tools / disabled_categories` 会在工具装配阶段过滤工具，模型不会看到被禁用工具
- `require_confirmation / confirm_risk_levels` 控制高风险工具确认策略
- Runtime 基于 `ToolMetadata.requiresConfirmation / riskLevel` 创建 `beforeToolCall` hook
- CLI 在执行高风险工具前展示工具名、category、risk、参数摘要，并要求用户输入 `y/yes` 才执行
- 没有确认处理器时默认拒绝高风险工具，避免非交互路径静默执行危险操作

这一步让 tools metadata 从“描述信息”变成了真正参与调度的治理入口。

---

## RuntimeHost 基础层：承接 runtime / session 生命周期

这次升级在 `createRuntime()` 之上新增 `RuntimeHost`。目标不是继续扩大 CLI，而是把“当前 runtime / 当前 session / session 切换”收口到一个可复用的核心对象里，给后续 interactive、print、RPC mode 共用同一个入口。

---

### 重构前（CLI 直接持有 runtime/session）

```
cli.ts
├── 调用 createRuntime()
├── 直接持有 runtime.session
├── 直接执行 session.addUserMessage() / session.run()
└── 后续如果加 /new /resume /RPC，需要在 CLI 里继续堆逻辑
```

问题是 CLI 既像入口，又像会话生命周期管理器。继续加 `/new`、`/resume`、print mode、RPC mode 时，很容易出现多套装配路径：交互式一套、非交互一套、RPC 再一套。

---

### 重构后（RuntimeHost 持有当前运行现场）

`core/runtime-host.ts` — runtime/session 持有层
- `RuntimeHost.create()`：创建首个 runtime
- `newSession()`：创建新 session 并切换当前 session
- `resumeLatestSession()`：恢复当前 workspace 的 latest session
- `switchSession(sessionId)`：切换到指定 session
- `runtime`：暴露当前 Runtime
- `session`：暴露当前 AgentSession
- `sessionId`：暴露当前 session id

`core/runtime.ts` — 装配层增强
- `createSessionIfMissing`：指定 session 不存在时是否允许自动创建
- `RuntimeSessionNotFoundError`：严格 resume/switch 时明确报错
- `sessionBaseDir`：支持测试或特殊运行场景隔离 session 存储目录

`cli.ts` — 入口变薄
- 改为持有 `RuntimeHost`
- 当前执行路径通过 `host.session` 访问会话
- 不再直接把 `createRuntime()` 结果当作唯一运行现场

---

### 带来的具体好处

**① session 生命周期有了统一承载点**

`newSession()`、`resumeLatestSession()`、`switchSession()` 不需要散落在 CLI 或未来 RPC mode 里。后续 `/new` 和 `/resume <id>` 可以直接调用 RuntimeHost。

**② 防止错误恢复时误创建 session**

`switchSession(sessionId)` 使用 `createSessionIfMissing: false`。如果 session id 不存在，会抛出 `RuntimeSessionNotFoundError`，不会把拼错的 id 当作新 session 创建出来。

**③ mode 分层有了复用内核**

interactive、print、RPC 后续都可以共享同一个 Host，而不是各自调用 `createRuntime()` 并重复处理 session 切换、确认回调、retry 回调等逻辑。

**④ 测试隔离更容易**

`sessionBaseDir` 让 RuntimeHost/session 测试可以写到 `/tmp`，不污染真实 `~/.eva-ai/sessions`。

---

### 已验证

- `RuntimeHost` 导入检查通过
- `newSession()` / `switchSession()` smoke test 通过
- 缺失 session 且 `createSessionIfMissing: false` 时会抛 `RuntimeSessionNotFoundError`
- `npm run dev` 可以正常启动并退出

---

### 仍待完成

- 拆分 mode 层：`interactive-mode`、`print-mode`、`rpc-mode`
- 在 RuntimeHost 上实现 `/new`、`/resume <id>`、`/history`、`/stats` 等命令入口
- 让 CLI、print、RPC 共享同一个 RuntimeHost/session 内核
- 为 RuntimeHost 和 mode 分发补系统化回归测试

---

### 一句话总结

> RuntimeHost 把 Eva 的运行现场从 CLI 中抽出来，成为 runtime/session 生命周期的统一承载点；后续多 mode 和会话命令可以围绕它扩展，而不是继续堆在 CLI 入口里。

## mode 分层：拆出 interactive / print 入口

这次升级在 RuntimeHost 之后继续收缩 `cli.ts`，把终端交互和单次任务执行拆到 `src/modes/` 下。目标是让 CLI 入口只负责启动参数、RuntimeHost 创建和 mode 分发，而不是继续承载具体运行逻辑。

---

### 重构前（cli.ts 同时负责入口和模式逻辑）

```
cli.ts
├── 创建 RuntimeHost
├── 渲染 diagnostics
├── 定义 CLI renderer
├── 定义工具确认 prompt
├── 处理非交互 task
└── 处理 readline 交互主循环
```

问题是入口和 mode 行为混在一起。后续继续加 print/RPC/TUI 时，CLI 会重新变成“大入口文件”。

---

### 重构后（入口只分发模式）

`src/modes/cli-ui.ts` — CLI 共享 UI 能力
- `createCliRenderer()`：渲染 agent/session events
- `renderRuntimeDiagnostics()`：渲染 runtime diagnostics
- `createToolConfirmationPrompt()`：生成高风险工具确认回调

`src/modes/interactive-mode.ts` — 交互模式
- 承接原 readline 主循环
- 处理 `/clear`、`/history`、退出命令
- 将工具确认 prompt 注册给 RuntimeHost 的确认回调闭包
- 通过 `host.session` 执行当前会话

`src/modes/print-mode.ts` — 单次任务模式
- 接收命令行 task
- 追加用户消息并运行当前 session
- 复用同一套 CLI renderer

`src/cli.ts` — 入口分发
- 创建 RuntimeHost
- 渲染 diagnostics
- 有命令行参数时进入 print mode
- 无命令行参数时进入 interactive mode

---

### 带来的具体好处

**① CLI 入口变薄**

`cli.ts` 不再直接维护 readline 主循环和渲染细节，后续继续加模式时不会把入口文件重新撑大。

**② interactive 和 print 共享 RuntimeHost**

两个 mode 都通过 `host.session` 工作，不再各自装配 runtime/session。

**③ UI 逻辑可复用**

事件渲染、diagnostics 渲染、工具确认 prompt 已抽到 `cli-ui.ts`，后续 RPC/TUI 可以选择复用或替换这一层。

**④ RPC mode 有了清晰落点**

下一步可以直接新增 `rpc-mode.ts`，复用 RuntimeHost，同时避免影响 interactive/print。

---

### 已验证

- `src/modes/index.ts` / `print-mode.ts` 导入检查通过
- `npm run dev` 可以正常进入 interactive mode 并退出

---

### 仍待完成

- 新增 `rpc-mode.ts`，实现最小 JSONL stdin/stdout 协议
- CLI 参数解析正规化：显式 `--print` / `--rpc` / 默认 interactive
- 将 `/new`、`/resume <id>`、`/stats` 等命令接到 RuntimeHost
- 为 mode 分发补回归测试

---

### 一句话总结

> mode 分层把 Eva 的入口从“一个 CLI 文件包办所有运行方式”推进到“CLI 分发 + mode 承载行为”的结构；interactive 和 print 已共享 RuntimeHost，RPC 可以在同一骨架上继续接入。
