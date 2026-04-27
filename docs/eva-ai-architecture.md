# Eva AI 架构文档

> 每次架构有实质变化时更新此文档。

---

## 当前版本（2026-04-27）

### 目录结构

```
Eva AI/
├── config/
│   ├── config.yaml            # 主配置（api_key / model / tools 开关等）
│   ├── config-example.yaml    # 配置示例
│   ├── mcp-example.json       # MCP 服务器配置示例
│   └── system_prompt.md       # 默认系统提示词
├── src/
│   ├── cli.ts                 # 入口：装配 + 交互式/非交互式 CLI 主循环
│   ├── agent.ts               # Agent 外壳：封装 AgentSession + SessionManager
│   ├── config.ts              # Config 类：读取 YAML 配置，提供结构化 ConfigData
│   ├── schema.ts              # 全局类型定义（Message / LLMResponse / AgentSessionEvent 等）
│   ├── retry.ts               # RetryConfig + withRetry 高阶函数 + RetryExhaustedError
│   ├── logger.ts              # 日志（占位，待完善）
│   ├── core/
│   │   ├── agent-session.ts   # AgentSession：推理循环 + 流式处理 + 工具执行
│   │   └── session-manager.ts # SessionManager：内存/JSONL 双模式会话持久化
│   ├── llm/
│   │   ├── base.ts            # LLMClientBase 抽象类
│   │   ├── llm-client.ts      # LLMClient 统一门面（provider 路由 + apiBase 标准化）
│   │   ├── anthropic-client.ts# Anthropic provider 适配
│   │   ├── openai-client.ts   # OpenAI provider 适配
│   │   └── google-client.ts   # Google Gemini provider 适配
│   ├── tools/
│   │   ├── base.ts            # Tool 接口 + toOpenAISchema / toAnthropicSchema
│   │   ├── bash-tool.ts       # bash / bash_output / bash_kill（含后台 Shell 管理）
│   │   ├── file-tools.ts      # read_file / write_file / edit_file
│   │   ├── note-tool.ts       # note 笔记工具
│   │   ├── mcp-loader.ts      # MCP 服务器连接与工具加载（stdio / SSE / HTTP）
│   │   ├── skill-loader.ts    # SKILL.md 技能发现与加载
│   │   └── skill-tool.ts      # skill 工具（将技能注入上下文）
│   └── utils/
│       └── terminal.ts        # ANSI 颜色常量 + 终端显示宽度计算
└── docs/
    ├── eva-ai-architecture.md
    └── eva-ai-iteration-plan.md
```

### 架构分层图

```
┌─────────────────────────────────────────────────────────────┐
│                       入口 / 壳层                            │
│                                                             │
│   cli.ts                                                    │
│   ├── 读取 Config（config.yaml）                             │
│   ├── 装配 LLMClient + Tool[]                               │
│   ├── 创建 SessionManager + AgentSession                    │
│   ├── 创建 CliRenderer（订阅 AgentSessionEvent）             │
│   └── readline 交互循环 / 非交互式单次执行                   │
│                                                             │
│   agent.ts（对外简化壳，包装 Session + SessionManager）       │
└──────────────────────────┬──────────────────────────────────┘
                           │ AgentSessionEvent
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                       核心层（core/）                        │
│                                                             │
│   AgentSession                                              │
│   ├── run()：步骤循环（最多 maxSteps 轮）                    │
│   │   ├── generateResponseWithStreaming()                   │
│   │   │   └── llm.generateStream() → LLMStreamEvent        │
│   │   ├── executeTool()：查找 + 调用工具                     │
│   │   └── sessionManager.appendMessage()                   │
│   └── 发射 AgentSessionEvent 给壳层                          │
│                                                             │
│   SessionManager                                            │
│   ├── 内存模式（memory）：Map<sessionId, Message[]>         │
│   └── JSONL 模式（jsonl）：~/.eva-ai/sessions/ 持久化    │
└──────────┬──────────────────────────┬───────────────────────┘
           │ generate / generateStream │ execute
           ▼                           ▼
┌──────────────────────┐  ┌────────────────────────────────────┐
│      LLM 层（llm/）  │  │         工具层（tools/）            │
│                      │  │                                    │
│  LLMClient（门面）   │  │  Tool 接口                         │
│  └── provider 路由   │  │  ├── BashTool / BashOutputTool      │
│      ├── Anthropic   │  │  │   └── BashKillTool              │
│      ├── OpenAI      │  │  ├── ReadTool / WriteTool / EditTool│
│      └── Google      │  │  ├── NoteTool                      │
│                      │  │  ├── MCPTool（动态加载）            │
│  LLMClientBase       │  │  └── SkillTool（技能注入）         │
│  ├── generate()      │  │                                    │
│  └── generateStream()│  │  加载器                            │
│                      │  │  ├── MCPLoader（stdio/SSE/HTTP）   │
│  RetryConfig         │  │  └── SkillLoader（SKILL.md）       │
│  + withRetry()       │  │                                    │
└──────────────────────┘  └────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     基础设施层                               │
│                                                             │
│  schema.ts    —— 全局类型（Message / ToolCall / Events）     │
│  config.ts    —— YAML 配置读取与结构化                       │
│  retry.ts     —— 指数退避重试封装                            │
│  utils/       —— 终端工具函数                               │
└─────────────────────────────────────────────────────────────┘
```

