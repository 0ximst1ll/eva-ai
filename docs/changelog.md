1. 从 mini-agent Python 版本迁移到 TypeScript 版本
2. 支持 google-client 和流式输出
3. 抽离 AgentSession + SessionManager + Runtime
4. 更名为 eva-ai
5. 工具系统升级
6. Agent 抽象重建
7. 工具治理闭环
8. RuntimeHost 基础层
9. mode 分层（interactive / print）
10. Runtime diagnostics 收敛
11. RuntimeServices 最小骨架
12. ResourceLoader 最小骨架
13. ContextBuilder 最小闭环
14. Manual `/compact` 最小闭环
15. ContextBuilder / ContextManager 上下文管理分层
16. TokenCounter provider/local 计数边界
17. AgentMessage / LlmMessage 最小消息边界
18. Headless RPC 最小闭环
19. RPC Permission Pending Approval 最小闭环
20. Session Tree Lineage / Fork 最小 schema
21. SessionContextRebuilder 最小边界
22. Session Entry Tree 最小 schema
23. SessionContextRebuilder Entry Path 最小 rebuild
24. Session Entry Path Resume 主路径
25. Session Clone 最小边界
26. Session Import / Export 最小边界
27. Session Tree 展示与 Parent Navigation 最小边界
28. Entry Path Fork / Clone 最小边界
29. 指定 Leaf Entry Fork / Clone 对外边界
30. Entry-Level Branch 最小边界
31. Entry Tree 展示最小边界
32. Branch Operation Summary 最小边界
33. Entry Path State Derivation 最小边界
34. Active Entry Path Application 最小边界
35. Durable Branch Summary Entry 最小边界
36. Durable Leaf Entry 最小边界
37. Session Entry-Tree-First 读取收敛
38. Workspace Session Store 边界
39. Session Entry Store 边界
40. SessionModel 状态容器边界
41. SessionModel Append Operation 边界
42. SessionModel Branch Operation 边界
43. Fork Session Model Helper 边界
44. Initial Session Model Helper 边界


# Initial Session Model Helper 边界

继续收敛 create/reset 的初始 session model 构造，减少 `SessionManager` 中重复的 system entry 初始化逻辑。

核心变化：

- 新增 `createInitialSessionModel()` helper。
- helper 负责创建初始 system message entry、entry tree/path、active state、lineage 和 `SessionModel`。
- `SessionManager.createSession()` 和 `resetSession()` public API 不变，当前只负责保存 model、写入 `session_start`、持久化 initial entry 和更新 manifest。
- `resetSession()` 继续保留现有 metadata createdAt 语义。


# Fork Session Model Helper 边界

继续收敛 fork/clone 的 entry-tree-first 语义，把 target session model 构造从 `SessionManager` 中拆出。

核心变化：

- 新增 `forkSessionModel()` helper。
- helper 负责复制 source active/指定 leaf entry path、派生 active state、构造 target entry tree、创建 lineage metadata 和 target `SessionModel`。
- `SessionManager.forkSession()` public API 不变，当前只负责加载 source session、保存 target model、写入 `session_start`、持久化 forked path entries 和更新 manifest。
- `cloneSession()` 继续复用 `forkSession()`，保持 current-leaf fork 语义。


# SessionModel Branch Operation 边界

继续把同 session 内 entry-level branch 语义从 `SessionManager` 下沉到 `SessionModel`。

核心变化：

- `SessionModel` 新增 `branchToEntry()`。
- `branchToEntry()` 负责应用目标 active leaf path、追加 durable `leaf` entry、追加 durable `branch_summary` entry、更新 metadata，并组装 `SessionBranchSummary`。
- `SessionManager.branchSession()` public API 不变，当前只负责调用 model、持久化返回的 durable entries 和更新 manifest。


# SessionModel Append Operation 边界

继续把单 session 语义从 `SessionManager` 下沉到 `SessionModel`，让 manager 更接近 lifecycle / persistence facade。

核心变化：

- `SessionModel` 新增 append message / usage / internal / compaction 语义方法。
- append 方法负责创建 entry node、追加 path entry、同步 active state cache 和更新 session metadata。
- append 方法返回 durable entry payload，`SessionManager` 在 jsonl 模式下直接持久化该 entry。
- `SessionManager` public API 不变，append 路径不再直接操作 `SessionEntryStore`。


# SessionModel 状态容器边界

继续按 `pi-mono` harness 的 storage/session 分层方向收敛，把单个 session 的语义状态从 `SessionManager` 的多组 Map 中拆出。

核心变化：

- 新增 `src/core/session-model.ts`，提供最小 `SessionModel`。
- `SessionModel` 负责 metadata、lineage、schema format、entry store 和 active state cache。
- entry path state derivation helper 移入 `session-model.ts`，`buildSessionStateFromEntryPath()` 仍从 `session-manager.ts` 兼容导出。
- `SessionManager` public API 保持不变，内部从多组 per-session Map 收敛为 `Map<sessionId, SessionModel>`。
- 当前 `SessionManager` 仍负责 create/load/fork/branch/compact/import/export 编排；后续再继续拆 session semantic operation 或 repo 层。


