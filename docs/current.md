# Eva AI Current

## 当前状态（2026-06-04）

## 已完成

- interactive、print、TUI 和 RPC modes 已共享 `RuntimeHost` 与同一套 runtime/session 路径。
- `RuntimeServices` 已承载 workspace 绑定的 config、provider、tools、session manager、resource loader、context builder、context manager、token counter 和 diagnostics。
- `AgentMessage` / `LlmMessage` 最小类型边界已引入，agent-loop 会在 provider call 前执行 `transformContext()` 和 `convertToLlm()`。
- `ResourceLoader` 已支持 system prompt、`AGENTS.md` project context、配置目录 skills discovery、skills source metadata、metadata system prompt 注入、explicit skill invocation 和 skills/resource diagnostics 展示。
- `ContextBuilder` 已收敛为 provider request view builder；`ContextManager` 已提供 token estimate、usage percent、compaction recommendation、skills/resource 和 permission pending/denied diagnostics 的最小聚合。
- `TokenCounter` 已支持 provider/local 计数边界，Anthropic 和 Gemini provider 优先使用 countTokens API。
- manual `/compact`、auto compaction、prompt-too-long compact-and-retry、post-compact resource budget 最小闭环已实现。
- durable `internal` session entry 和 permission pending/denied durable diagnostics 已实现。
- TUI 已接入共享 runtime，支持 tool confirmation、Ctrl-C abort/exit、session/entry navigation 和低噪音 streaming event 渲染。
- Headless JSONL RPC 最小闭环已实现，支持 prompt、state、abort、session lifecycle 和 permission approve/deny。
- M4 session tree 核心路径已完成：entry-tree-first session model、active leaf path rebuild、fork/clone/branch/import/export、branch summary、entry navigation、schema validation、latest fallback 和 recovery smoke cases。
- `SessionManager` 已收敛为 public lifecycle facade；storage backend、entry store、session model、log parser、context rebuilder 和 fork/create/load helper 已拆出。
- M5 Tool Execution Orchestration 最小闭环已实现：安全 read-only batch 并发，write/bash/high-risk/unknown 工具串行，tool result 按模型 tool call 原始顺序写回。
- M5 三模式 permission rule/mode 最小闭环已实现：`default`、`read-only`、`full-access` 已落地到 runtime/tool governance，并记录 pending/denied 关键事实；网络/敏感系统命令识别已覆盖常见远端 git、包管理器、容器/云工具和系统包管理器命令；permission result 已明确表达 workspace 外、网络和系统资源 capability，并标记当前不提供 OS 级 sandbox enforcement。
- M5 Tool Result Budget 当前已有最小实现：agent-loop 写回边界会对超预算 tool result 做 preview 截断，并保留原始长度/预算 metadata。
- ToolResult `content + typed details` 最小闭环已实现：agent-loop 会透传工具结构化 details，`read_file`、`bash`、`grep_files`、`find_files`、`list_files` 已输出工具专属 details 类型，包含 truncation、行数/结果数、exit code、full output path 等结构化信息。
- 工具级 `renderResult` 最小边界已实现：工具定义可基于 typed details 生成 `displayContent`，CLI/TUI 优先展示该字段；模型写回和 session 持久化仍使用原始 `content`。
- Tool call renderer 边界已对齐 `pi-mono`：工具定义可提供 `renderCall(args)`，TUI 通过工具 renderer 展示 bash `$ command`、read path、grep pattern/path 等关键参数，未知工具保留 fallback 摘要。
- 工具运行时 schema 校验最小闭环已对齐 `pi-mono`：agent-loop 会在 hooks/execute 前校验 tool arguments，非法参数返回工具错误，不再进入具体工具执行。
- AgentSession 已补任务级 auto-retry：provider/SDK 层 retry 耗尽后，503/429/timeout 等可恢复 LLM 错误会按会话层指数退避继续同一个任务，中间失败事件默认不结束用户任务。
- ProviderModel / ProviderRequestOptions / ProviderAuthResolver 最小骨架已实现：RuntimeServices 会创建结构化 provider runtime context，LLMClient 保持旧构造兼容并可接收结构化 model/auth/request options。
- Google provider thinkingConfig 已对齐 `pi-mono` 的分层策略：ProviderModel 判断 reasoning 能力，GoogleClient 按 Gemini family 映射 `thinkingLevel` / `thinkingBudget`，不再无条件 `includeThoughts`。
- Google provider 默认 reasoning 已进一步对齐 `pi-mono`：未显式配置 reasoning 时不再默认 high thinking；Gemini 3.x 使用最低隐藏 thinking level，Gemini 2.5 使用 `thinkingBudget: 0`。
- ProviderRequestOptions 已接入具体 provider adapter：OpenAI/Anthropic/Gemini 会消费 request-time `temperature`、`maxTokens`，并把 `headers`、`timeoutMs`、`maxRetries` 传入对应 SDK transport/client 边界。
- Retry 分层已对齐 `pi-mono` 的方向：顶层 `retry` 表示 AgentSession 任务级 retry；可选 `retry.provider` 才控制 provider/SDK-level timeout 和 retry，默认避免 provider retry 与 agent retry 叠加。
- Provider request lifecycle 测试已补最小覆盖：auth resolver 优先级、OpenAI/Anthropic/Gemini transport options、timeout error 分类、session-level retry cap 和成功 auto-retry 路径已被测试固定。
- Provider abort propagation 最小闭环已实现：agent-loop 会把 run `AbortSignal` 传入 LLM request options，OpenAI/Anthropic adapter 会转交 SDK request options，Google adapter 会在请求前和 stream 消费中 fail-fast；AbortError 不再进入通用 retry，agent-loop 会归一为用户取消结果。
- Provider Retry-After 最小闭环已实现：provider error formatter 会从常见 header/json/text 结构解析 `retryAfterMs`，AgentSession auto-retry 会优先使用该 delay，并继续受 `maxDelayMs` 上限保护。
- Google stream provider retry 已补最小边界：当 `generateContentStream()` 已返回 generator、但首个 chunk 获取阶段抛出 transient error 时，provider retry 会重新打开 stream；已输出内容后的中途失败仍交给 AgentSession 任务级 retry。
- Google stream 首包后的中途失败恢复已补最小 Agent Runtime lifecycle：agent-loop 会回滚失败 turn 的 runtime-only context marker，AgentSession auto-retry 前会从 durable session messages 重建 Agent 状态，避免半截 turn 污染后续 retry。
- TUI 工具输出展开/折叠已对齐 `pi-mono` 的全局模式：`Ctrl-T` 切换所有工具结果，新增工具结果继承当前全局展开状态。
- Bash streaming partial update 最小闭环已实现：foreground bash 会通过 `tool_execution_update` 透传有界 tail preview，TUI 对同一个 tool call 原地刷新 running/completed 状态，截断时复用同一个系统临时 full output log 路径。
- RPC 已将 `tool_execution_update` 作为稳定 JSONL event 边界透出，保留 partial result 的 `content`、`displayContent`、`details` 和 tool args，客户端可按 `toolCallId` 消费 partial update。
- Bash visual-line tail preview 最小闭环已实现：TUI/CLI 会把终端宽度传给工具 renderer，bash collapsed/partial preview 可按 terminal-width visual lines 取尾部输出。
- 超大工具输出 session sidecar artifact 路径已拆除：tool result 不再保存 artifact reference、不再写 `tool_result_artifact` internal entry，session storage 不再暴露 tool result artifact API。
- 工具层大输出截断已开始按工具类型收敛：`read_file` 保留 head 并提示 offset continuation，`bash` 保留 tail 并只在截断/中断时写系统临时 log，`grep_files` / `find_files` / `list_files` 保留 head 并提示缩小范围。
- 工具输出截断元数据已对齐 `pi-mono` 的 lines/bytes 双限制模型：`truncation` details 同时保留 Eva 旧 renderer 兼容字段和 `truncatedBy`、`totalLines`、`outputLines`、`totalBytes`、`outputBytes`、`maxLines`、`maxBytes` 等结构化字段。
- Compaction preparation 已按 `pi-mono` 思路补最小闭环：manual/auto/prompt-too-long compaction 共享同一路径，summary prompt 只消费轻量规范化后的旧 tool result，并附加 read/modified files 这类长期有用事实。
- 工具执行 abort lifecycle 已收敛：agent-loop 在工具批次边界停止后续执行，foreground bash 会响应 abort，已 abort 的同步文件工具不会继续读写。
- Tool operation injection 最小边界已实现：文件工具可注入 `FileToolOperations`，foreground bash 可注入 `BashOperations.exec`，background bash 可注入 `BashOperations.spawn`，默认实现仍使用本地 fs/shell。
- 工具执行状态保持 pi-mono 风格的 lifecycle event 归约：`Agent` 基于 `tool_execution_start/end` 维护 `pendingToolCalls`，暂不引入独立 tool execution diagnostics 聚合层。
- Extension-style tool execution hook 最小边界已实现：agent-loop 支持 `ToolExecutionHook[]`，可在 tool call 前合并 execution context、在 tool result 后补充 details/displayContent 等受限字段；runtime permission governance 已接入命名 hook，旧 `beforeToolCall/afterToolCall` 参数保留兼容。

