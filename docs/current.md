# Eva AI Current

## 当前状态（2026-05-27）

## 已完成

- interactive、print、TUI 和 RPC modes 已共享 `RuntimeHost` 与同一套 runtime/session 路径。
- `RuntimeServices` 已承载 workspace 绑定的 config、provider、tools、session manager、resource loader、context builder、context manager、token counter 和 diagnostics。
- `ResourceLoader` 已支持 system prompt、`AGENTS.md` project context、配置目录 skills discovery、skills source metadata、source candidate merge/dedupe、skills metadata system prompt 注入、explicit skill invocation 和 skills/resource diagnostics 展示。
- `ContextBuilder` 已收敛为 provider request view builder；`ContextManager` 已提供 token estimate、usage percent、compaction recommendation、skills/resource 和 permission pending diagnostics 的最小聚合。
- `TokenCounter` 已支持 provider/local 计数边界，Anthropic 和 Gemini provider 优先使用 countTokens API。
- manual `/compact`、auto compaction 最小执行闭环、prompt-too-long compact-and-retry、post-compact resource budget 最小闭环已实现。
- `AgentMessage` / `LlmMessage` 最小类型边界已引入，agent-loop 会在 provider call 前执行 `transformContext()` 和 `convertToLlm()`。
- durable `internal` session entry 和 permission pending durable diagnostics 已实现。
- 自建最小 TUI 框架与 `tui-mode.ts` 已落地，TUI 支持 tool confirmation、Ctrl-C abort/exit、`/sessions` 选择器、`/entries` entry selector 和低噪音 streaming event 渲染。
- M3 Headless RPC 最小闭环已实现，RPC 支持 `prompt`、`get_state`、`abort`、`new_session`、`resume_session`、`fork_session`、`clone_session`、`branch_session`、permission approve/deny。
- M4 session tree 最小闭环已实现：`SessionManager` 支持 lineage metadata、entry tree schema、entry-path rebuild、entry path state derivation、active entry path application、active state 读取边界、append path cache sync、durable leaf entry、指定 leaf entry fork/clone、entry-level branch、durable branch summary、branch operation summary、JSONL import/export、session tree 展示、entry tree active path 展示、parent navigation 和 direct child navigation。
- session 读取路径已进一步收敛为 entry-tree-first：可加载的 session entries 必须带有 `entryId` / `parentEntryId`，`SessionContextRebuilder` 固定使用 `entry_path`，`loadSession()` / `importSession()` / `forkSession()` 不再回退旧 flat JSONL snapshot。
- `src/core/session-store.ts` 已抽出 `SessionStorage` backend 边界，提供 `JsonlSessionStorage` 和 `MemorySessionStorage`；`SessionManager` 可通过 storage 注入或兼容 `mode` shortcut 选择 backend，public API 保持不变。
- `src/core/session-entry-store.ts` 已抽出单 session entry store 边界，负责 entry tree、path entries、active entry id、entry path traversal 和 entry tree view；`SessionManager` 内部不再维护独立的 `sessionEntryTrees` / `sessionPathEntries` / `sessionActiveEntryIds` 三组 Map。
- `src/core/session-model.ts` 已抽出最小 session 语义状态容器，负责 metadata、lineage、schema format、entry store 和 active state cache；`SessionManager` 不再维护多组 per-session Map。
- append message / usage / internal / compaction 的单 session 内存变更已下沉到 `SessionModel`；`SessionManager` 负责调用 model 返回的 durable entry 并在 jsonl 模式下持久化。
- branch active leaf 应用、durable `leaf` entry、durable `branch_summary` entry 和 branch operation summary 组装已下沉到 `SessionModel.branchToEntry()`；`SessionManager.branchSession()` 只负责持久化 model 返回的 entries。
- fork/clone 的 entry-path 复制、state 派生、lineage 和新 `SessionModel` 初始化已收敛到 `forkSessionModel()` helper；`SessionManager.forkSession()` 只负责加载 source session、保存 model 和 JSONL 持久化。
- create/reset 的初始 system message entry、entry tree/path、active state 和 `SessionModel` 初始化已收敛到 `createInitialSessionModel()` helper；`SessionManager` 保留 create/reset lifecycle 和 JSONL 持久化。
- parsed session log 到 `SessionModel` 的应用已收敛到 `createSessionModelFromParsedLog()` helper；`SessionManager` 仍保留 JSONL parser，但 load/import 的 model restoration 语义已移出 manager。
- `src/core/session-log-parser.ts` 已抽出 JSONL session parser / imported session rewrite 边界，负责 `parseSessionLog()`、`getSessionIdFromLog()` 和 `rewriteImportedSessionLog()`。
- session parse/load diagnostics 最小闭环已实现：`parseSessionLog()` 返回 structured diagnostics，`SessionManager.getDiagnostics()` 可读取 load/import/list/latest 相关 session diagnostics，interactive `/diagnostics` 会合并展示动态 session diagnostics。
- session schema validation 最小闭环已实现：parser 会校验各类 session entry 的必要 payload 字段，并对 invalid entry payload 记录 `session_log_invalid_entry` diagnostics；active path parent、branch 后 append parent、load/import active state 和 reset path 不泄漏已有集中测试覆盖。
- session load/import recovery 策略最小闭环已实现：unsupported schema、缺失有效 `session_start`、broken active path、无 active context 的缺 entry metadata 会阻断 load/import；trailing invalid JSONL、单条 invalid payload 和 unknown entry type 保持可诊断降级；`/resume` 会展示 unloadable session 的简短原因。
- latest session manifest fallback 最小闭环已实现：`manifest.latestSessionId` 指向缺失或不可加载 session 时，会记录 latest load failure，从可加载 session 列表中选择最近的 fallback session，并更新 manifest；没有 fallback 时保留返回 `null` 让 runtime 创建新 session。
- unsupported session schema 提示已收敛：load/import 阻断错误会明确 session 文件 schema version、当前 Eva 支持的 schema version，并提示升级 Eva 或执行未来 migration。
- session recovery smoke cases 已补齐：runtime latest 恢复、session list/tree 跳过坏文件、import 失败隔离和 RPC resume 失败行为已有覆盖。
- M4.x session semantic split 已基本收口：`SessionManager` 当前主要保留 public lifecycle facade、memory/jsonl 分发、manifest/latest session、list/import/export 编排。
- interactive/TUI slash command 已支持 `/fork [id] [--entry <entryId>]`、`/clone [id] [--entry <entryId>]`、`/branch <entryId>`、`/entries`、`/path`、`/sessions`、`/parent`、`/children`、`/child [id]`、`/export [path]`、`/import <path>`。
- M5 Tool Result Budget 最小闭环已实现：tool result 在 agent-loop 统一写回边界应用默认字符预算，超预算结果会截断并携带原始长度/预算 metadata，进入下一次 provider request 和 session tool message 的内容保持一致。
- M5 超大工具输出持久化引用最小闭环已实现：AgentSession 会在预算截断前把超大 tool content/error 写入 session sidecar artifact，tool result 和 durable internal entry 保存 artifact reference，provider request/session tool message 只保留 preview。
- M5 Tool Execution Orchestration 最小闭环已实现：agent-loop 会把连续 read-only/concurrency-safe/read category tool calls 作为并发 batch 执行，write/bash/high-risk/unknown tool calls 保持串行，tool result 仍按模型 tool call 原始顺序写回。
- M5 三模式 permission rule/mode 最小闭环已实现：`default` 允许 workspace 内读写和本地命令、workspace 外文件访问和疑似网络命令 ask；`read-only` 只允许只读工具；`full-access` 在 Eva 层 allow all，并可向 file tools 传递 outside-workspace 访问上下文。