# Session Entry Store 边界

继续按 `pi-mono` harness 的 storage/session 分层方向收敛，把单个 session 的 entry tree 状态从 `SessionManager` 中拆出。

核心变化：

- 新增 `src/core/session-entry-store.ts`，提供 `SessionEntryStore`。
- entry store 负责 entry tree、path entries、active entry id、entry path traversal 和 entry tree view。
- `SessionManager` public API 保持不变，内部从 `sessionEntryTrees` / `sessionPathEntries` / `sessionActiveEntryIds` 三组 Map 收敛为 `Map<sessionId, SessionEntryStore>`。
- 当前仍保留 `SessionManager` 作为 session lifecycle facade；branch/fork/compaction/import/export 语义后续再继续拆到语义层 `Session`。


# Workspace Session Store 边界

继续收敛 session 管理分层，先把 workspace 级 JSONL 文件生命周期从 `SessionManager` 中拆出。

核心变化：

- 新增 `src/core/session-store.ts`，提供 `WorkspaceSessionStore`。
- store 负责 workspace session 目录、session 文件路径、manifest、session log 读写、append 和 session 文件枚举。
- `SessionManager` public API 保持不变，内部改为委托 store 完成 JSONL 文件 IO。
- 当前只完成 workspace store 第一层拆分；entry index/path traversal、active leaf 和 session 语义仍在 `SessionManager` 中，后续再继续拆 `SessionStorage` / `SessionRepo` / `Session`。


# Session Entry-Tree-First 读取收敛

进一步收敛 M4.x session model，移除旧 flat JSONL snapshot 兼容路径，让当前 session context 只从 active entry path 派生。

核心变化：

- `message`、`compaction`、`usage`、`internal`、`leaf` 和 `branch_summary` entries 在类型上要求 `entryId` / `parentEntryId`。
- `SessionManager.loadSession()` / `importSession()` 不再把缺少 entry metadata 的旧 flat JSONL 当作有效 active context。
- `SessionManager.forkSession()` 不再从 `Message[]` 快照生成线性 fallback path；没有 active entry path 时直接失败。
- `SessionContextRebuilder` 的 strategy 收敛为 `entry_path`，删除 `flat_snapshot` 分支。
- `getSessionFormatInfo()` 只保留当前 schema version，不再暴露 legacy 状态。
- session tests 改为验证旧 flat JSONL 不会被 rebuild，同时覆盖 fork、branch、durable leaf、import/export 和 compaction path 不回归。

当前仍保留 `SessionManager` 内部 active state cache 作为运行期派生缓存；下一步应参考 `pi-mono` harness 拆分 `SessionStorage` / `SessionRepo` / `Session`。


# Durable Leaf Entry 最小边界

对齐 `pi-mono` 最新 session tree 设计，把 active leaf 切换本身写入 append-only session log。

核心变化：

- 新增 `leaf` session entry，包含 `targetEntryId`，用于持久化 active leaf 切换。
- `SessionManager.branchSession()` 会先追加 `leaf` entry，再追加 `branch_summary` entry。
- reload/import 会重放 `leaf` entry；如果 session 停在只有 leaf control entry 的中间状态，也能恢复 active leaf。
- `leaf` entry 不参与 provider context 派生，只作为 session control entry 使用。
- planning 补充 repo/storage/session 分层方向，以及 session log、derived context、runtime state、sidecar store、diagnostics/event stream 的长期设计。

当前仍未拆出独立 `SessionRepo` / `SessionStorage` / `Session` 类；该拆分放入后续结构收敛。


# Durable Branch Summary Entry 最小边界

为 M4.x Entry Tree First 对齐把 branch 操作本身写入 append-only session tree。

核心变化：

- 新增 `branch_summary` session entry，包含 `fromEntryId`、`toEntryId`、`pathEntryCount` 和 `messageCount`。
- `SessionManager.branchSession()` 改为异步：先应用目标 leaf path，再追加 `branch_summary` entry。
- branch 成功后 active leaf 会变成 `branch_summary` entry，下一条 message 会从该 summary entry 继续。
- `listEntryTree()` / `/entries` 可展示 branch summary preview；reload 后会保留 summary entry。
- `SessionBranchSummary` 返回 summary entry id 和 from entry id。
- 测试覆盖 branch summary 后 append parent、非 message leaf branch 和 reload path。

当前仍未实现完整交互式 entry navigation UI、child branch navigation 或跨 session parent/child entry graph。


# Active Entry Path Application 最小边界

继续收紧 M4.x Entry Tree First 的内部 active state cache 边界。

核心变化：