## 进行中

- Provider Reliability 根据真实使用反馈完成一轮修复，当前需要进入真实 Gemini 验证和 pi-mono 细节差距收口。
- 当前已将 Google 默认 thinking、retry 分层、Google stream 首包 retry、首包后中途失败恢复和 AgentSession 默认 retry delay 向 `pi-mono` 收敛；后续需要继续补齐 Agent Runtime / Session / Tools / Provider 四个域的细节对齐。

## pi-mono 架构对齐评估（2026-06-04）

当前评分只衡量“与 pi-mono 的对齐程度”，不代表 Eva 自身设计优劣。

| 架构域 | 对齐度 | 当前判断 |
|---|---:|---|
| Agent Runtime | 7/10 | 主干分层已接近，stream/message lifecycle 仍偏薄 |
| Session / Recovery | 7.5/10 | entry-tree 骨架接近，细节能力少于 pi-mono |
| Tool System | 7/10 | 工具执行和展示边界接近，typed content/extension 能力不足 |
| Provider | 5.5/10 | 关键体验问题已补一轮，整体成熟度仍明显落后 |

Prompt Resource / Tool Prompt Metadata 主要差距：

- Eva 当前 system prompt 主要来自静态配置文本，未像 pi-mono 一样基于 active tools 动态构造 `Available tools`。
- Eva 工具定义已有 schema、renderer 和 metadata，但尚未把 `promptSnippet` / `promptGuidelines` 作为工具定义的一等字段。
- Eva 的 system prompt 没有明确列出 `write_file` 等真实工具名、必填参数和使用边界；这可能导致模型在复杂任务中生成空 args 或错误 args。
- Eva 工具 UI 展示名和真实工具名存在轻微错位，例如 `write_file` 在展示层显示为 `write ...`，不利于排查工具参数问题。