### 核心数据流

```
用户输入
   │
   ▼
cli.ts → session.addUserMessage()
   │
   ▼
AgentSession.run()
   │
   ├─→ LLMClient.generateStream()
   │       │
   │       ├── AnthropicClient / OpenAIClient / GoogleClient
   │       │       └── withRetry() 包装的 _makeApiRequest()
   │       │
   │       └── LLMStreamEvent（thinking_delta / content_delta / tool_call / done）
   │
   ├─→ emit(AgentSessionEvent)  →  CliRenderer（终端渲染）
   │
   ├─→ [有 tool_call] executeTool()
   │       └── tool.execute(args)
   │
   └─→ SessionManager.appendMessage()（内存 + JSONL 持久化）
```

### 关键接口与类型

| 类型 | 位置 | 说明 |
|------|------|------|
| `Message` | `schema.ts` | 4 种角色：system / user / assistant / tool |
| `LLMStreamEvent` | `schema.ts` | thinking_delta / content_delta / tool_call / usage / done |
| `AgentSessionEvent` | `schema.ts` | message_start / thinking_delta / tool_call / tool_result / message_end / error |
| `Tool<Input>` | `tools/base.ts` | 泛型工具接口，所有工具实现 |
| `LLMClientBase` | `llm/base.ts` | generate + generateStream 抽象方法 |
| `LLMClient` | `llm/llm-client.ts` | provider 统一门面，Anthropic/OpenAI/Google 路由 |
| `AgentSession` | `core/agent-session.ts` | 推理循环内核，不直接输出到终端 |
| `SessionManager` | `core/session-manager.ts` | 会话生命周期管理，支持 memory/jsonl 双模式 |
| `Config` | `config.ts` | YAML 配置读取，支持 3 级路径查找 |

### 已实现能力

- ✅ 多 provider 支持（Anthropic / OpenAI / Google Gemini）
- ✅ 流式输出（`generateStream`）+ 思考内容（`thinking`）提取
- ✅ Tool Call 循环（多轮工具调用直到无 tool_call）
- ✅ 内置工具：bash（含后台进程管理）/ 文件读写编辑 / note
- ✅ MCP 工具动态加载（stdio / SSE / HTTP 三种连接方式）
- ✅ Skill 系统（SKILL.md 发现 + 路径处理 + 注入上下文）
- ✅ 会话持久化（JSONL append-only，支持恢复最近会话）
- ✅ 指数退避重试（`withRetry`）
- ✅ AbortSignal 取消支持
- ✅ 事件驱动内核（AgentSession 只发事件，不直接 console.log）

### 已知问题

- ⚠️ `retry.ts` 中重试边界判断逻辑存在 bug（条件反转，实际无法重试）
- ⚠️ `cli.ts` 中工具初始化代码被注释，工具列表为空（`tools: Tool[] = []`）
- ⚠️ `logger.ts` 为空文件，日志体系尚未建立
- ⚠️ 缺少 `createRuntime()` 工厂，cli 仍直接装配所有依赖
- ⚠️ 缺少 `/new` `/resume` `/fork` 等会话命令（虽然 SessionManager 已有 API）
- ⚠️ 缺少 RPC 模式