- 新增 `SessionManager.applyActiveEntryPath()` 内部 helper，统一执行 get entry path、derive active state、写入 active state cache 和设置 active entry id。
- `branchSession()` 改为通过 `applyActiveEntryPath()` 应用目标 leaf。
- `loadSession()` 和 `importSession()` 在恢复 entry metadata 后通过 `applyActiveEntryPath()` 应用 active leaf；旧 flat JSONL 仍使用 flat fallback state。
- `sessions` map 语义明确为当前 active leaf path 的运行期缓存，不再作为 canonical session history 描述。
- 测试覆盖 branch 到 `usage` 这类非 message leaf 后继续 append，新 message 的 parent 是当前 active leaf。

当前仍保留 active state cache；还未完全收敛为只保存 entry tree + active leaf。


# Entry Path State Derivation 最小边界

为 M4.x Entry Tree First 对齐补齐 active leaf path 的统一状态派生边界。

核心变化：

- 新增 `buildSessionStateFromEntryPath()`，统一从 entry path 派生 active messages、compaction、usage 和 internal entries。
- `forkSession()`、`branchSession()`、`loadSession()` / import path 和 `SessionContextRebuilder` 共享该派生边界。
- `branchSession()` 不再只更新 messages/compaction，也会按目标 leaf path 重建 usage 和 internal entries，避免 abandoned branch metadata 泄漏到 active state。
- `SessionContextRebuilder` 复用同一派生逻辑，移除重复的 entry path message rebuild 实现。
- 测试覆盖 branch 后 abandoned branch usage/internal 不进入 active state。

当前 `SessionManager` 仍维护 active `Message[]` 作为运行期缓存；还未完全收敛为只保存 entry tree + active leaf。


# Branch Operation Summary 最小边界

为 M4.x Entry Tree First 对齐补齐 branch 操作后的结构化摘要，但不引入新的持久化 branch summary entry 类型。

核心变化：

- `SessionManager.branchSession()` 返回 `SessionBranchSummary`，包含目标 leaf entry、path entries 数、message 数和目标 entry view。
- `AgentSession.branchToEntry()` 与 `RuntimeHost.branchSession()` 透传该 summary。
- interactive `/branch <entryId>` 成功后展示 path/message/target 摘要。
- RPC `branch_session` response 增加 `branch` 字段。
- 测试覆盖 `SessionManager`、`RuntimeHost`、interactive command 和 RPC response。

该阶段仍未实现持久化的一等 branch summary entry、完整交互式 entry navigation UI 或 child branch navigation。


# Entry Tree 展示最小边界

为 M4.x Entry Tree First 对齐补齐当前 session 文件内的 entry tree 可见性，让 `/branch <entryId>` 的 entry id 有稳定发现入口。

核心变化：

- 新增 `SessionManager.listEntryTree()`，返回面向展示的 entry tree view，包含 entry id、parent、type、timestamp、active marker 和 payload preview。
- interactive slash command 新增 `/entries`，展示当前 session 文件内的 entry tree。
- entry tree 展示会标记 active leaf，并展示 message role、message index、internal kind 或 usage/compaction preview。
- 测试覆盖 `SessionManager` 的 tree view 和 interactive `/entries` 输出。

该阶段仍未实现持久化的一等 branch summary entry、完整交互式 entry navigation UI 或 child branch navigation。


# Entry-Level Branch 最小边界

为 M4.x Entry Tree First 对齐增加同 session 文件内的 active leaf 移动能力。

核心变化：

- 新增 `SessionManager.branchSession()`，可把当前 active leaf 移动到指定 entry，并从该 leaf path 派生 active messages。
- 新增 `AgentSession.branchToEntry()`，同步更新 Agent working history。
- 新增 `RuntimeHost.branchSession()`，mode 层不直接操作 `SessionManager`。
- interactive slash command 新增 `/branch <entryId>`。
- RPC 新增 `branch_session`，必填 `leaf_entry_id`。
- 下一次 append 会以 branch 后的 active leaf 作为 parent，从而在同一个 session 文件内形成新分支。
- 测试覆盖 `SessionManager`、`RuntimeHost`、interactive command 和 RPC 路径。

该阶段仍未实现持久化的一等 branch summary entry；entry id 可发现性由后续 `/entries` 展示能力补齐。


# 指定 Leaf Entry Fork / Clone 对外边界

为 M4.x Entry Tree First 对齐补齐指定 leaf entry fork/clone 的对外入口。

核心变化：

- `SessionManager.forkSession()` 指定 `leafEntryId` 时会校验 entry path 存在，不再静默回退。
- `RuntimeHost.forkSession()` / `cloneSession()` 支持传入 `leafEntryId`。
- interactive slash command 支持 `/fork [id] --entry <entryId>` 和 `/clone [id] --entry <entryId>`。
- RPC 新增 `fork_session` / `clone_session`，支持 `session_id` 和 `leaf_entry_id` 参数。
- 测试覆盖 `SessionManager`、`RuntimeHost`、interactive command 和 RPC 路径。

当前仍未实现同 session 文件内的 entry-level branch/navigate；指定 leaf entry fork 仍会创建新的 session。


# Entry Path Fork / Clone 最小边界

为 M4.x Entry Tree First 对齐增加 fork/clone 的第一步收敛。

核心变化：

