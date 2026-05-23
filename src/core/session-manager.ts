import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, TokenUsage } from '../schema.js';
import {
  chooseFirstKeptMessageIndex,
  createCompactionSummaryMessage,
  rebuildCompactedMessages,
  type CompactionResult,
} from './compaction.js';
import {
  buildEntryPath,
  copySessionPathEntry,
  createEntryTreeFromPathEntries,
  createEntryTreeNode,
  createEntryTreeViewItem,
  entryTreeFields,
  readEntryTreeNode,
  SessionEntryStore,
} from './session-entry-store.js';
import { WorkspaceSessionStore } from './session-store.js';

type PersistenceMode = 'memory' | 'jsonl';

export const CURRENT_SESSION_SCHEMA_VERSION = 1;

export interface SessionStartEntry {
  type: 'session_start';
  sessionId: string;
  workspaceDir: string;
  createdAt: number;
  schemaVersion: number;
  parentSessionId?: string;
  rootSessionId?: string;
  forkedFromMessageIndex?: number;
}

export interface MessageEntry {
  type: 'message';
  sessionId: string;
  timestamp: number;
  entryId: string;
  parentEntryId: string | null;
  message: Message;
}

export interface CompactionEntry {
  type: 'compaction';
  sessionId: string;
  timestamp: number;
  entryId: string;
  parentEntryId: string | null;
  summary: string;
  firstKeptEntryId?: string;
  firstKeptMessageIndex: number;
  messagesBefore: number;
  messagesAfter: number;
  customInstructions?: string;
}

export type SessionUsageSource = 'assistant' | 'compaction';

export interface UsageEntry {
  type: 'usage';
  sessionId: string;
  timestamp: number;
  entryId: string;
  parentEntryId: string | null;
  source: SessionUsageSource;
  usage: TokenUsage;
}

export interface InternalEntry {
  type: 'internal';
  sessionId: string;
  timestamp: number;
  entryId: string;
  parentEntryId: string | null;
  kind: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface BranchSummaryEntry {
  type: 'branch_summary';
  sessionId: string;
  timestamp: number;
  entryId: string;
  parentEntryId: string | null;
  fromEntryId: string | null;
  toEntryId: string;
  pathEntryCount: number;
  messageCount: number;
  label?: string;
  reason?: string;
}

export interface LeafEntry {
  type: 'leaf';
  sessionId: string;
  timestamp: number;
  entryId: string;
  parentEntryId: string | null;
  targetEntryId: string | null;
}

export type SessionEntry =
  | SessionStartEntry
  | MessageEntry
  | CompactionEntry
  | UsageEntry
  | InternalEntry
  | BranchSummaryEntry
  | LeafEntry;

export type SessionEntryNodeType = Exclude<SessionEntry['type'], 'session_start'>;

export interface SessionEntryTreeNode {
  entryId: string;
  parentEntryId: string | null;
  type: SessionEntryNodeType;
  timestamp: number;
  messageIndex?: number;
  kind?: string;
}

export interface SessionEntryTreeInfo {
  sessionId: string;
  activeEntryId?: string;
  entries: SessionEntryTreeNode[];
}

export interface SessionEntryTreeViewItem {
  entryId: string;
  parentEntryId: string | null;
  type: SessionEntryNodeType;
  timestamp: number;
  isActive: boolean;
  isActivePath: boolean;
  messageIndex?: number;
  messageRole?: Message['role'];
  kind?: string;
  preview?: string;
}

export interface SessionEntryTreeViewNode {
  entry: SessionEntryTreeViewItem;
  children: SessionEntryTreeViewNode[];
}

export interface SessionBranchSummary {
  sessionId: string;
  leafEntryId: string;
  branchEntryId: string;
  fromEntryId: string | null;
  pathEntryCount: number;
  messageCount: number;
  targetEntry: SessionEntryTreeViewItem;
}

export interface SessionEntryPathState {
  messages: Message[];
  compaction: SessionCompactionInfo;
  usage: SessionUsageInfo;
  internalEntries: SessionInternalEntry[];
}

export type SessionPathEntry =
  | (MessageEntry & { entryId: string; parentEntryId: string | null })
  | (CompactionEntry & { entryId: string; parentEntryId: string | null })
  | (UsageEntry & { entryId: string; parentEntryId: string | null })
  | (InternalEntry & { entryId: string; parentEntryId: string | null })
  | (BranchSummaryEntry & { entryId: string; parentEntryId: string | null })
  | (LeafEntry & { entryId: string; parentEntryId: string | null });

interface SessionMetadata {
  createdAt: number;
  updatedAt: number;
}

export interface SessionCompactionInfo {
  compacted: boolean;
  timestamp?: number;
  summaryLength?: number;
  firstKeptEntryId?: string;
  firstKeptMessageIndex?: number;
  messagesBefore?: number;
  messagesAfter?: number;
  customInstructions?: string;
}

export interface SessionUsageInfo {
  count: number;
  total: TokenUsage;
  latest?: TokenUsage;
  latestTimestamp?: number;
  latestSource?: SessionUsageSource;
}

export type SessionInternalEntry = Omit<InternalEntry, 'type' | 'sessionId'>;

export interface SessionListItem {
  sessionId: string;
  messageCount: number;
  updatedAt: number;
  isLatest: boolean;
  parentSessionId?: string;
  rootSessionId: string;
  forkedFromMessageIndex?: number;
}

export interface SessionTreeNode {
  session: SessionListItem;
  children: SessionTreeNode[];
}

export interface SessionLineageInfo {
  sessionId: string;
  parentSessionId?: string;
  rootSessionId: string;
  forkedFromMessageIndex?: number;
  createdAt?: number;
}

export interface SessionFormatInfo {
  schemaVersion: number;
}

export interface SessionExportResult {
  sessionId: string;
  path: string;
}

export interface SessionImportResult {
  sessionId: string;
  sourcePath: string;
  destinationPath?: string;
}

interface SessionLineageOptions {
  parentSessionId?: string;
  rootSessionId?: string;
  forkedFromMessageIndex?: number;
}

interface ParsedSessionLog {
  state: SessionEntryPathState;
  createdAt?: number;
  updatedAt: number;
  lineage: SessionLineageInfo;
  entryTree: SessionEntryTreeNode[];
  pathEntries: SessionPathEntry[];
  activeEntryId?: string;
  format: SessionFormatInfo;
}

export class SessionManager {
  private readonly mode: PersistenceMode;
  private readonly workspaceDir: string;
  private readonly store: WorkspaceSessionStore;
  // Runtime cache for the current active leaf path, not the canonical session history.
  private readonly sessions = new Map<string, Message[]>();
  private readonly sessionMetadata = new Map<string, SessionMetadata>();
  private readonly sessionCompactions = new Map<string, SessionCompactionInfo>();
  private readonly sessionUsage = new Map<string, SessionUsageInfo>();
  private readonly sessionInternalEntries = new Map<string, SessionInternalEntry[]>();
  private readonly sessionLineage = new Map<string, SessionLineageInfo>();
  private readonly sessionFormats = new Map<string, SessionFormatInfo>();
  private readonly sessionEntries = new Map<string, SessionEntryStore>();
  private latestSessionId?: string;

