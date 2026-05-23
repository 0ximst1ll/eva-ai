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

type PersistenceMode = 'memory' | 'jsonl';

export const CURRENT_SESSION_SCHEMA_VERSION = 1;

interface SessionManifest {
  latestSessionId: string;
  updatedAt: number;
}

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
  private readonly baseDir: string;
  private readonly workspaceKey: string;
  // Runtime cache for the current active leaf path, not the canonical session history.
  private readonly sessions = new Map<string, Message[]>();
  private readonly sessionMetadata = new Map<string, SessionMetadata>();
  private readonly sessionCompactions = new Map<string, SessionCompactionInfo>();
  private readonly sessionUsage = new Map<string, SessionUsageInfo>();
  private readonly sessionInternalEntries = new Map<string, SessionInternalEntry[]>();
  private readonly sessionLineage = new Map<string, SessionLineageInfo>();
  private readonly sessionFormats = new Map<string, SessionFormatInfo>();
  private readonly sessionEntryTrees = new Map<string, SessionEntryTreeNode[]>();
  private readonly sessionPathEntries = new Map<string, SessionPathEntry[]>();
  private readonly sessionActiveEntryIds = new Map<string, string>();
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
    this.baseDir = baseDir ?? path.join(os.homedir(), '.eva-ai', 'sessions');
    this.workspaceKey = encodeURIComponent(this.workspaceDir);
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
    this.sessionEntryTrees.set(id, [systemEntryNode]);
    this.sessionPathEntries.set(id, initialPathEntries.map(copySessionPathEntry));
    this.sessionActiveEntryIds.set(id, systemEntryNode.entryId);
    this.applyEntryPathState(id, initialState);
    this.latestSessionId = id;

    if (this.mode === 'jsonl') {
      await this.ensureWorkspaceDir();
      await this.writeSessionStart(id, now, lineageInfo);
      await this.appendEntry({
        type: 'message',
        sessionId: id,
        timestamp: now,
        ...entryTreeFields(systemEntryNode),
        message: initialMessages[0],
      });
      await this.writeManifest({ latestSessionId: id, updatedAt: now });
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
    this.sessionEntryTrees.set(id, forkedEntryNodes);
    this.sessionPathEntries.set(id, forkedPathEntries.map(copySessionPathEntry));
    this.setActiveEntryId(id, forkedEntryNodes[forkedEntryNodes.length - 1]?.entryId);
    this.applyEntryPathState(id, forkedState);
    this.latestSessionId = id;

    if (this.mode === 'jsonl') {
      await this.ensureWorkspaceDir();
      await this.writeSessionStart(id, now, lineageInfo);
      for (const entry of forkedPathEntries) {
        await this.appendEntry(entry);
      }
      await this.writeManifest({ latestSessionId: id, updatedAt: now });
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
      await fs.copyFile(this.getSessionFilePath(sessionId), resolvedOutputPath);
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
      await this.ensureWorkspaceDir();
      destinationPath = this.getSessionFilePath(targetSessionId);
      await fs.writeFile(destinationPath, rewrittenContent, 'utf-8');
      await this.writeManifest({ latestSessionId: targetSessionId, updatedAt: Date.now() });
    }

    return { sessionId: targetSessionId, sourcePath: resolvedInputPath, destinationPath };
  }

  async loadLatestSession(): Promise<string | null> {
    if (this.mode !== 'jsonl') return null;
    try {
      const manifest = await this.readManifest();
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
      const content = await fs.readFile(this.getSessionFilePath(sessionId), 'utf-8');
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
    const activeEntryId = this.sessionActiveEntryIds.get(sessionId);
    return {
      sessionId,
      activeEntryId,
      entries: (this.sessionEntryTrees.get(sessionId) ?? []).map(copyEntryTreeNode),
    };
  }

  getActiveState(sessionId: string): SessionEntryPathState {
    return copySessionEntryPathState(this.buildActiveState(sessionId));
  }

  listEntryTree(sessionId: string): SessionEntryTreeViewNode[] {
    const entries = this.sessionPathEntries.get(sessionId) ?? [];
    const activeEntryId = this.sessionActiveEntryIds.get(sessionId);
    const activePathEntryIds = new Set(
      buildEntryPath(entries, activeEntryId).map((entry) => entry.entryId),
    );
    const entryMetadata = new Map(
      (this.sessionEntryTrees.get(sessionId) ?? []).map((entry) => [entry.entryId, entry]),
    );
    const nodes = new Map<string, SessionEntryTreeViewNode>();

    for (const entry of entries) {
      nodes.set(entry.entryId, {
        entry: createEntryTreeViewItem({
          entry,
          metadata: entryMetadata.get(entry.entryId),
          activeEntryId,
          activePathEntryIds,
        }),
        children: [],
      });
    }

    const roots: SessionEntryTreeViewNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.entry.parentEntryId ? nodes.get(node.entry.parentEntryId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    const sortNodes = (treeNodes: SessionEntryTreeViewNode[]): SessionEntryTreeViewNode[] => {
      treeNodes.sort((a, b) => a.entry.timestamp - b.entry.timestamp || a.entry.entryId.localeCompare(b.entry.entryId));
      for (const node of treeNodes) {
        sortNodes(node.children);
      }
      return treeNodes;
    };

    return sortNodes(roots);
  }

  getEntryPath(sessionId: string, leafEntryId?: string): SessionPathEntry[] {
    const entries = this.sessionPathEntries.get(sessionId) ?? [];
    const activeEntryId = leafEntryId ?? this.sessionActiveEntryIds.get(sessionId);
    if (!activeEntryId) return [];

    const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
    const pathEntries: SessionPathEntry[] = [];
    let current = byId.get(activeEntryId);
    while (current) {
      pathEntries.unshift(copySessionPathEntry(current));
      current = current.parentEntryId ? byId.get(current.parentEntryId) : undefined;
    }
    return pathEntries;
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
    const fromEntryId = this.sessionActiveEntryIds.get(sessionId) ?? null;
    const { entryPath, state, targetEntry } = this.applyActiveEntryPath(sessionId, leafEntryId);
    const now = Date.now();
    const leafEntryNode = createEntryTreeNode({
      parentEntryId: fromEntryId,
      type: 'leaf',
      timestamp: now,
    });
    this.recordEntryTreeNode(sessionId, leafEntryNode, { setActive: false });
    this.recordPathEntry(sessionId, {
      type: 'leaf',
      sessionId,
      timestamp: now,
      ...entryTreeFields(leafEntryNode),
      targetEntryId: leafEntryId,
    });
    this.setActiveEntryId(sessionId, leafEntryId);
    const branchEntryNode = this.createNextEntryTreeNode(sessionId, 'branch_summary', now);
    this.recordEntryTreeNode(sessionId, branchEntryNode);
    this.recordPathEntry(sessionId, {
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

    const metadata = (this.sessionEntryTrees.get(sessionId) ?? []).find(
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
      await this.appendEntry({
        type: 'leaf',
        sessionId,
        timestamp: now,
        ...entryTreeFields(leafEntryNode),
        targetEntryId: leafEntryId,
      });
      await this.appendEntry({
        type: 'branch_summary',
        sessionId,
        timestamp: now,
        ...entryTreeFields(branchEntryNode),
        fromEntryId,
        toEntryId: leafEntryId,
        pathEntryCount: entryPath.length,
        messageCount: state.messages.length,
      });
      await this.writeManifest({ latestSessionId: sessionId, updatedAt: now });
    }

    return summary;
  }

  async appendMessage(sessionId: string, message: Message): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const existing = this.buildActiveState(sessionId).messages;
    const now = Date.now();
    const entryNode = this.createNextEntryTreeNode(sessionId, 'message', now, {
      messageIndex: existing.length,
    });
    this.recordEntryTreeNode(sessionId, entryNode);
    this.recordPathEntry(sessionId, createMessagePathEntry({
      sessionId,
      timestamp: now,
      entryNode,
      message,
    }));
    this.syncActiveStateCache(sessionId);
    this.touchSession(sessionId, now);

    if (this.mode === 'jsonl') {
      await this.appendEntry({
        type: 'message',
        sessionId,
        timestamp: now,
        ...entryTreeFields(entryNode),
        message,
      });
      await this.writeManifest({ latestSessionId: sessionId, updatedAt: now });
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
    const entryNode = this.createNextEntryTreeNode(sessionId, 'usage', now);
    this.recordEntryTreeNode(sessionId, entryNode);
    this.recordPathEntry(sessionId, {
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
      await this.appendEntry({
        type: 'usage',
        sessionId,
        timestamp: now,
        ...entryTreeFields(entryNode),
        source,
        usage,
      });
      await this.writeManifest({ latestSessionId: sessionId, updatedAt: now });
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
    const entryNode = this.createNextEntryTreeNode(sessionId, 'internal', now, {
      kind: normalizedKind,
    });
    const entry: SessionInternalEntry = {
      timestamp: now,
      ...entryTreeFields(entryNode),
      kind: normalizedKind,
      content,
      metadata: metadata ? { ...metadata } : undefined,
    };
    this.recordEntryTreeNode(sessionId, entryNode);
    this.recordPathEntry(sessionId, {
      type: 'internal',
      sessionId,
      ...entryTreeFields(entryNode),
      ...copyInternalEntry(entry),
    });
    this.syncActiveStateCache(sessionId);
    this.touchSession(sessionId, now);

    if (this.mode === 'jsonl') {
      await this.appendEntry({
        type: 'internal',
        sessionId,
        ...entryTreeFields(entryNode),
        ...entry,
      });
      await this.writeManifest({ latestSessionId: sessionId, updatedAt: now });
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
    const entryNode = this.createNextEntryTreeNode(sessionId, 'compaction', now);
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

    this.recordEntryTreeNode(sessionId, entryNode);
    this.recordPathEntry(sessionId, {
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
      await this.appendEntry({
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
      await this.writeManifest({ latestSessionId: sessionId, updatedAt: now });
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
    this.sessionEntryTrees.set(sessionId, [systemEntryNode]);
    this.sessionPathEntries.set(sessionId, resetPathEntries.map(copySessionPathEntry));
    this.sessionActiveEntryIds.set(sessionId, systemEntryNode.entryId);
    this.applyEntryPathState(sessionId, resetState);
    this.touchSession(sessionId, now);

    if (this.mode === 'jsonl') {
      await fs.writeFile(this.getSessionFilePath(sessionId), '', 'utf-8');
      await this.writeSessionStart(sessionId, now, lineageInfo);
      await this.appendEntry({
        type: 'message',
        sessionId,
        timestamp: now,
        ...entryTreeFields(systemEntryNode),
        message: resetMessages[0],
      });
      await this.writeManifest({ latestSessionId: sessionId, updatedAt: now });
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

    const manifest = await this.readManifest();
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.getWorkspaceDataDir());
    } catch {
      return [];
    }

    const sessions: SessionListItem[] = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith('.jsonl')) continue;
      const sessionId = fileName.slice(0, -'.jsonl'.length);
      try {
        const content = await fs.readFile(this.getSessionFilePath(sessionId), 'utf-8');
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

  private getWorkspaceDataDir(): string {
    return path.join(this.baseDir, this.workspaceKey);
  }

  private getSessionFilePath(sessionId: string): string {
    return path.join(this.getWorkspaceDataDir(), `${sessionId}.jsonl`);
  }

  private getManifestFilePath(): string {
    return path.join(this.getWorkspaceDataDir(), 'manifest.json');
  }

  private async ensureWorkspaceDir(): Promise<void> {
    await fs.mkdir(this.getWorkspaceDataDir(), { recursive: true });
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
    await fs.writeFile(this.getSessionFilePath(sessionId), `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  private async appendEntry(entry: SessionEntry): Promise<void> {
    await this.ensureWorkspaceDir();
    await fs.appendFile(this.getSessionFilePath(entry.sessionId), `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  private async readManifest(): Promise<SessionManifest | null> {
    try {
      const raw = await fs.readFile(this.getManifestFilePath(), 'utf-8');
      const parsed = JSON.parse(raw) as SessionManifest;
      if (!parsed.latestSessionId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeManifest(manifest: SessionManifest): Promise<void> {
    await this.ensureWorkspaceDir();
    await fs.writeFile(this.getManifestFilePath(), JSON.stringify(manifest, null, 2), 'utf-8');
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

    const pathEntries = this.sessionPathEntries.get(sessionId) ?? [];
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

  private createNextEntryTreeNode(
    sessionId: string,
    type: SessionEntryNodeType,
    timestamp: number,
    options: {
      messageIndex?: number;
      kind?: string;
    } = {},
  ): SessionEntryTreeNode {
    return createEntryTreeNode({
      parentEntryId: this.sessionActiveEntryIds.get(sessionId) ?? null,
      type,
      timestamp,
      ...options,
    });
  }

  private recordEntryTreeNode(
    sessionId: string,
    entryNode: SessionEntryTreeNode,
    options: { setActive?: boolean } = {},
  ): void {
    this.sessionEntryTrees.set(sessionId, [
      ...(this.sessionEntryTrees.get(sessionId) ?? []),
      copyEntryTreeNode(entryNode),
    ]);
    if (options.setActive ?? true) {
      this.sessionActiveEntryIds.set(sessionId, entryNode.entryId);
    }
  }

  private recordPathEntry(sessionId: string, entry: SessionPathEntry): void {
    this.sessionPathEntries.set(sessionId, [
      ...(this.sessionPathEntries.get(sessionId) ?? []),
      copySessionPathEntry(entry),
    ]);
  }

  private setActiveEntryId(sessionId: string, entryId: string | undefined): void {
    if (entryId) {
      this.sessionActiveEntryIds.set(sessionId, entryId);
    } else {
      this.sessionActiveEntryIds.delete(sessionId);
    }
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
    this.setActiveEntryId(sessionId, leafEntryId);

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
    this.sessionEntryTrees.set(sessionId, parsed.entryTree);
    this.sessionPathEntries.set(sessionId, parsed.pathEntries);
    if (parsed.activeEntryId && parsed.pathEntries.length) {
      this.applyActiveEntryPath(sessionId, parsed.activeEntryId);
    } else {
      this.applyEntryPathState(sessionId, parsed.state);
      this.setActiveEntryId(sessionId, parsed.activeEntryId);
    }
  }

  private buildActiveState(sessionId: string): SessionEntryPathState {
    return buildSessionStateFromEntryPath(this.getEntryPath(sessionId));
  }

  private async markLatestSession(sessionId: string): Promise<void> {
    const updatedAt = Date.now();
    this.touchSession(sessionId, updatedAt);
    if (this.mode === 'jsonl') {
      await this.writeManifest({ latestSessionId: sessionId, updatedAt });
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

function createEntryTreeNode({
  parentEntryId,
  type,
  timestamp,
  messageIndex,
  kind,
}: {
  parentEntryId: string | null;
  type: SessionEntryNodeType;
  timestamp: number;
  messageIndex?: number;
  kind?: string;
}): SessionEntryTreeNode {
  const entryNode: SessionEntryTreeNode = {
    entryId: randomUUID(),
    parentEntryId,
    type,
    timestamp,
  };
  if (typeof messageIndex === 'number') entryNode.messageIndex = messageIndex;
  if (kind) entryNode.kind = kind;
  return entryNode;
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

function createEntryTreeFromPathEntries(entries: SessionPathEntry[]): SessionEntryTreeNode[] {
  let messageIndex = 0;
  return entries.map((entry) => {
    const options: { messageIndex?: number; kind?: string } = {};
    if (entry.type === 'message') {
      options.messageIndex = messageIndex;
      messageIndex += 1;
    }
    if (entry.type === 'internal') {
      options.kind = entry.kind;
    }
    return {
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
      type: entry.type,
      timestamp: entry.timestamp,
      ...options,
    };
  });
}

function entryTreeFields(entryNode: SessionEntryTreeNode): {
  entryId: string;
  parentEntryId: string | null;
} {
  return {
    entryId: entryNode.entryId,
    parentEntryId: entryNode.parentEntryId,
  };
}

function readEntryTreeNode(
  entry: MessageEntry | CompactionEntry | UsageEntry | InternalEntry | BranchSummaryEntry | LeafEntry,
  options: {
    messageIndex?: number;
    kind?: string;
  } = {},
): SessionEntryTreeNode | null {
  if (typeof entry.entryId !== 'string' || !entry.entryId) return null;
  if (entry.parentEntryId !== null && typeof entry.parentEntryId !== 'string') return null;
  const entryNode: SessionEntryTreeNode = {
    entryId: entry.entryId,
    parentEntryId: entry.parentEntryId,
    type: entry.type,
    timestamp: entry.timestamp,
  };
  if (typeof options.messageIndex === 'number') entryNode.messageIndex = options.messageIndex;
  if (options.kind) entryNode.kind = options.kind;
  return entryNode;
}

function copyEntryTreeNode(entryNode: SessionEntryTreeNode): SessionEntryTreeNode {
  const copy: SessionEntryTreeNode = {
    entryId: entryNode.entryId,
    parentEntryId: entryNode.parentEntryId,
    type: entryNode.type,
    timestamp: entryNode.timestamp,
  };
  if (typeof entryNode.messageIndex === 'number') copy.messageIndex = entryNode.messageIndex;
  if (entryNode.kind) copy.kind = entryNode.kind;
  return copy;
}

function createEntryTreeViewItem({
  entry,
  metadata,
  activeEntryId,
  activePathEntryIds,
}: {
  entry: SessionPathEntry;
  metadata?: SessionEntryTreeNode;
  activeEntryId?: string;
  activePathEntryIds?: Set<string>;
}): SessionEntryTreeViewItem {
  const item: SessionEntryTreeViewItem = {
    entryId: entry.entryId,
    parentEntryId: entry.parentEntryId,
    type: entry.type,
    timestamp: entry.timestamp,
    isActive: entry.entryId === activeEntryId,
    isActivePath: activePathEntryIds?.has(entry.entryId) ?? entry.entryId === activeEntryId,
  };

  if (typeof metadata?.messageIndex === 'number') {
    item.messageIndex = metadata.messageIndex;
  }
  if (entry.type === 'message') {
    item.messageRole = entry.message.role;
    item.preview = truncatePreview(entry.message.content);
  } else if (entry.type === 'compaction') {
    item.preview = truncatePreview(entry.summary);
  } else if (entry.type === 'usage') {
    item.preview = `total_tokens=${entry.usage.total_tokens}`;
  } else if (entry.type === 'branch_summary') {
    item.preview = `from=${entry.fromEntryId ?? 'root'} to=${entry.toEntryId} path_entries=${entry.pathEntryCount} messages=${entry.messageCount}`;
  } else if (entry.type === 'leaf') {
    item.preview = `target=${entry.targetEntryId ?? 'root'}`;
  } else {
    item.kind = entry.kind;
    item.preview = truncatePreview(entry.content ?? entry.kind);
  }

  return item;
}

function truncatePreview(content: string, maxChars = 80): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
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

function copySessionPathEntry(entry: SessionPathEntry): SessionPathEntry {
  if (entry.type === 'message') {
    return {
      type: 'message',
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
      message: copyMessage(entry.message),
    };
  }
  if (entry.type === 'compaction') {
    return {
      type: 'compaction',
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
      summary: entry.summary,
      firstKeptEntryId: entry.firstKeptEntryId,
      firstKeptMessageIndex: entry.firstKeptMessageIndex,
      messagesBefore: entry.messagesBefore,
      messagesAfter: entry.messagesAfter,
      customInstructions: entry.customInstructions,
    };
  }
  if (entry.type === 'usage') {
    return {
      type: 'usage',
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
      source: entry.source,
      usage: { ...entry.usage },
    };
  }
  if (entry.type === 'branch_summary') {
    return {
      type: 'branch_summary',
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
      fromEntryId: entry.fromEntryId,
      toEntryId: entry.toEntryId,
      pathEntryCount: entry.pathEntryCount,
      messageCount: entry.messageCount,
      label: entry.label,
      reason: entry.reason,
    };
  }
  if (entry.type === 'leaf') {
    return {
      type: 'leaf',
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
      targetEntryId: entry.targetEntryId,
    };
  }
  return {
    type: 'internal',
    sessionId: entry.sessionId,
    timestamp: entry.timestamp,
    entryId: entry.entryId,
    parentEntryId: entry.parentEntryId,
    kind: entry.kind,
    content: entry.content,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  };
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

function buildEntryPath(entries: SessionPathEntry[], leafEntryId: string | undefined): SessionPathEntry[] {
  if (!leafEntryId) return [];
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
  const pathEntries: SessionPathEntry[] = [];
  let current = byId.get(leafEntryId);
  while (current) {
    pathEntries.unshift(copySessionPathEntry(current));
    current = current.parentEntryId ? byId.get(current.parentEntryId) : undefined;
  }
  return pathEntries;
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