- `SessionManager.forkSession()` 优先复制当前 active entry path，而不是只复制 active `Message[]` 快照。
- `SessionManager.cloneSession()` 复用 entry-path fork 语义。
- 新 session 会保留 path 上的 `message`、`compaction`、`usage` 和 `internal` entries，并重写 `sessionId`。
- 旧 JSONL 没有 entry metadata 时仍回退到线性 message path，保持兼容。
- 测试覆盖 fork 后 internal/usage entries、usage summary、entry path 和 reload 兼容性。

当前仍只使用 active leaf；尚未在 mode/RPC 中暴露指定 leaf entry fork，也尚未实现同 session 文件内的 entry-level branch/navigate。


# Session Tree 展示与 Parent Navigation 最小边界

为 M4 Session Tree 增加 workspace session-level tree 展示和向 parent session 导航能力。

核心变化：

- 新增 `SessionManager.listSessionTree()`，基于 `parentSessionId` 组织当前 workspace sessions。
- interactive `/sessions` 改为 tree 输出，并标记 current/latest session。
- 新增 `RuntimeHost.switchToParentSession()`，mode 层不直接读取并切换 session manager。
- interactive `/parent` 可切换到当前 session 的 parent session；没有 parent 时打印提示。
- 测试覆盖 `SessionManager`、`RuntimeHost` 和 slash command 路径。

当前仍是 session-level lineage tree；尚未实现跨 session parent/child entry graph、sidecar metadata 或完整 child branch navigation。


# Session Import / Export 最小边界

为 M4 Session Tree 增加 JSONL 文件级别的 session 导入导出能力。

核心变化：

- 新增 `SessionManager.exportSession()`，jsonl 模式复制原始 session 文件，memory 模式生成最小 JSONL。
- 新增 `SessionManager.importSession()`，读取外部 JSONL，重写 workspaceDir 到当前 workspace，写入当前 workspace session store，并加载为 latest session。
- 新增 `RuntimeHost.exportSession()` / `RuntimeHost.importSession()`，mode 层不直接访问 `SessionManager`。
- interactive/TUI slash command 支持 `/export [path]` 和 `/import <path>`。
- 测试覆盖 `SessionManager`、`RuntimeHost` 和 slash command 路径。

当前 import/export 仍是 JSONL 文件级别能力；尚未实现跨 session parent/child graph、branch navigation 或批量迁移。


# Session Clone 最小边界

为 M4 Session Tree 增加 clone 操作的最小闭环，并保持与 `pi-mono` 的 current-leaf fork 语义一致。

核心变化：

- 新增 `SessionManager.cloneSession()`，当前复用 current active context fork 语义。
- 新增 `RuntimeHost.cloneSession()`，mode 层不直接访问 `SessionManager`。
- interactive/TUI slash command 支持 `/clone [id]`。
- clone 后新 session 保留 parent/root lineage，父子后续消息互不影响。

当前 clone 仍是当前 session 文件内的最小语义；尚未实现 import/export、branch navigation 或跨 session parent/child graph。


# Session Entry Path Resume 主路径

将 entry-path rebuild 从辅助边界接入 session resume 主路径。

核心变化：

- `SessionManager.loadSession()` 解析 JSONL 后，会先从 active entry leaf 沿 `parentEntryId` 得到当前 path，再重建 active messages。
- `RuntimeHost` resume/switch 后创建的 `AgentSession` 会直接使用 path-aware active messages。
- 旧 JSONL 没有 `entryId` / `parentEntryId` 时仍回退原有 flat rebuild。
- 测试覆盖 `SessionManager.loadSession()` 和 `RuntimeHost` resume/switch 主路径。

当前仍只支持当前 session 文件内的 entry path；跨 session parent/child graph、import/export 和 branch navigation 仍未实现。


# SessionContextRebuilder Entry Path 最小 rebuild

让 `SessionContextRebuilder` 从只返回 flat snapshot metadata，推进到可基于 active entry leaf 回溯当前 session 文件内的 entry path。

核心变化：

- `SessionManager` 新增带 payload 的 `getEntryPath()`，从 active entry leaf 沿 `parentEntryId` 回溯。
- `compaction` entry 新增可选 `firstKeptEntryId`，同时保留 `firstKeptMessageIndex` 兼容旧数据。
- `SessionContextRebuilder` 新增 `entry_path` strategy；新 session 有 entry metadata 时按 entry path 构造 messages。
- 旧 JSONL 没有 entry metadata 时仍回退 `flat_snapshot`。
- 测试覆盖手工分支 entry path、forked session 和 compacted fork session。

当前边界已接入 `SessionManager.loadSession()` 主路径；下一步需要补齐 clone/import/export 或 branch navigation。


# Session Entry Tree 最小 schema

为 M4 Session Tree 增加当前 session 文件内的 entry parent chain，继续向 `pi-mono` 的 append-only session tree 靠拢。

核心变化：