  constructor({
    workspaceDir,
    mode = 'jsonl',
    baseDir,
  }: {
    workspaceDir: string;
    mode?: PersistenceMode;
    baseDir?: string;
  }) {
    this.mode = mode;
    this.workspaceDir = path.resolve(workspaceDir);
    this.store = new WorkspaceSessionStore(
      this.workspaceDir,
      baseDir ?? path.join(os.homedir(), '.eva-ai', 'sessions'),
    );
  }

  async createSession(systemPrompt: string, sessionId?: string, lineage?: SessionLineageOptions): Promise<string> {
    const id = sessionId ?? randomUUID();
    const now = Date.now();
    const initialMessages: Message[] = [{ role: 'system', content: systemPrompt }];
    const lineageInfo = createLineageInfo(id, now, lineage);
    const systemEntryNode = createEntryTreeNode({
      parentEntryId: null,
      type: 'message',
      timestamp: now,
      messageIndex: 0,
    });
    const initialPathEntries = [createMessagePathEntry({
      sessionId: id,
      timestamp: now,
      entryNode: systemEntryNode,
      message: initialMessages[0],
    })];
    const initialState = buildSessionStateFromEntryPath(initialPathEntries);
    this.sessionMetadata.set(id, { createdAt: now, updatedAt: now });
    this.sessionLineage.set(id, lineageInfo);
    this.sessionFormats.set(id, createCurrentSessionFormatInfo());
    this.sessionEntries.set(id, new SessionEntryStore({
      entryTree: [systemEntryNode],
      pathEntries: initialPathEntries,
      activeEntryId: systemEntryNode.entryId,
    }));
    this.applyEntryPathState(id, initialState);
    this.latestSessionId = id;

    if (this.mode === 'jsonl') {
      await this.writeSessionStart(id, now, lineageInfo);
      await this.store.appendEntry({
        type: 'message',
        sessionId: id,
        timestamp: now,
        ...entryTreeFields(systemEntryNode),
        message: initialMessages[0],
      });
      await this.store.writeManifest({ latestSessionId: id, updatedAt: now });
    }
    return id;
  }

  async forkSession({
    sourceSessionId,
    sessionId,
    leafEntryId,
  }: {
    sourceSessionId: string;
    sessionId?: string;
    leafEntryId?: string;
  }): Promise<string> {
    if (!this.sessions.has(sourceSessionId) && !await this.loadSession(sourceSessionId)) {
      throw new Error(`Session not found: ${sourceSessionId}`);
    }

    const id = sessionId ?? randomUUID();
    const now = Date.now();
    const sourceEntryPath = this.getEntryPath(sourceSessionId, leafEntryId);
    if (!sourceEntryPath.length) {
      if (leafEntryId) {
        throw new Error(`Entry not found in session ${sourceSessionId}: ${leafEntryId}`);
      }
      throw new Error(`Session has no active entry path: ${sourceSessionId}`);
    }
    const forkedPathEntries = sourceEntryPath.map((entry) => copySessionPathEntryForSession(entry, id));
    const forkedState = buildSessionStateFromEntryPath(forkedPathEntries);
    if (!forkedState.messages.length) {
      throw new Error(`Session has no messages to fork: ${sourceSessionId}`);
    }
    const forkedEntryNodes = createEntryTreeFromPathEntries(forkedPathEntries);
    const sourceLineage = this.getLineageInfo(sourceSessionId);
    const lineageInfo = createLineageInfo(id, now, {
      parentSessionId: sourceSessionId,
      rootSessionId: sourceLineage.rootSessionId,
      forkedFromMessageIndex: forkedState.messages.length - 1,
    });

    this.sessionMetadata.set(id, { createdAt: now, updatedAt: now });
    this.sessionLineage.set(id, lineageInfo);
    this.sessionFormats.set(id, createCurrentSessionFormatInfo());
    this.sessionEntries.set(id, new SessionEntryStore({
      entryTree: forkedEntryNodes,
      pathEntries: forkedPathEntries,
      activeEntryId: forkedEntryNodes[forkedEntryNodes.length - 1]?.entryId,
    }));
    this.applyEntryPathState(id, forkedState);
    this.latestSessionId = id;

    if (this.mode === 'jsonl') {
      await this.writeSessionStart(id, now, lineageInfo);
      for (const entry of forkedPathEntries) {
        await this.store.appendEntry(entry);
      }
      await this.store.writeManifest({ latestSessionId: id, updatedAt: now });
    }

    return id;
  }

