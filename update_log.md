1. 从mini-agent python版本迁移到typescript版本
2. 支持google-client和流式输出
3. 从agent.ts中抽离出agent-session和session-manager
4. 更名为eva-ai
5. 重构工具系统
6. Agent抽象重建




# 核心架构升级

## 抽离AgentSession + SessionManager+ Runtime 

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

这为后续实现禁用集、高风险确认、read-only 并发、write/bash 串行调度打基础。

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

`beforeToolCall / afterToolCall` 为后续高风险确认、权限规则、工具结果改写、审计日志提供统一入口。

**④ 更接近 pi-mono 的后续演进路径**

当前结构已经能自然接 RuntimeHost、mode 分层、resource loader、compaction 和 extension hooks，不需要继续把功能塞进 AgentSession。

---

### 仍待完成

- 高风险工具确认流程
- 更完整的 AgentEvent / message_update 流式状态
- model/thinking state 管理
- RuntimeHost 持有 AgentSession
- interactive / print / rpc mode 分层
- 系统化回归测试

---

### 一句话总结

> Agent 从“Session 里的推理方法”升级为“agent-loop + stateful Agent + session bridge”的三层结构，底层调度语义先稳定下来，后续 RuntimeHost 和多 mode 才有可靠承载点。