## 进行中

- M5 Tool / Permission Governance 已开始；当前三模式 permission rule/mode 已有最小闭环，后续继续补强权限诊断、sandbox policy integration 和工具执行治理。

## 下一步

- 优先保持现有 session tree 行为稳定，不在当前阶段继续拆 `SessionRepo`。
- 继续推进权限治理：补更细的网络/危险命令识别、sandbox policy integration 和 permission diagnostics 展示。
- 收敛 headless/RPC 三模式参数表达，以及无确认通道时的 fail-closed / pending 用户可见行为。
- 继续补强工具执行治理：abort 下的工具执行生命周期、tool operation injection 和更细的 tool execution diagnostics。
- 后续再补 tool artifact lifecycle：list/read UI、import/export 关联、cleanup 和更完整 artifact repo。
- branch summarization pipeline、更完整 tree navigation 交互保留为后续 Session / Recovery 增强项，不阻塞 M4 阶段完成。
- import/export lifecycle 目前保留在 `SessionManager` facade 中，等出现 schema migration、sidecar store 或 repo-level delete/list 需求时再拆。

## 已知问题

- `SessionManager` 仍是 public facade，负责 session lifecycle、load/import/export 和 manifest/latest session 编排；workspace JSONL 文件 IO、session storage backend、session log parser、单 session entry store、最小 session model、append/branch semantic operation、fork/clone model helper、create/reset model helper 与 parsed session model application 已拆出。当前有意暂不拆完整 `SessionRepo`。
- 当前 `SessionModel` 仍保留 active state cache 作为运行期派生缓存，尚未完全收敛为只保存 entry tree + active leaf。
- session load/import 的 structured diagnostics、最小 schema validation、active path 不变量测试、fatal vs recoverable 策略、latest manifest fallback、unsupported schema 提示和 recovery smoke cases 已有当前阶段闭环。
- 当前只支持当前 session 文件内的指定 leaf entry path fork/clone、最小 entry-level branch、durable leaf entry、durable branch summary、branch operation summary、entry tree active path 展示、TUI entry selector、session-level parent navigation 和 direct child navigation；跨 session parent/child entry graph、完整 child branch navigation、完整 tree navigation 交互和 branch summarization pipeline 仍未实现。
- 运行期 `resource_context` / `compaction_summary` internal marker 仍默认不持久化；只有明确需要跨 resume 恢复的 harness metadata 才写入 durable `internal` entry。
- `ContextManager` 仍未支持完整 token budget 或 OpenAI provider countTokens。
- manual `/compact` 仍是最小版：没有工具结果 micro-compaction。
- skills 已有 resource discovery、source metadata、metadata system prompt 注入和 `/skill:name` 全文按需展开；尚未支持 package/extension source discovery。
- MCP 相关配置字段已解析，但当前只报告 extension boundary diagnostic，尚未接入 MCP server lifecycle。
- 当前 `max_steps` 字段名仍偏模糊，后续应迁移为 `max_steps_per_run` 或同类命名。
- RPC mode 仍是最小闭环，尚未支持完整 ACP 兼容层。
- tool result budget 和超大输出 artifact reference 已有最小闭环，但尚未支持 artifact list/read UI、import/export 关联、cleanup 或工具结果 micro-compaction。
- tool execution orchestration 已支持安全 read-only batch 并发和不安全工具串行，但尚未支持更完整的 operation injection 或工具执行耗时/队列 diagnostics。
- 三模式 permission rule/mode 已落地到 runtime/tool governance，但网络命令识别仍是最小启发式，尚未接入底层 sandbox policy。
- TUI 已有最小单元测试，但仍缺真实终端兼容性 smoke test。