  async cloneSession({
    sourceSessionId,
    sessionId,
    leafEntryId,
  }: {
    sourceSessionId: string;
    sessionId?: string;
    leafEntryId?: string;
  }): Promise<string> {
    return this.forkSession({ sourceSessionId, sessionId, leafEntryId });
  }

  async exportSession({
    sessionId,
    outputPath,
  }: {
    sessionId: string;
    outputPath?: string;
  }): Promise<SessionExportResult> {
    if (!this.sessions.has(sessionId) && !await this.loadSession(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const resolvedOutputPath = path.resolve(outputPath ?? `${sessionId}.jsonl`);
    await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });

    if (this.mode === 'jsonl') {
      await this.store.copySessionLog(sessionId, resolvedOutputPath);
      return { sessionId, path: resolvedOutputPath };
    }

    const content = this.serializeMemorySessionLog(sessionId);
    await fs.writeFile(resolvedOutputPath, content, 'utf-8');
    return { sessionId, path: resolvedOutputPath };
  }

  async importSession({
    inputPath,
    sessionId,
  }: {
    inputPath: string;
    sessionId?: string;
  }): Promise<SessionImportResult> {
    const resolvedInputPath = path.resolve(inputPath);
    const content = await fs.readFile(resolvedInputPath, 'utf-8');
    const importedSessionId = getSessionIdFromLog(content);
    if (!importedSessionId) {
      throw new Error('Imported session JSONL is missing a session_start entry');
    }

    const targetSessionId = sessionId ?? importedSessionId;
    const rewrittenContent = rewriteImportedSessionLog({
      content,
      importedSessionId,
      targetSessionId,
      workspaceDir: this.workspaceDir,
    });
    const parsed = this.parseSessionLog(rewrittenContent, targetSessionId);
    if (!parsed.state.messages.length) {
      throw new Error(`Imported session has no messages: ${targetSessionId}`);
    }

    this.applyParsedSessionLog(targetSessionId, parsed);
    this.latestSessionId = targetSessionId;

    let destinationPath: string | undefined;
    if (this.mode === 'jsonl') {
      destinationPath = this.store.getSessionFilePath(targetSessionId);
      await this.store.writeSessionLog(targetSessionId, rewrittenContent);
      await this.store.writeManifest({ latestSessionId: targetSessionId, updatedAt: Date.now() });
    }

    return { sessionId: targetSessionId, sourcePath: resolvedInputPath, destinationPath };
  }

  async loadLatestSession(): Promise<string | null> {
    if (this.mode !== 'jsonl') return null;
    try {
      const manifest = await this.store.readManifest();
      if (!manifest?.latestSessionId) return null;
      await this.loadSession(manifest.latestSessionId);
      return manifest.latestSessionId;
    } catch {
      return null;
    }
  }

