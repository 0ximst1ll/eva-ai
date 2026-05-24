# Eva AI Current

## 当前状态（2026-05-24）

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
- `src/core/session-store.ts` 已抽出 workspace JSONL store 边界，负责 session 文件路径、manifest、session log 读写、append 和文件枚举；`SessionManager` public API 保持不变。
- `src/core/session-entry-store.ts` 已抽出单 session entry store 边界，负责 entry tree、path entries、active entry id、entry path traversal 和 entry tree view；`SessionManager` 内部不再维护独立的 `sessionEntryTrees` / `sessionPathEntries` / `sessionActiveEntryIds` 三组 Map。
- `src/core/session-model.ts` 已抽出最小 session 语义状态容器，负责 metadata、lineage、schema format、entry store 和 active state cache；`SessionManager` 不再维护多组 per-session Map。
- append message / usage / internal / compaction 的单 session 内存变更已下沉到 `SessionModel`；`SessionManager` 负责调用 model 返回的 durable entry 并在 jsonl 模式下持久化。
- branch active leaf 应用、durable `leaf` entry、durable `branch_summary` entry 和 branch operation summary 组装已下沉到 `SessionModel.branchToEntry()`；`SessionManager.branchSession()` 只负责持久化 model 返回的 entries。
- interactive/TUI slash command 已支持 `/fork [id] [--entry <entryId>]`、`/clone [id] [--entry <entryId>]`、`/branch <entryId>`、`/entries`、`/sessions`、`/parent`、`/children`、`/child [id]`、`/export [path]`、`/import <path>`。

## 进行中

- session 管理继续完善：当前正在评估 branch semantic operation 稳定后的下一步拆分边界，重点是 fork/clone/reset/import 的 lifecycle 与 repo/session 分层。

## 下一步

- 保持 `SessionManager` public API 不变，继续评估 fork/clone/reset/import 等 lifecycle 边界是否需要拆到 repo/session 层。
- 优先保持现有 session tree 行为稳定，再决定是否拆 `SessionRepo`。
- 后续补完整 tree navigation 交互和 branch summarization pipeline。

## 已知问题

- `SessionManager` 仍是偏大的 facade，同时负责 session lifecycle、fork/clone、import/export 和 reset；workspace JSONL 文件 IO、单 session entry store、最小 session model、append semantic operation 与 branch semantic operation 已拆出，但尚未拆成完整 repo/storage/session 三层。
- 当前 `SessionModel` 仍保留 active state cache 作为运行期派生缓存，尚未完全收敛为只保存 entry tree + active leaf。
- 当前只支持当前 session 文件内的指定 leaf entry path fork/clone、最小 entry-level branch、durable leaf entry、durable branch summary、branch operation summary、entry tree active path 展示、TUI entry selector、session-level parent navigation 和 direct child navigation；跨 session parent/child entry graph、完整 child branch navigation、完整 tree navigation 交互和 branch summarization pipeline 仍未实现。
- 运行期 `resource_context` / `compaction_summary` internal marker 仍默认不持久化；只有明确需要跨 resume 恢复的 harness metadata 才写入 durable `internal` entry。
- `ContextManager` 仍未支持完整 token budget 或 OpenAI provider countTokens。
- manual `/compact` 仍是最小版：没有工具结果 micro-compaction。
- skills 已有 resource discovery、source metadata、metadata system prompt 注入和 `/skill:name` 全文按需展开；尚未支持 package/extension source discovery。
- MCP 相关配置字段已解析，但当前只报告 extension boundary diagnostic，尚未接入 MCP server lifecycle。
- 当前 `max_steps` 字段名仍偏模糊，后续应迁移为 `max_steps_per_run` 或同类命名。
- RPC mode 仍是最小闭环，尚未支持完整 ACP 兼容层。
- tool result budget、超大输出持久化、完整 permission pipeline 尚未实现。
- TUI 已有最小单元测试，但仍缺真实终端兼容性 smoke test。