- 新写入的 `message`、`compaction`、`usage` 和 `internal` entry 都带有 `entryId` / `parentEntryId`。
- `SessionManager` 维护当前 session 的 active entry id，并在 reload 后继续从最新持久化 entry 追加。
- `SessionManager.getEntryTreeInfo()` 暴露当前 session 的 entry tree metadata。
- `SessionContextRebuilder` snapshot 增加 entry tree metadata。
- 旧 JSONL entries 没有 entry metadata 时仍兼容读取，不做强制迁移。

当前 schema 已可支撑当前 session 文件内的 entry-path rebuild；跨 session parent/child graph 仍未实现。


# SessionContextRebuilder 最小边界

为 M4 Session Tree 增加独立的 session context rebuild 边界，先保持现有 flat JSONL 行为不变。

核心变化：

- 新增 `src/core/session-context-rebuilder.ts`。
- 当前 rebuild strategy 为 `flat_snapshot`。
- snapshot 返回 active messages、lineage、branch path、compaction、usage 和 internal entries。
- 测试覆盖旧 flat JSONL session、forked session 和 compacted fork session。

当前仍未实现真正的 path-aware context rebuild；该边界用于后续替换现有 flat snapshot 逻辑。


# Session Tree Lineage / Fork 最小 schema

引入 M4 的第一步 session tree 基础：先在现有 flat JSONL session model 上增加向后兼容的 lineage metadata 和 fork 能力。

核心变化：

- `session_start` entry 增加可选 `parentSessionId`、`rootSessionId` 和 `forkedFromMessageIndex`。
- 旧 JSONL session 没有 lineage metadata 时会被视为 root session。
- `SessionManager.getLineageInfo()` 暴露 root/parent/fork point。
- `SessionManager.forkSession()` 可从当前 active context messages 创建分支 session。
- `RuntimeHost.forkSession()` 作为 mode 层统一 fork 边界。
- interactive/TUI slash command 支持 `/fork [id]`。

当前仍不是完整 session tree：尚未实现 path-aware context rebuild、clone、import/export、branch navigation 或完整 parent/child entry graph。


# RPC Permission Pending Approval 最小闭环

为 Headless RPC 增加可选的远程 tool permission approval 流程，同时保持默认 headless fail-closed 安全语义。

核心变化：

- RPC `prompt.params.permission_mode=request` 时启用当前 run 的 permission broker。
- 新增 `permission_pending` RPC event，输出 `permission_id`、tool call metadata、risk/source/category、只读信息和截断后的 args preview。
- 新增 `approve_permission` / `deny_permission` RPC 命令，用于解析 pending tool permission。
- `get_state` 增加 pending permission 摘要。
- pending permission 支持 timeout；`abort` active run 时会取消未解决的 pending permission。
- RPC mode 会继续写入 durable `permission_pending` internal entry，保持 diagnostics / resume 可见。

当前仍不是完整 ACP：尚未实现完整 permission modes、规则文件、危险命令分类器或 sandbox policy。


# Headless RPC 最小闭环

新增 JSONL stdin/stdout RPC mode，让 Eva 可以在无交互场景下通过稳定 envelope 驱动同一套 `RuntimeHost` / `AgentSession` 核心路径。

核心变化：

- 新增 `src/modes/rpc-mode.ts`，提供 `response`、`event` 和 `error` 三类 RPC envelope。
- CLI 增加 `--rpc` 入口，并在 RPC 模式下保持 stdout 只输出 JSONL 协议内容。
- RPC 支持 `prompt`、`get_state`、`abort`、`new_session` 和 `resume_session`。
- `prompt` 运行中会输出包裹后的 `AgentSessionEvent`，结束后返回 final response 和当前 state。
- RPC mode 允许 active prompt 期间处理 `abort` 和 `get_state`，但同一时间只允许一个 active prompt run。

当前仍是最小闭环：没有完整 ACP 兼容层。


# TUI 最小框架

引入自建 terminal UI 框架，并将无 task 的 CLI 默认入口切换为 TUI mode。

核心变化：

- 新增 `src/tui/`，包含差量渲染器、terminal 输入解析、组件模型和基础 UI 组件。
- 新增 `src/modes/tui-mode.ts`，复用 `RuntimeHost`、`AgentSession` 和 interactive slash command 处理。
- CLI 无 task 时默认进入 TUI；`--no-tui` 回退到原 readline interactive mode。
- TUI tool confirmation 适配当前 `allow` / `deny` / `ask` 权限模型。

当前仍是最小框架：TUI 组件尚未覆盖单元测试，终端兼容性和更细的 diagnostics 展示仍需后续完善。


# AgentMessage / LlmMessage 最小消息边界

引入 M2.x Agent Core Alignment 的第一步，把 agent 内部消息边界和 provider 请求消息边界拆开。

核心变化：