  async loadSession(sessionId: string): Promise<boolean> {
    if (this.sessions.has(sessionId)) {
      await this.markLatestSession(sessionId);
      return true;
    }
    if (this.mode !== 'jsonl') return false;

    try {
      const content = await this.store.readSessionLog(sessionId);
      const parsed = this.parseSessionLog(content, sessionId);
      if (!parsed.state.messages.length) return false;
      this.applyParsedSessionLog(sessionId, parsed);
      await this.markLatestSession(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  getMessages(sessionId: string): Message[] {
    return this.getActiveState(sessionId).messages;
  }

  getCompactionInfo(sessionId: string): SessionCompactionInfo {
    return this.getActiveState(sessionId).compaction;
  }

  getUsageInfo(sessionId: string): SessionUsageInfo {
    return this.getActiveState(sessionId).usage;
  }

  getInternalEntries(sessionId: string, kind?: string): SessionInternalEntry[] {
    const entries = this.getActiveState(sessionId).internalEntries;
    return entries
      .filter((entry) => !kind || entry.kind === kind)
      .map(copyInternalEntry);
  }

  getLineageInfo(sessionId: string): SessionLineageInfo {
    return copyLineageInfo(this.sessionLineage.get(sessionId) ?? createLineageInfo(sessionId));
  }

  getSessionFormatInfo(sessionId: string): SessionFormatInfo {
    return copySessionFormatInfo(this.sessionFormats.get(sessionId) ?? createCurrentSessionFormatInfo());
  }

  getEntryTreeInfo(sessionId: string): SessionEntryTreeInfo {
    return this.sessionEntries.get(sessionId)?.getEntryTreeInfo(sessionId) ?? { sessionId, entries: [] };
  }

  getActiveState(sessionId: string): SessionEntryPathState {
    return copySessionEntryPathState(this.buildActiveState(sessionId));
  }

  listEntryTree(sessionId: string): SessionEntryTreeViewNode[] {
    return this.sessionEntries.get(sessionId)?.listEntryTree() ?? [];
  }

  getEntryPath(sessionId: string, leafEntryId?: string): SessionPathEntry[] {
    return this.sessionEntries.get(sessionId)?.getEntryPath(leafEntryId) ?? [];
  }

  async branchSession({
    sessionId,
    leafEntryId,
  }: {
    sessionId: string;
    leafEntryId: string;
  }): Promise<SessionBranchSummary> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const entryStore = this.requireSessionEntryStore(sessionId);
    const fromEntryId = entryStore.getActiveEntryId() ?? null;
    const { entryPath, state, targetEntry } = this.applyActiveEntryPath(sessionId, leafEntryId);
    const now = Date.now();
    const leafEntryNode = createEntryTreeNode({
      parentEntryId: fromEntryId,
      type: 'leaf',
      timestamp: now,
    });
    entryStore.appendEntryTreeNode(leafEntryNode, { setActive: false });
    entryStore.appendPathEntry({
      type: 'leaf',
      sessionId,
      timestamp: now,
      ...entryTreeFields(leafEntryNode),
      targetEntryId: leafEntryId,
    });
    entryStore.setActiveEntryId(leafEntryId);
    const branchEntryNode = entryStore.createNextEntryTreeNode('branch_summary', now);
    entryStore.appendEntryTreeNode(branchEntryNode);
    entryStore.appendPathEntry({
      type: 'branch_summary',
      sessionId,
      timestamp: now,
      ...entryTreeFields(branchEntryNode),
      fromEntryId,
      toEntryId: leafEntryId,
      pathEntryCount: entryPath.length,
      messageCount: state.messages.length,
    });
    this.touchSession(sessionId, now);

    const metadata = entryStore.getEntryTree().find(
      (entry) => entry.entryId === leafEntryId,
    );
    const summary: SessionBranchSummary = {
      sessionId,
      leafEntryId,
      branchEntryId: branchEntryNode.entryId,
      fromEntryId,
      pathEntryCount: entryPath.length,
      messageCount: state.messages.length,
      targetEntry: createEntryTreeViewItem({
        entry: targetEntry,
        metadata,
        activeEntryId: branchEntryNode.entryId,
        activePathEntryIds: new Set([...entryPath.map((entry) => entry.entryId), branchEntryNode.entryId]),
      }),
    };

    if (this.mode === 'jsonl') {
      await this.store.appendEntry({
        type: 'leaf',
        sessionId,
        timestamp: now,
        ...entryTreeFields(leafEntryNode),
        targetEntryId: leafEntryId,
      });
      await this.store.appendEntry({
        type: 'branch_summary',
        sessionId,
        timestamp: now,
        ...entryTreeFields(branchEntryNode),
        fromEntryId,
        toEntryId: leafEntryId,
        pathEntryCount: entryPath.length,
        messageCount: state.messages.length,
      });
      await this.store.writeManifest({ latestSessionId: sessionId, updatedAt: now });
    }

    return summary;
  }

  async appendMessage(sessionId: string, message: Message): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const existing = this.buildActiveState(sessionId).messages;
    const now = Date.now();
    const entryStore = this.requireSessionEntryStore(sessionId);
    const entryNode = entryStore.createNextEntryTreeNode('message', now, {
      messageIndex: existing.length,
    });
    entryStore.appendEntryTreeNode(entryNode);
    entryStore.appendPathEntry(createMessagePathEntry({
      sessionId,
      timestamp: now,
      entryNode,
      message,
    }));
    this.syncActiveStateCache(sessionId);
    this.touchSession(sessionId, now);

    if (this.mode === 'jsonl') {
      await this.store.appendEntry({
        type: 'message',
        sessionId,
        timestamp: now,
        ...entryTreeFields(entryNode),
        message,
      });
      await this.store.writeManifest({ latestSessionId: sessionId, updatedAt: now });
    }
  }

  async appendUsage({
    sessionId,
    usage,
    source = 'assistant',
  }: {
    sessionId: string;
    usage: TokenUsage;
    source?: SessionUsageSource;
  }): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const now = Date.now();
    const entryStore = this.requireSessionEntryStore(sessionId);
    const entryNode = entryStore.createNextEntryTreeNode('usage', now);
    entryStore.appendEntryTreeNode(entryNode);
    entryStore.appendPathEntry({
      type: 'usage',
      sessionId,
      timestamp: now,
      ...entryTreeFields(entryNode),
      source,
      usage: { ...usage },
    });
    this.syncActiveStateCache(sessionId);
    this.touchSession(sessionId, now);

    if (this.mode === 'jsonl') {
      await this.store.appendEntry({
        type: 'usage',
        sessionId,
        timestamp: now,
        ...entryTreeFields(entryNode),
        source,
        usage,
      });
      await this.store.writeManifest({ latestSessionId: sessionId, updatedAt: now });
    }
  }

  async appendInternalEntry({
    sessionId,
    kind,
    content,
    metadata,
  }: {
    sessionId: string;
    kind: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionInternalEntry> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!kind.trim()) {
      throw new Error('Internal entry kind is required');
    }

    const normalizedKind = kind.trim();
    const now = Date.now();
    const entryStore = this.requireSessionEntryStore(sessionId);
    const entryNode = entryStore.createNextEntryTreeNode('internal', now, {
      kind: normalizedKind,
    });
    const entry: SessionInternalEntry = {
      timestamp: now,
      ...entryTreeFields(entryNode),
      kind: normalizedKind,
      content,
      metadata: metadata ? { ...metadata } : undefined,
    };
    entryStore.appendEntryTreeNode(entryNode);
    entryStore.appendPathEntry({
      type: 'internal',
      sessionId,
      ...entryTreeFields(entryNode),
      ...copyInternalEntry(entry),
    });
    this.syncActiveStateCache(sessionId);
    this.touchSession(sessionId, now);

    if (this.mode === 'jsonl') {
      await this.store.appendEntry({
        type: 'internal',
        sessionId,
        ...entryTreeFields(entryNode),
        ...entry,
      });
      await this.store.writeManifest({ latestSessionId: sessionId, updatedAt: now });
    }

    return copyInternalEntry(entry);
  }

  async appendCompaction({
    sessionId,
    summary,
    customInstructions,
    keepRecentMessages = 8,
  }: {
    sessionId: string;
    summary: string;
    customInstructions?: string;
    keepRecentMessages?: number;
  }): Promise<CompactionResult> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const existing = this.buildActiveState(sessionId).messages;
    if (existing.length <= 2) {
      throw new Error('Nothing to compact (session too small)');
    }

    const firstKeptMessageIndex = chooseFirstKeptMessageIndex(existing, keepRecentMessages);
    const compactedMessages = rebuildCompactedMessages({
      messages: existing,
      summary,
      firstKeptMessageIndex,
    });
    const now = Date.now();
    const entryStore = this.requireSessionEntryStore(sessionId);
    const entryNode = entryStore.createNextEntryTreeNode('compaction', now);
    const firstKeptEntryId = findFirstKeptEntryIdFromPath(
      this.getEntryPath(sessionId),
      firstKeptMessageIndex,
    );
    const result: CompactionResult = {
      summary,
      firstKeptMessageIndex,
      messagesBefore: existing.length,
      messagesAfter: compactedMessages.length,
    };

