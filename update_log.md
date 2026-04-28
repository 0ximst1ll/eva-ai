1. 从eva-ai python版本迁移到typescript版本
2. 支持google-client和流式输出
3. 从agent.ts中抽离出agent-session和session-manager
4. 更名为eva-ai




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