- 新增 `AgentMessage` / `LlmMessage` 类型边界，保留旧 `Message` 作为兼容别名。
- 新增默认 `transformContext()` 和 `convertToLlm()`。
- `runAgentLoop()` 在每次 provider call 前执行 `transformContext -> convertToLlm -> ContextBuilder.build -> LLMClient.generateStream`。
- `LLMClient` / `LLMClientBase` / token counting 路径改为接收 provider-facing `LlmMessage[]`。
- `ContextBuilder` 收敛为 provider request view builder，接收 `LlmMessage[]` 并返回 `ProviderRequestView`。
- `ContextManager` diagnostics 优先使用 `latestProviderRequestView` 计算 context usage。
- 新增 internal `AgentMessage` 最小类型，默认 `convertToLlm()` 会过滤 internal message，避免污染 provider request view。
- `ContextBuilder` 构造 provider request view 后，agent-loop 会追加 `resource_context` internal marker，用于记录 transient resource 注入摘要。
- `AgentSession.compact()` 成功后会向 Agent working history 追加 `compaction_summary` internal marker，用于记录压缩摘要和 compaction metadata。
- `SessionManager` 新增 durable `internal` session entry 边界，提供 `appendInternalEntry()` / `getInternalEntries()`，用于后续跨 resume 恢复 harness metadata，同时保持 provider-facing messages 不被 internal entry 污染。
- tool governance 在 permission pending 时会写入 `permission_pending` durable internal entry，`ContextManager` 与 interactive diagnostics 会展示 pending 概要。

当前仍是最小骨架：运行期 internal marker 默认仍不写入 flat JSONL message log，durable `internal` entry 只提供最小 metadata 恢复边界，完整 path-aware context rebuild 仍未实现。




# TokenCounter provider/local 计数边界

为上下文预算能力新增 `TokenCounter` 边界，让 `ContextManager` 可以区分 provider countTokens 与本地 token estimate。

核心变化：

- 新增 `src/core/token-counter.ts`。
- `LLMClient` / `LLMClientBase` 暴露 `countTokens(messages, tools)`。
- `AnthropicClient` 接入 Anthropic Messages countTokens API。
- OpenAI / Google 暂时走基类默认 `null`，由 TokenCounter 回退到本地 `gpt-tokenizer`。
- `ContextManager` 的 context usage diagnostics 增加 `countSource` 和 `method`。

当前仍不触发自动压缩，也不实现 OpenAI/Gemini provider countTokens。




# ContextBuilder / ContextManager 上下文管理分层

将上下文管理正式拆成两层：`ContextBuilder` 继续负责构造单次 LLM request messages，`ContextManager` 作为有状态上下文诊断聚合入口，承接后续 token budget、auto compact、prompt-too-long recovery 和 post-compact reinjection 的演进边界。

核心变化：

- 新增最小 `ContextManager`，聚合 `ContextBuilder.latestBuild`、active messages、step guard、compaction、usage 和 project context metadata。
- `RuntimeServices` 暴露 `contextManager`，并在 `reloadResources()` 后同步更新其持有的 `ContextBuilder`。
- interactive mode 的 `/stats` 与 `/diagnostics` 改为通过 `ContextManager` 读取 context 状态。
- `ContextBuilder.latestBuild` 增加本地 request token estimate 和 project context token estimate。
- 新增本地 token estimator，用于 diagnostics 可见性；provider 返回的 usage 仍作为真实用量来源。

当前仍不包含 provider API countTokens、model context window 百分比、完整 token budget、自动阈值 compaction、prompt-too-long recovery 或 post-compact resource budget。




# Manual `/compact` 最小闭环

引入 flat JSONL 兼容的手动上下文压缩能力，作为后续完整 ContextManager 之前的最小长任务治理闭环。

核心变化：

- interactive mode 支持 `/compact [custom instructions]`。
- `AgentSession.compact()` 负责调用当前 LLM 生成会话摘要。
- `SessionManager` 支持追加 `compaction` entry，并基于最新 compaction 重建当前活动上下文。
- compact 后当前上下文变为 system prompt、summary 和最近保留消息。
- 原始历史 message entries 仍保留在 JSONL session log 中。
- compaction 失败不会修改当前 session messages。

当前仍不包含自动阈值 compaction、prompt-too-long recovery、完整 token budget 或 session tree。




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

这次升级的重点不是继续往 `tools/` 里塞更多能力，而是把工具层收敛成稳定的 builtin tool 系统。`MCP / Skills` 这类能力后续会迁到 resource loader 或 extension 层，不再混在 tools 目录里。

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

这些属于后续工具层升级方向，等 RuntimeHost 和 resource loader 稳定后再继续推进。

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

## Runtime diagnostics 收敛

这次升级把启动期 diagnostics 从零散的 runtime/tool 提示，收敛成 core 层统一结构。目标是让 config、provider、tools、session、resource 的状态都从 runtime 边界返回，mode 层只负责展示。

---

### 重构前（diagnostics 来源分散）

`RuntimeDiagnostic` 只有：

- `type`
- `code`
- `message`
- `details`

工具层也有自己的 `ToolDiagnostic` 形状。`createRuntime()` 只记录 retry、system prompt 和 tools 装配结果，缺少 config、provider、session、resource 的统一状态。