    entryStore.appendEntryTreeNode(entryNode);
    entryStore.appendPathEntry({
      type: 'compaction',
      sessionId,
      timestamp: now,
      ...entryTreeFields(entryNode),
      summary,
      firstKeptEntryId,
      firstKeptMessageIndex,
      messagesBefore: result.messagesBefore,
      messagesAfter: result.messagesAfter,
      customInstructions,
    });
    this.syncActiveStateCache(sessionId);
    this.touchSession(sessionId, now);

    if (this.mode === 'jsonl') {
      await this.store.appendEntry({
        type: 'compaction',
        sessionId,
        timestamp: now,
        ...entryTreeFields(entryNode),
        summary,
        firstKeptEntryId,
        firstKeptMessageIndex,
        messagesBefore: result.messagesBefore,
        messagesAfter: result.messagesAfter,
        customInstructions,
      });
      await this.store.writeManifest({ latestSessionId: sessionId, updatedAt: now });
    }

    return result;
  }

  async resetSession(sessionId: string, systemPrompt: string): Promise<void> {
    const now = Date.now();
    const resetMessages: Message[] = [{ role: 'system', content: systemPrompt }];
    const systemEntryNode = createEntryTreeNode({
      parentEntryId: null,
      type: 'message',
      timestamp: now,
      messageIndex: 0,
    });
    const resetPathEntries = [createMessagePathEntry({
      sessionId,
      timestamp: now,
      entryNode: systemEntryNode,
      message: resetMessages[0],
    })];
    const resetState = buildSessionStateFromEntryPath(resetPathEntries);
    const lineageInfo = this.sessionLineage.get(sessionId) ?? createLineageInfo(sessionId, now);
    this.sessionLineage.set(sessionId, lineageInfo);
    this.sessionFormats.set(sessionId, createCurrentSessionFormatInfo());
    this.sessionEntries.set(sessionId, new SessionEntryStore({
      entryTree: [systemEntryNode],
      pathEntries: resetPathEntries,
      activeEntryId: systemEntryNode.entryId,
    }));
    this.applyEntryPathState(sessionId, resetState);
    this.touchSession(sessionId, now);

    if (this.mode === 'jsonl') {
      await this.writeSessionStart(sessionId, now, lineageInfo);
      await this.store.appendEntry({
        type: 'message',
        sessionId,
        timestamp: now,
        ...entryTreeFields(systemEntryNode),
        message: resetMessages[0],
      });
      await this.store.writeManifest({ latestSessionId: sessionId, updatedAt: now });
    }
  }

  async listSessions(): Promise<SessionListItem[]> {
    if (this.mode === 'memory') {
      return this.sortSessionList(
        [...this.sessions.keys()].map((sessionId) => {
          const lineage = this.getLineageInfo(sessionId);
          return {
            sessionId,
            messageCount: this.buildActiveState(sessionId).messages.length,
            updatedAt: this.sessionMetadata.get(sessionId)?.updatedAt ?? 0,
            isLatest: this.latestSessionId === sessionId,
            parentSessionId: lineage.parentSessionId,
            rootSessionId: lineage.rootSessionId,
            forkedFromMessageIndex: lineage.forkedFromMessageIndex,
          };
        }),
      );
    }

    const manifest = await this.store.readManifest();
    const sessions: SessionListItem[] = [];
    for (const sessionId of await this.store.listSessionIds()) {
      try {
        const content = await this.store.readSessionLog(sessionId);
        const parsed = this.parseSessionLog(content, sessionId);
        if (!parsed.state.messages.length) continue;
        sessions.push({
          sessionId,
          messageCount: parsed.state.messages.length,
          updatedAt: parsed.updatedAt,
          isLatest: manifest?.latestSessionId === sessionId,
          parentSessionId: parsed.lineage.parentSessionId,
          rootSessionId: parsed.lineage.rootSessionId,
          forkedFromMessageIndex: parsed.lineage.forkedFromMessageIndex,
        });
      } catch {
        continue;
      }
    }

    return this.sortSessionList(sessions);
  }

