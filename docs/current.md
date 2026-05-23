# Eva AI Current

## 当前状态（2026-05-23）

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
- interactive/TUI slash command 已支持 `/fork [id] [--entry <entryId>]`、`/clone [id] [--entry <entryId>]`、`/branch <entryId>`、`/entries`、`/sessions`、`/parent`、`/children`、`/child [id]`、`/export [path]`、`/import <path>`。

## 进行中

- session 管理继续完善：下一步关注 repo/storage/session 分层设计，减少 `SessionManager` 单体职责。

## 下一步

- 参考 pi-mono harness 的 `SessionStorage` / `SessionRepo` / `Session` 分层，拆出单 session JSONL storage 和 workspace session repo。
- 在不改变外部 CLI/RPC/TUI 行为的前提下，把 `SessionManager` 的文件 IO、entry path traversal、session lifecycle 和语义操作分离。
- 后续补完整 tree navigation 交互和 branch summarization pipeline。

## 已知问题

- `SessionManager` 仍是单体类，同时负责文件 IO、entry path 状态、session lifecycle、fork/clone、import/export 和 lineage，尚未拆成 repo/storage/session 三层。
- 当前仍保留 active state cache 作为运行期派生缓存，尚未完全收敛为只保存 entry tree + active leaf。
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