Agent Runtime 主要差距：

- Eva 已有 `RuntimeHost -> RuntimeServices -> AgentSession -> Agent -> agent-loop`，但 stream event 仍是扁平 delta；pi-mono 有更完整的 `start/text_start/text_delta/text_end/toolcall_*` 和 partial assistant message。
- Eva 当前 provider 失败发 `error` event，不形成统一的 `AssistantMessage(stopReason="error" | "aborted")`；pi-mono 会把失败 turn 也放进 assistant message lifecycle。
- Eva 已能从 durable boundary retry，但 UI/TUI 对失败尝试中已显示 partial output 还没有统一撤销/替换机制。
- Eva 的 queue/retry/agent_end UI 语义少于 pi-mono，例如缺少 `willRetry`、retry countdown/abort state 和更完整 queue update。

Session / Recovery 主要差距：

- Eva entry tree、active leaf、fork/clone/branch/import/export 已接近 pi-mono；但 entry 类型少于 pi-mono，尚无 `model_change`、`thinking_level_change`、`label`、`session_info`、`custom_message` 等完整语义。
- Eva 目前是 schema validation/recovery，尚未有正式 schema migration framework。
- Eva branch summary 当前更偏结构元信息；pi-mono 有可生成、可进入上下文的 branch summary pipeline。
- Eva 暂不持久化 failed assistant turn；pi-mono 可持久化 error/aborted assistant，并在 provider transform 时跳过这些不应 replay 的消息。
- Eva 尚未补齐跨 session parent/child entry graph、完整 tree navigation 产品交互、session selector/search/path delete/export polish。

Tool System 主要差距：

- Eva 已有 metadata、governance hook、read-only 并发、write/bash 串行、runtime schema validation、`renderCall`、`renderResult`、typed details 和 partial update。
- Eva tool result 仍以 string content 为主；pi-mono 的 tool result 支持 text/image block content。
- Eva details 主要用于运行时展示，尚未成为 durable tool message schema 的一等字段。
- Eva renderer 返回字符串 `displayContent`；pi-mono renderer 返回 TUI component，并支持更完整 export renderer。
- Eva extension-style hook 仍是内部最小边界；pi-mono 已有完整 extension tool registry、active tool filtering、prompt snippets/guidelines、allowed/excluded tools 和 tool event interception。

Provider 主要差距：