  async listSessionTree(): Promise<SessionTreeNode[]> {
    const sessions = await this.listSessions();
    const nodes = new Map<string, SessionTreeNode>();
    for (const session of sessions) {
      nodes.set(session.sessionId, { session, children: [] });
    }

    const roots: SessionTreeNode[] = [];
    for (const node of nodes.values()) {
      const parentSessionId = node.session.parentSessionId;
      const parent = parentSessionId ? nodes.get(parentSessionId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    const sortNodes = (treeNodes: SessionTreeNode[]): SessionTreeNode[] => {
      treeNodes.sort((a, b) => (
        b.session.updatedAt - a.session.updatedAt
        || a.session.sessionId.localeCompare(b.session.sessionId)
      ));
      for (const node of treeNodes) {
        sortNodes(node.children);
      }
      return treeNodes;
    };

    return sortNodes(roots);
  }

  async listChildSessions(sessionId: string): Promise<SessionListItem[]> {
    const sessions = await this.listSessions();
    return sessions.filter((session) => session.parentSessionId === sessionId);
  }

  private async writeSessionStart(
    sessionId: string,
    createdAt = Date.now(),
    lineage = createLineageInfo(sessionId, createdAt),
  ): Promise<void> {
    const entry: SessionStartEntry = {
      type: 'session_start',
      sessionId,
      workspaceDir: this.workspaceDir,
      createdAt,
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
      parentSessionId: lineage.parentSessionId,
      rootSessionId: lineage.rootSessionId,
      forkedFromMessageIndex: lineage.forkedFromMessageIndex,
    };
    await this.store.writeSessionStart(entry);
  }

  private serializeMemorySessionLog(sessionId: string): string {
    const metadata = this.sessionMetadata.get(sessionId);
    const lineage = this.getLineageInfo(sessionId);
    const createdAt = metadata?.createdAt ?? Date.now();
    const lines = [
      JSON.stringify({
        type: 'session_start',
        sessionId,
        workspaceDir: this.workspaceDir,
        createdAt,
        schemaVersion: this.getSessionFormatInfo(sessionId).schemaVersion ?? CURRENT_SESSION_SCHEMA_VERSION,
        parentSessionId: lineage.parentSessionId,
        rootSessionId: lineage.rootSessionId,
        forkedFromMessageIndex: lineage.forkedFromMessageIndex,
      } satisfies SessionStartEntry),
    ];

    const pathEntries = this.sessionEntries.get(sessionId)?.getPathEntries() ?? [];
    lines.push(...pathEntries.map((entry) => JSON.stringify(entry)));

    return `${lines.join('\n')}\n`;
  }

  private touchSession(sessionId: string, updatedAt: number): void {
    const existing = this.sessionMetadata.get(sessionId);
    this.sessionMetadata.set(sessionId, {
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
    });
    this.latestSessionId = sessionId;
  }

  private applyActiveEntryPath(sessionId: string, leafEntryId: string): {
    entryPath: SessionPathEntry[];
    state: SessionEntryPathState;
    targetEntry: SessionPathEntry;
  } {
    const entryPath = this.getEntryPath(sessionId, leafEntryId);
    if (!entryPath.length) {
      throw new Error(`Entry not found in session ${sessionId}: ${leafEntryId}`);
    }

    const state = buildSessionStateFromEntryPath(entryPath);
    if (!state.messages.length) {
      throw new Error(`Entry path has no messages in session ${sessionId}: ${leafEntryId}`);
    }

    const targetEntry = entryPath[entryPath.length - 1];
    if (!targetEntry) {
      throw new Error(`Entry path has no target in session ${sessionId}: ${leafEntryId}`);
    }

    this.applyEntryPathState(sessionId, state);
    this.requireSessionEntryStore(sessionId).setActiveEntryId(leafEntryId);

    return { entryPath, state, targetEntry };
  }

  private applyEntryPathState(sessionId: string, state: SessionEntryPathState): void {
    const copiedState = copySessionEntryPathState(state);
    this.sessions.set(sessionId, copiedState.messages);
    this.sessionCompactions.set(sessionId, copiedState.compaction);
    this.sessionUsage.set(sessionId, copiedState.usage);
    this.sessionInternalEntries.set(sessionId, copiedState.internalEntries);
  }

  private syncActiveStateCache(sessionId: string): SessionEntryPathState {
    const state = this.buildActiveState(sessionId);
    this.applyEntryPathState(sessionId, state);
    return state;
  }

  private applyParsedSessionLog(sessionId: string, parsed: ParsedSessionLog): void {
    this.sessionMetadata.set(sessionId, {
      createdAt: parsed.createdAt ?? parsed.updatedAt,
      updatedAt: parsed.updatedAt,
    });
    this.sessionLineage.set(sessionId, parsed.lineage);
    this.sessionFormats.set(sessionId, parsed.format);
    this.sessionEntries.set(sessionId, new SessionEntryStore({
      entryTree: parsed.entryTree,
      pathEntries: parsed.pathEntries,
      activeEntryId: parsed.activeEntryId,
    }));
    if (parsed.activeEntryId && parsed.pathEntries.length) {
      this.applyActiveEntryPath(sessionId, parsed.activeEntryId);
    } else {
      this.applyEntryPathState(sessionId, parsed.state);
      this.sessionEntries.get(sessionId)?.setActiveEntryId(parsed.activeEntryId);
    }
  }

  private requireSessionEntryStore(sessionId: string): SessionEntryStore {
    const entryStore = this.sessionEntries.get(sessionId);
    if (!entryStore) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return entryStore;
  }

  private buildActiveState(sessionId: string): SessionEntryPathState {
    return buildSessionStateFromEntryPath(this.getEntryPath(sessionId));
  }

  private async markLatestSession(sessionId: string): Promise<void> {
    const updatedAt = Date.now();
    this.touchSession(sessionId, updatedAt);
    if (this.mode === 'jsonl') {
      await this.store.writeManifest({ latestSessionId: sessionId, updatedAt });
    }
  }

  private parseSessionLog(
    content: string,
    sessionId: string,
  ): ParsedSessionLog {
    let createdAt: number | undefined;
    let updatedAt = 0;
    let lineage = createLineageInfo(sessionId);
    const entryTree: SessionEntryTreeNode[] = [];
    const pathEntries: SessionPathEntry[] = [];
    let activeEntryId: string | undefined;
    let format = createCurrentSessionFormatInfo();
    let hasCurrentSessionStart = false;
    let messageIndex = 0;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as SessionEntry;
        if (entry.sessionId !== sessionId) continue;
        if (entry.type === 'session_start') {
          if (entry.schemaVersion !== CURRENT_SESSION_SCHEMA_VERSION) continue;
          hasCurrentSessionStart = true;
          createdAt = entry.createdAt;
          updatedAt = Math.max(updatedAt, entry.createdAt);
          format = readSessionFormatInfo(entry);
          lineage = createLineageInfo(sessionId, entry.createdAt, {
            parentSessionId: entry.parentSessionId,
            rootSessionId: entry.rootSessionId,
            forkedFromMessageIndex: entry.forkedFromMessageIndex,
          });
          continue;
        }
        if (!hasCurrentSessionStart) continue;
        if (entry.type === 'message') {
          const entryNode = readEntryTreeNode(entry, {
            messageIndex,
          });
          if (!entryNode) continue;
          messageIndex += 1;
          entryTree.push(entryNode);
          pathEntries.push(copySessionPathEntry({
            ...entry,
            entryId: entryNode.entryId,
            parentEntryId: entryNode.parentEntryId,
          }));
          activeEntryId = entryNode.entryId;
          updatedAt = Math.max(updatedAt, entry.timestamp);
          continue;
        }
        if (entry.type === 'compaction') {
          const entryNode = readEntryTreeNode(entry);
          if (!entryNode) continue;
          entryTree.push(entryNode);
          pathEntries.push(copySessionPathEntry({
            ...entry,
            entryId: entryNode.entryId,
            parentEntryId: entryNode.parentEntryId,
          }));
          activeEntryId = entryNode.entryId;
          updatedAt = Math.max(updatedAt, entry.timestamp);
          continue;
        }
        if (entry.type === 'usage') {
          const entryNode = readEntryTreeNode(entry);
          if (!entryNode) continue;
          entryTree.push(entryNode);
          pathEntries.push(copySessionPathEntry({
            ...entry,
            entryId: entryNode.entryId,
            parentEntryId: entryNode.parentEntryId,
          }));
          activeEntryId = entryNode.entryId;
          updatedAt = Math.max(updatedAt, entry.timestamp);
          continue;
        }
        if (entry.type === 'internal') {
          const entryNode = readEntryTreeNode(entry, { kind: entry.kind });
          if (!entryNode) continue;
          entryTree.push(entryNode);
          pathEntries.push(copySessionPathEntry({
            ...entry,
            entryId: entryNode.entryId,
            parentEntryId: entryNode.parentEntryId,
          }));
          activeEntryId = entryNode.entryId;
          updatedAt = Math.max(updatedAt, entry.timestamp);
          continue;
        }
        if (entry.type === 'branch_summary') {
          const entryNode = readEntryTreeNode(entry);
          if (!entryNode) continue;
          entryTree.push(entryNode);
          pathEntries.push(copySessionPathEntry({
            ...entry,
            entryId: entryNode.entryId,
            parentEntryId: entryNode.parentEntryId,
          }));
          activeEntryId = entryNode.entryId;
          updatedAt = Math.max(updatedAt, entry.timestamp);
          continue;
        }
        if (entry.type === 'leaf') {
          const entryNode = readEntryTreeNode(entry);
          if (!entryNode) continue;
          entryTree.push(entryNode);
          pathEntries.push(copySessionPathEntry({
            ...entry,
            entryId: entryNode.entryId,
            parentEntryId: entryNode.parentEntryId,
          }));
          activeEntryId = entry.targetEntryId ?? undefined;
          updatedAt = Math.max(updatedAt, entry.timestamp);
        }
      } catch {
        continue;
      }
    }

    const activePathEntries = buildEntryPath(pathEntries, activeEntryId);
    const activeState = buildSessionStateFromEntryPath(activePathEntries);

    return {
      state: activeState,
      createdAt,
      updatedAt,
      lineage,
      entryTree,
      pathEntries,
      activeEntryId,
      format,
    };
  }

