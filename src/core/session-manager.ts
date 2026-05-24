import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, TokenUsage } from '../schema.js';
import type { CompactionResult } from './compaction.js';
import {
  buildEntryPath,
  copySessionPathEntry,
  createEntryTreeFromPathEntries,
  createEntryTreeNode,
  entryTreeFields,
  readEntryTreeNode,
  SessionEntryStore,
} from './session-entry-store.js';
import {
  buildSessionStateFromEntryPath,
  copyInternalEntry,
  copyMessage,
  copySessionEntryPathState,
  copySessionPathEntryForSession,
  createCurrentSessionFormatInfo,
  createLineageInfo,
  CURRENT_SESSION_SCHEMA_VERSION,
  readSessionFormatInfo,
  SessionModel,
  type SessionLineageOptions,
} from './session-model.js';
import { WorkspaceSessionStore } from './session-store.js';

type PersistenceMode = 'memory' | 'jsonl';

export { buildSessionStateFromEntryPath, CURRENT_SESSION_SCHEMA_VERSION } from './session-model.js';

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
  private readonly sessionModels = new Map<string, SessionModel>();
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
    this.sessionModels.set(id, new SessionModel({
      sessionId: id,
      metadata: { createdAt: now, updatedAt: now },
      lineage: lineageInfo,
      format: createCurrentSessionFormatInfo(),
      entryStore: new SessionEntryStore({
        entryTree: [systemEntryNode],
        pathEntries: initialPathEntries,
        activeEntryId: systemEntryNode.entryId,
      }),
      activeState: initialState,
    }));
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
    if (!this.sessionModels.has(sourceSessionId) && !await this.loadSession(sourceSessionId)) {
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

    this.sessionModels.set(id, new SessionModel({
      sessionId: id,
      metadata: { createdAt: now, updatedAt: now },
      lineage: lineageInfo,
      format: createCurrentSessionFormatInfo(),
      entryStore: new SessionEntryStore({
        entryTree: forkedEntryNodes,
        pathEntries: forkedPathEntries,
        activeEntryId: forkedEntryNodes[forkedEntryNodes.length - 1]?.entryId,
      }),
      activeState: forkedState,
    }));
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
    if (!this.sessionModels.has(sessionId) && !await this.loadSession(sessionId)) {
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
    if (this.sessionModels.has(sessionId)) {
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
    return this.sessionModels.get(sessionId)?.getLineageInfo() ?? createLineageInfo(sessionId);
  }

  getSessionFormatInfo(sessionId: string): SessionFormatInfo {
    return this.sessionModels.get(sessionId)?.getFormatInfo() ?? createCurrentSessionFormatInfo();
  }

  getEntryTreeInfo(sessionId: string): SessionEntryTreeInfo {
    return this.sessionModels.get(sessionId)?.entryStore.getEntryTreeInfo(sessionId) ?? { sessionId, entries: [] };
  }

  getActiveState(sessionId: string): SessionEntryPathState {
    return copySessionEntryPathState(this.buildActiveState(sessionId));
  }

  listEntryTree(sessionId: string): SessionEntryTreeViewNode[] {
    return this.sessionModels.get(sessionId)?.entryStore.listEntryTree() ?? [];
  }

  getEntryPath(sessionId: string, leafEntryId?: string): SessionPathEntry[] {
    return this.sessionModels.get(sessionId)?.entryStore.getEntryPath(leafEntryId) ?? [];
  }

  async branchSession({
    sessionId,
    leafEntryId,
  }: {
    sessionId: string;
    leafEntryId: string;
  }): Promise<SessionBranchSummary> {
    const model = this.requireSessionModel(sessionId);
    const now = Date.now();
    const {
      leafEntry,
      branchSummaryEntry,
      summary,
    } = model.branchToEntry({
      leafEntryId,
      timestamp: now,
    });
    this.latestSessionId = sessionId;

    if (this.mode === 'jsonl') {
      await this.store.appendEntry(leafEntry);
      await this.store.appendEntry(branchSummaryEntry);
      await this.store.writeManifest({ latestSessionId: sessionId, updatedAt: now });
    }

    return summary;
  }

  async appendMessage(sessionId: string, message: Message): Promise<void> {
    const model = this.requireSessionModel(sessionId);
    const now = Date.now();
    const entry = model.appendMessage({ message, timestamp: now });
    this.latestSessionId = sessionId;

    if (this.mode === 'jsonl') {
      await this.store.appendEntry(entry);
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
    const model = this.requireSessionModel(sessionId);
    const now = Date.now();
    const entry = model.appendUsage({ usage, source, timestamp: now });
    this.latestSessionId = sessionId;

    if (this.mode === 'jsonl') {
      await this.store.appendEntry(entry);
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
    const model = this.requireSessionModel(sessionId);
    const now = Date.now();
    const entry = model.appendInternalEntry({
      kind,
      content,
      metadata,
      timestamp: now,
    });
    this.latestSessionId = sessionId;

    if (this.mode === 'jsonl') {
      await this.store.appendEntry(entry);
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
    const model = this.requireSessionModel(sessionId);
    const now = Date.now();
    const { entry, result } = model.appendCompaction({
      summary,
      customInstructions,
      keepRecentMessages,
      timestamp: now,
    });
    this.latestSessionId = sessionId;

    if (this.mode === 'jsonl') {
      await this.store.appendEntry(entry);
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
    const existingModel = this.sessionModels.get(sessionId);
    const existingMetadata = existingModel?.getMetadata();
    const lineageInfo = existingModel?.getLineageInfo() ?? createLineageInfo(sessionId, now);
    this.sessionModels.set(sessionId, new SessionModel({
      sessionId,
      metadata: {
        createdAt: existingMetadata?.createdAt ?? now,
        updatedAt: now,
      },
      lineage: lineageInfo,
      format: createCurrentSessionFormatInfo(),
      entryStore: new SessionEntryStore({
        entryTree: [systemEntryNode],
        pathEntries: resetPathEntries,
        activeEntryId: systemEntryNode.entryId,
      }),
      activeState: resetState,
    }));
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
        [...this.sessionModels.keys()].map((sessionId) => {
          const lineage = this.getLineageInfo(sessionId);
          const metadata = this.requireSessionModel(sessionId).getMetadata();
          return {
            sessionId,
            messageCount: this.buildActiveState(sessionId).messages.length,
            updatedAt: metadata.updatedAt,
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
    const model = this.requireSessionModel(sessionId);
    const metadata = model.getMetadata();
    const lineage = this.getLineageInfo(sessionId);
    const lines = [
      JSON.stringify({
        type: 'session_start',
        sessionId,
        workspaceDir: this.workspaceDir,
        createdAt: metadata.createdAt,
        schemaVersion: this.getSessionFormatInfo(sessionId).schemaVersion ?? CURRENT_SESSION_SCHEMA_VERSION,
        parentSessionId: lineage.parentSessionId,
        rootSessionId: lineage.rootSessionId,
        forkedFromMessageIndex: lineage.forkedFromMessageIndex,
      } satisfies SessionStartEntry),
    ];

    const pathEntries = model.entryStore.getPathEntries();
    lines.push(...pathEntries.map((entry) => JSON.stringify(entry)));

    return `${lines.join('\n')}\n`;
  }

  private touchSession(sessionId: string, updatedAt: number): void {
    this.requireSessionModel(sessionId).touch(updatedAt);
    this.latestSessionId = sessionId;
  }

  private applyActiveEntryPath(sessionId: string, leafEntryId: string): {
    entryPath: SessionPathEntry[];
    state: SessionEntryPathState;
    targetEntry: SessionPathEntry;
  } {
    return this.requireSessionModel(sessionId).applyActiveEntryPath(leafEntryId);
  }

  private applyEntryPathState(sessionId: string, state: SessionEntryPathState): void {
    this.requireSessionModel(sessionId).applyEntryPathState(state);
  }

  private applyParsedSessionLog(sessionId: string, parsed: ParsedSessionLog): void {
    this.sessionModels.set(sessionId, new SessionModel({
      sessionId,
      metadata: {
        createdAt: parsed.createdAt ?? parsed.updatedAt,
        updatedAt: parsed.updatedAt,
      },
      lineage: parsed.lineage,
      format: parsed.format,
      entryStore: new SessionEntryStore({
        entryTree: parsed.entryTree,
        pathEntries: parsed.pathEntries,
        activeEntryId: parsed.activeEntryId,
      }),
      activeState: parsed.state,
    }));
    if (parsed.activeEntryId && parsed.pathEntries.length) {
      this.applyActiveEntryPath(sessionId, parsed.activeEntryId);
    } else {
      this.applyEntryPathState(sessionId, parsed.state);
      this.requireSessionEntryStore(sessionId).setActiveEntryId(parsed.activeEntryId);
    }
  }

  private requireSessionModel(sessionId: string): SessionModel {
    const model = this.sessionModels.get(sessionId);
    if (!model) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return model;
  }

  private requireSessionEntryStore(sessionId: string): SessionEntryStore {
    return this.requireSessionModel(sessionId).entryStore;
  }

  private buildActiveState(sessionId: string): SessionEntryPathState {
    return this.sessionModels.get(sessionId)?.getActiveState() ?? buildSessionStateFromEntryPath([]);
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