问题是后续接入 `RuntimeServices`、resource loader、MCP 和 RPC 时，启动状态会继续散落在各层，mode 层也容易被迫理解 runtime 装配细节。

---

### 重构后（统一 diagnostics 结构）

新增 `src/diagnostics.ts`，统一结构为：

- `source`：`config`、`provider`、`tools`、`session`、`resource`
- `level`：`info`、`warning`、`error`
- `code`：稳定机器可读标识
- `message`：面向 UI 的简短说明
- `details`：结构化上下文

`type` 暂时保留为 `level` 的兼容别名，避免一次性改动现有 CLI 渲染路径。

---

### 当前覆盖范围

`createRuntime()` 现在负责收集：

- config loaded
- provider configured
- retry enabled
- system prompt loaded/missing
- skills、MCP 已配置但尚未加载
- session manager ready
- session created/loaded/latest loaded

`loadConfiguredTools()` 返回统一 tools diagnostics，包括：

- builtin tools loaded
- tool registry ready
- unknown enabled/disabled tools
- disabled tools/categories
- duplicate tools skipped

mode 层继续通过 `renderRuntimeDiagnostics()` 渲染，不直接参与 runtime 状态判断。

启动时默认过滤普通 `info` diagnostics，仅显示 warning/error 和少量关键 info。interactive mode 提供 `/diagnostics`，用于查看完整结构化 diagnostics。

---

### 带来的具体好处

**① Runtime 边界更清晰**

启动状态从 core 返回，CLI/interactive/print/RPC 只需要选择如何显示。

**② Resource Loader 有了落点**

system prompt、skills、MCP 当前都进入 `resource` source。后续引入 `RuntimeServices` 和 resource loader 时，可以直接扩展这条 diagnostics 路径。

**③ Headless/RPC 更容易接入**

RPC 不适合打印彩色启动日志，但可以直接把同一组 diagnostics 作为结构化事件或响应字段返回。

**④ 配置中的未实现能力不再静默**

当前配置里启用 skills、MCP 时，runtime 会明确给出 warning，而不是让用户误以为这些能力已经加载。

---

### 已验证

- 新增 runtime diagnostics 回归测试
- 覆盖 `config`、`provider`、`tools`、`session`、`resource` 五类 source
- 覆盖已配置但尚未加载的 skills、MCP resource warnings
- 覆盖启动 diagnostics 过滤策略
- 覆盖 `/diagnostics` 完整输出
- `npm run typecheck`
- `npm test`

---

### 仍待完成

- 后续 `RuntimeServices` 接入后，把 diagnostics 收集从 `createRuntime()` 进一步下沉到 services

---

### 一句话总结

> Runtime diagnostics 从“启动时顺手打印的提示”升级为“runtime 装配状态的结构化边界”；这为 RuntimeServices、resource loader 和 RPC 输出打好了基础。

## RuntimeServices 最小骨架

这次升级把 workspace 绑定的运行时服务从 `createRuntime()` 中拆出，新增 `src/core/runtime-services.ts`。目标是对齐 `pi-mono` 的 services/session creation 分层：先创建 cwd/workspace 绑定 services，再基于 services 创建当前 `AgentSession`。

---

### 重构前（createRuntime 继续变大）

`createRuntime()` 同时负责：

- 加载 config
- 解析 provider
- 创建 retry config
- 创建 `LLMClient`
- 加载 system prompt
- 加载 tools
- 创建 `SessionManager`
- 选择或创建 session
- 创建 `AgentSession`
- 收集 diagnostics

继续接 resource loader、project context、skills、MCP、context management 时，这个函数会重新变成组合根大杂烩。

---

### 重构后（services 与 session 创建分离）

新增：

`createRuntimeServices()`
- 创建 workspace 绑定 services
- 返回 config、provider、LLM client、retry、system prompt、tools、session manager 和 diagnostics
- 不创建 `AgentSession`
- 不选择具体 session

`createRuntime()`
- 调用 `createRuntimeServices()`
- 选择或创建当前 session
- 创建带工具治理 hook 的 `AgentSession`
- 将 services 暴露为 `runtime.services`

当前结构变为：

```text
RuntimeHost
  |
  v
createRuntime()
  |-- createRuntimeServices()
  |     |-- config/provider/retry
  |     |-- resources(system prompt placeholder)
  |     |-- tools
  |     `-- sessionManager
  `-- AgentSession
```

---

### 带来的具体好处

**① createRuntime 职责收缩**

`createRuntime()` 不再负责所有 workspace 绑定资源发现和服务创建，只负责把 services 变成当前可运行 session。

**② Resource Loader 有明确落点**

下一步可以在 `RuntimeServices` 内引入轻量 resource loader，先承载 system prompt，再接入 `AGENTS.md` 等项目上下文。

**③ Context Management 的前置边界更清晰**

后续 `/compact`、context rebuild、post-compact resource reinjection 不需要直接从 mode 或 session 中查找 config/system prompt/project context，而是通过 services/resource loader 获取。