  private sortSessionList(sessions: SessionListItem[]): SessionListItem[] {
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
  }
}

function createMessagePathEntry({
  sessionId,
  timestamp,
  entryNode,
  message,
}: {
  sessionId: string;
  timestamp: number;
  entryNode: SessionEntryTreeNode;
  message: Message;
}): SessionPathEntry {
  return {
    type: 'message',
    sessionId,
    timestamp,
    ...entryTreeFields(entryNode),
    message: copyMessage(message),
  };
}

function findFirstKeptEntryIdFromPath(
  entries: SessionPathEntry[],
  firstKeptMessageIndex: number,
): string | undefined {
  let messageIndex = 0;
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    if (messageIndex === firstKeptMessageIndex) return entry.entryId;
    messageIndex += 1;
  }
  return undefined;
}

function copySessionPathEntryForSession(entry: SessionPathEntry, sessionId: string): SessionPathEntry {
  const copy = copySessionPathEntry(entry);
  copy.sessionId = sessionId;
  return copy;
}

export function buildSessionStateFromEntryPath(entryPath: SessionPathEntry[]): SessionEntryPathState {
  return {
    messages: rebuildMessagesFromEntryPath(entryPath),
    compaction: getLatestCompactionFromPath(entryPath),
    usage: getUsageFromPath(entryPath),
    internalEntries: getInternalEntriesFromPath(entryPath),
  };
}

function getLatestCompactionFromPath(entries: SessionPathEntry[]): SessionCompactionInfo {
  let compaction: SessionCompactionInfo = { compacted: false };
  for (const entry of entries) {
    if (entry.type !== 'compaction') continue;
    compaction = {
      compacted: true,
      timestamp: entry.timestamp,
      summaryLength: entry.summary.length,
      firstKeptEntryId: entry.firstKeptEntryId,
      firstKeptMessageIndex: entry.firstKeptMessageIndex,
      messagesBefore: entry.messagesBefore,
      messagesAfter: entry.messagesAfter,
      customInstructions: entry.customInstructions,
    };
  }
  return compaction;
}

function getUsageFromPath(entries: SessionPathEntry[]): SessionUsageInfo {
  let usage = createEmptyUsageInfo();
  for (const entry of entries) {
    if (entry.type === 'usage') {
      usage = addUsage(usage, entry.usage, entry.timestamp, entry.source);
    }
  }
  return usage;
}

function getInternalEntriesFromPath(entries: SessionPathEntry[]): SessionInternalEntry[] {
  return entries
    .filter((entry): entry is SessionPathEntry & { type: 'internal' } => entry.type === 'internal')
    .map(copyInternalEntry);
}