- Eva 已有 OpenAI/Anthropic/Google adapter、ProviderModel、ProviderAuthResolver、ProviderRequestOptions、Google thinkingConfig、Retry-After、abort propagation 和 Google stream retry 边界。
- Eva model capability 仍主要靠少量手写规则；pi-mono 有完整 model registry、generated metadata 和大量 compat flags。
- Eva auth 以 API key/env/config 为主；pi-mono 支持 OAuth、provider-specific auth storage 和 headers。
- Eva provider stream 仍主要通过 throw 交给 agent-loop；pi-mono 要求 stream failure 编码成 `error` event 和 `AssistantMessage(stopReason="error")`。
- Eva 还缺 `onPayload` / `onResponse`、responseId、cacheRetention、sessionId cache affinity、prompt cache usage/cost、cross-provider transform、orphan tool call synthetic result 等 provider 细节。

## 下一步

- 第一优先级：用真实 Gemini 运行验证默认 hidden/minimal thinking、2s 起步 agent retry、Google stream 首包 retry 和首包后 durable boundary retry 是否改善 overload/high-demand 体验；如仍失败，再对比 pi-mono 的 Google auth/baseUrl/provider variant。
- 第二优先级：先对齐 pi-mono 的动态 system prompt 和 tool prompt metadata：基于 active tools 注入工具列表、工具用途、prompt guidelines，并保持工具名、schema、renderer 展示一致。
- 第三优先级：Agent Runtime 对齐 pi-mono 的 failed assistant turn / error assistant message lifecycle，让 error/abort/partial output/retry 进入统一 assistant turn 模型。
- 第四优先级：Provider 继续补齐 model registry、compat flags、auth variants、stream error contract、payload/response hooks 和 session/cache affinity。
- 第五优先级：Tool System 补 durable tool details、block content、rich renderer/export renderer 和 extension tool registry 边界。
- 第六优先级：Session 补 schema migration、label/session_info、branch summary pipeline、error/aborted assistant handling 和更完整 tree navigation。
- 保持 permission diagnostics 简单，继续沿用 pending/denied 关键事实；`/diagnostics` 不承载 tool result details 展示。

## 已知问题

- Provider 层仍偏薄：模型能力、认证解析和请求选项已有最小结构化边界，OpenAI/Anthropic/Gemini 已消费主要 ProviderRequestOptions；Google 默认 thinking、retry 分层和 stream 首包 retry 已向 `pi-mono` 收敛，abort propagation 和 Retry-After 已有最小闭环，但 Google auth/baseUrl/provider variant 仍可能与 pi-mono 实际运行路径不同。
- Google stream 首包后的中途失败恢复已有 durable boundary 最小闭环，但 UI/TUI 对失败尝试中已经渲染的 partial output 还没有统一撤销/替换机制。
- System prompt 仍偏静态，未按 active tools 注入工具 snippets/guidelines；这可能影响 `write_file`、`edit_file` 等工具在复杂任务中的参数完整性和选择准确性。
- Provider auth 当前已有 API key resolver，支持 runtime/config/env 优先级；尚未支持 OAuth 或 provider-specific auth storage。
- 工具层大输出已具备 head/tail 基础策略、lines/bytes truncation details、compaction-time lightweight tool result normalization、tool-specific collapsed line preview、TUI 全局工具结果 expand/collapse、bash streaming partial update、RPC partial update event 和 bash visual-line tail preview；如果后续要更完整消费 details，需要扩展 durable tool message schema。
- Tool Result 已有 `content + typed details` 和工具级 `renderResult` 最小边界；当前 details 主要用于运行时展示，尚未持久化进 session message。
- abort lifecycle 已覆盖当前内置工具的主要路径，但仍缺更细的 abort reason 和队列状态；工具执行诊断暂保持 lifecycle event + pending state 的简单边界。
- operation injection 和 tool execution hook 目前是内部最小边界，尚未提供统一 remote workspace adapter、sandbox adapter 或完整 extension wrapper。
- `ContextManager` 仍未支持完整 token budget 或 OpenAI provider countTokens。
- manual `/compact` 仍是最小版：没有工具结果 micro-compaction。
- skills 已有 resource discovery、source metadata、metadata system prompt 注入和 `/skill:name` 全文按需展开；尚未支持 package/extension source discovery。
- MCP 相关配置字段已解析，但当前只报告 extension boundary diagnostic，尚未接入 MCP server lifecycle。
- session 当前有意暂不拆完整 `SessionRepo`；跨 session parent/child entry graph、完整 tree navigation 交互和 branch summarization pipeline 仍未实现。
- 三模式 permission rule/mode 已落地到 runtime/tool governance，并已有 pending/denied 记录、常见网络/敏感系统命令识别和 execution capability flags；当前只在 Eva 层做 policy gating，尚未接入底层 sandbox enforcement。
- TUI 已有最小单元测试，但仍缺真实终端兼容性 smoke test。