**④ 更接近 pi-mono 的演进路径**

Eva 现在具备了 `services creation -> session creation -> runtime host` 的基本结构，后续可以逐步扩展，而不是复制 `pi-mono` 的完整复杂度。

---

### 已验证

- 新增 `RuntimeServices` 回归测试
- RuntimeHost new/resume/switch 测试保持通过
- runtime diagnostics 测试保持通过
- `npm run typecheck`
- `npm test`

---

### 仍待完成

- 引入真正的 Resource Loader
- 把 system prompt 加载从 services 内部 helper 迁入 Resource Loader
- 加载 `AGENTS.md` 项目上下文
- 支持 resource reload

---

### 一句话总结

> RuntimeServices 把 Eva 的 workspace 绑定服务从 session 创建里抽出来，建立了后续 Resource Loader、context management 和 RPC diagnostics 的承载边界。

## ResourceLoader 最小骨架

这次升级在 `RuntimeServices` 之内新增轻量 `ResourceLoader`。目标不是一次性实现完整 project context、skills 和 MCP，而是先把资源加载从 services helper 中拆出来，形成后续 reload、context budget 和 compaction reinjection 的边界。

---

### 当前能力

`src/core/resource-loader.ts` 现在负责：

- 加载 system prompt；
- system prompt 缺失时返回默认 prompt 和 warning diagnostic；
- 加载 workspace 根目录下的 `AGENTS.md`；
- 将 `AGENTS.md` 暴露为 `projectContext`；
- 对 skills、MCP 已配置但尚未接入 loader 的情况返回 warning diagnostics。

`RuntimeServices` 现在暴露：

```ts
runtime.services.resourceLoader
runtime.services.resourceLoader.projectContext
```

当前 `AGENTS.md` 先由 ResourceLoader 加载和暴露。后续 ContextBuilder 最小闭环已将它作为 transient project context 注入模型请求。

---

### 带来的具体好处

**① Resource 边界开始独立**

system prompt 和 project context 不再是 `RuntimeServices` 内部 helper，后续可以独立扩展 reload、预算控制和上下文注入策略。

**② AGENTS.md 有了事实来源**

项目上下文现在由 Resource Loader 读取，后续 mode、session、compaction 不需要自己查找文件。

**③ 为 context management 铺路**

后续 compact 后重新注入 project context、skills metadata 或 system prompt 时，可以通过同一条 resource loader 路径，而不是散落在 session 或 mode 层。

---

### 已验证

- 新增 `ResourceLoader` 回归测试
- 覆盖 `AGENTS.md` 加载
- 覆盖 system prompt 缺失 fallback
- `RuntimeServices` 测试覆盖 `resourceLoader`
- `npm run typecheck`
- `npm test`

---

### 仍待完成

- 接入 skills metadata
- 接入 MCP config diagnostics

---

### 一句话总结

> ResourceLoader 把 system prompt 和 project context 从 runtime 装配细节中抽出，成为 Eva 后续资源重载、上下文注入和 compaction reinjection 的统一入口。

## ContextBuilder 最小闭环

这次升级新增 `src/core/context-builder.ts`，把资源加载和模型请求上下文构造分开。目标是先让 `AGENTS.md` 真正进入模型上下文，同时不污染 session history。

---

### 当前能力

`ContextBuilder` 现在负责：

- 接收 durable session messages 和 project context；
- 在 LLM call 前构造 transient request messages；
- 将 `AGENTS.md` 插入第一条 system message 后；
- 在没有 system message 时用当前 system prompt 补齐；
- 返回 context diagnostics metadata。

`RuntimeServices` 现在暴露：

```ts
runtime.services.contextBuilder
```

agent loop 现在调用 LLM 前会先构造 request messages：

```text
durable session messages
  -> ContextBuilder.build()
  -> LLMClient.generateStream(requestMessages, tools)
```

assistant message 和 tool result 仍写回原始 durable messages，`AGENTS.md` 不会作为普通 user message 持久化。

---

### 带来的具体好处

**① AGENTS.md 真正进入模型上下文**

ResourceLoader 不再只是暴露 project context，模型请求会看到当前 workspace 的 `AGENTS.md`。

**② Session history 保持干净**

project context 是 request-time view，不会写入 JSONL session，后续 compact/rebuild 更容易控制。

**③ 为 ContextManager 铺路**

后续 token budget、summary、manual `/compact` 和 post-compact reinjection 可以在 ContextBuilder 之上演进，而不是改动 provider adapter 或 mode 层。

---

### 已验证

- 新增 `ContextBuilder` 回归测试
- 覆盖 agent loop transient context 注入
- 覆盖 AgentSession 不持久化 project context
- `RuntimeServices` 测试覆盖 `contextBuilder`
- `npm run typecheck`
- `npm test`

---

### 仍待完成

- manual `/compact`
- ContextManager

---

### 一句话总结

> ContextBuilder 把“发给模型的上下文视图”和“持久化的会话历史”分开，完成了 AGENTS.md 注入的最小安全闭环。