function rebuildMessagesFromEntryPath(entryPath: SessionPathEntry[]): Message[] {
  if (!entryPath.length) return [];

  let compactionIndex = -1;
  for (let index = entryPath.length - 1; index >= 0; index -= 1) {
    if (entryPath[index].type === 'compaction') {
      compactionIndex = index;
      break;
    }
  }

  if (compactionIndex < 0) {
    return entryPath
      .filter((entry): entry is SessionPathEntry & { type: 'message' } => entry.type === 'message')
      .map((entry) => copyMessage(entry.message));
  }

  const compactionEntry = entryPath[compactionIndex];
  if (compactionEntry.type !== 'compaction') return [];

  const messages: Message[] = [];
  const beforeCompaction = entryPath.slice(0, compactionIndex);
  const systemMessage = beforeCompaction.find((entry) => (
    entry.type === 'message' && entry.message.role === 'system'
  ));
  if (systemMessage?.type === 'message') {
    messages.push(copyMessage(systemMessage.message));
  }

  messages.push(createCompactionSummaryMessage(compactionEntry.summary));

  let keepMessages = false;
  let messageIndex = 0;
  for (const entry of beforeCompaction) {
    if (entry.type !== 'message') continue;
    if (compactionEntry.firstKeptEntryId) {
      if (entry.entryId === compactionEntry.firstKeptEntryId) {
        keepMessages = true;
      }
    } else if (messageIndex >= compactionEntry.firstKeptMessageIndex) {
      keepMessages = true;
    }
    messageIndex += 1;
    if (!keepMessages) continue;
    if (systemMessage?.entryId === entry.entryId) continue;
    messages.push(copyMessage(entry.message));
  }

  for (const entry of entryPath.slice(compactionIndex + 1)) {
    if (entry.type === 'message') {
      messages.push(copyMessage(entry.message));
    }
  }

  return messages;
}

function copyInternalEntry(entry: SessionInternalEntry): SessionInternalEntry {
  return {
    timestamp: entry.timestamp,
    entryId: entry.entryId,
    parentEntryId: entry.parentEntryId,
    kind: entry.kind,
    content: entry.content,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  };
}

function copySessionEntryPathState(state: SessionEntryPathState): SessionEntryPathState {
  return {
    messages: state.messages.map(copyMessage),
    compaction: copyCompactionInfo(state.compaction),
    usage: copyUsageInfo(state.usage),
    internalEntries: state.internalEntries.map(copyInternalEntry),
  };
}

function createCurrentSessionFormatInfo(): SessionFormatInfo {
  return {
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
}

function readSessionFormatInfo(entry: SessionStartEntry): SessionFormatInfo {
  return {
    schemaVersion: entry.schemaVersion,
  };
}

function copySessionFormatInfo(info: SessionFormatInfo): SessionFormatInfo {
  return {
    schemaVersion: info.schemaVersion,
  };
}

function copyCompactionInfo(info: SessionCompactionInfo): SessionCompactionInfo {
  return { ...info };
}

function copyUsageInfo(info: SessionUsageInfo): SessionUsageInfo {
  const copy: SessionUsageInfo = {
    count: info.count,
    total: { ...info.total },
  };
  if (info.latest) copy.latest = { ...info.latest };
  if (typeof info.latestTimestamp === 'number') copy.latestTimestamp = info.latestTimestamp;
  if (info.latestSource) copy.latestSource = info.latestSource;
  return copy;
}

function createLineageInfo(
  sessionId: string,
  createdAt?: number,
  lineage?: SessionLineageOptions,
): SessionLineageInfo {
  const info: SessionLineageInfo = {
    sessionId,
    rootSessionId: lineage?.rootSessionId ?? lineage?.parentSessionId ?? sessionId,
  };
  if (lineage?.parentSessionId) info.parentSessionId = lineage.parentSessionId;
  if (typeof lineage?.forkedFromMessageIndex === 'number') {
    info.forkedFromMessageIndex = lineage.forkedFromMessageIndex;
  }
  if (typeof createdAt === 'number') info.createdAt = createdAt;
  return info;
}

function copyLineageInfo(info: SessionLineageInfo): SessionLineageInfo {
  const copy: SessionLineageInfo = {
    sessionId: info.sessionId,
    rootSessionId: info.rootSessionId,
  };
  if (info.parentSessionId) copy.parentSessionId = info.parentSessionId;
  if (typeof info.forkedFromMessageIndex === 'number') {
    copy.forkedFromMessageIndex = info.forkedFromMessageIndex;
  }
  if (typeof info.createdAt === 'number') copy.createdAt = info.createdAt;
  return copy;
}

function copyMessage(message: Message): Message {
  return JSON.parse(JSON.stringify(message)) as Message;
}

function createEmptyUsageInfo(): SessionUsageInfo {
  return {
    count: 0,
    total: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function addUsage(
  current: SessionUsageInfo,
  usage: TokenUsage,
  timestamp: number,
  source: SessionUsageSource,
): SessionUsageInfo {
  return {
    count: current.count + 1,
    total: {
      prompt_tokens: current.total.prompt_tokens + usage.prompt_tokens,
      completion_tokens: current.total.completion_tokens + usage.completion_tokens,
      total_tokens: current.total.total_tokens + usage.total_tokens,
    },
    latest: { ...usage },
    latestTimestamp: timestamp,
    latestSource: source,
  };
}

function getSessionIdFromLog(content: string): string | null {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Partial<SessionStartEntry>;
      if (entry.type === 'session_start' && typeof entry.sessionId === 'string') {
        return entry.sessionId;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function rewriteImportedSessionLog({
  content,
  importedSessionId,
  targetSessionId,
  workspaceDir,
}: {
  content: string;
  importedSessionId: string;
  targetSessionId: string;
  workspaceDir: string;
}): string {
  const lines: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      if (entry['sessionId'] === importedSessionId) {
        entry['sessionId'] = targetSessionId;
      }
      if (entry['type'] === 'session_start') {
        entry['workspaceDir'] = workspaceDir;
        if (entry['rootSessionId'] === importedSessionId) {
          entry['rootSessionId'] = targetSessionId;
        }
        if (entry['parentSessionId'] === importedSessionId) {
          entry['parentSessionId'] = targetSessionId;
        }
      }
      lines.push(JSON.stringify(entry));
    } catch {
      continue;
    }
  }
  return `${lines.join('\n')}\n`;
}
