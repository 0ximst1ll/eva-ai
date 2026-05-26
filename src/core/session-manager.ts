import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDiagnostic, type RuntimeDiagnostic } from '../diagnostics.js';
import type { Message, TokenUsage } from '../schema.js';
import type { CompactionResult } from './compaction.js';
import { copySessionPathEntry } from './session-entry-store.js';
import {
  getSessionIdFromLog,
  parseSessionLog,
  rewriteImportedSessionLog,
  type SessionLogDiagnostic,
  type ParsedSessionLog,
} from './session-log-parser.js';
import {
  buildSessionStateFromEntryPath,
  copyInternalEntry,
  copySessionEntryPathState,
  createCurrentSessionFormatInfo,
  createInitialSessionModel,
  createLineageInfo,
  createSessionModelFromParsedLog,
  CURRENT_SESSION_SCHEMA_VERSION,
  forkSessionModel,
  SessionModel,
  type SessionLineageOptions,
} from './session-model.js';
import {
  JsonlSessionStorage,
  MemorySessionStorage,
  type SessionStorage,
} from './session-store.js';

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

export class SessionManager {
  private readonly workspaceDir: string;
  private readonly storage: SessionStorage;
  private readonly sessionModels = new Map<string, SessionModel>();
  private readonly diagnostics: RuntimeDiagnostic[] = [];
  private latestSessionId?: string;

  constructor({
    workspaceDir,
    mode = 'jsonl',
    baseDir,
    storage,
  }: {
    workspaceDir: string;
    mode?: PersistenceMode;
    baseDir?: string;
    storage?: SessionStorage;
  }) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.storage = storage
      ?? (mode === 'memory'
        ? new MemorySessionStorage()
        : new JsonlSessionStorage(
          this.workspaceDir,
          baseDir ?? path.join(os.homedir(), '.eva-ai', 'sessions'),
        ));
  }

  async createSession(systemPrompt: string, sessionId?: string, lineage?: SessionLineageOptions): Promise<string> {
    const id = sessionId ?? randomUUID();
    const now = Date.now();
    const {
      model,
      initialEntry,
      lineage: lineageInfo,
    } = createInitialSessionModel({
      sessionId: id,
      systemPrompt,
      timestamp: now,
      lineageOptions: lineage,
    });
    this.sessionModels.set(id, model);
    this.latestSessionId = id;

    await this.writeSessionStart(id, now, lineageInfo);
    await this.storage.appendEntry(initialEntry);
    await this.storage.writeManifest({ latestSessionId: id, updatedAt: now });
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
    const {
      model,
      pathEntries,
      lineage,
    } = forkSessionModel({
      sourceModel: this.requireSessionModel(sourceSessionId),
      targetSessionId: id,
      leafEntryId,
      timestamp: now,
    });

    this.sessionModels.set(id, model);
    this.latestSessionId = id;

    await this.writeSessionStart(id, now, lineage);
    for (const entry of pathEntries) {
      await this.storage.appendEntry(entry);
    }
    await this.storage.writeManifest({ latestSessionId: id, updatedAt: now });

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

    await this.storage.copySessionLog(sessionId, resolvedOutputPath);
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
    const parsed = parseSessionLog(rewrittenContent, targetSessionId);
    this.recordParserDiagnostics('import', targetSessionId, parsed.diagnostics);
    if (!parsed.state.messages.length) {
      this.recordDiagnostic({
        level: 'error',
        code: 'session_import_no_messages',
        message: `Imported session has no active messages: ${targetSessionId}`,
        details: { sessionId: targetSessionId, inputPath: resolvedInputPath },
      });
      throw new Error(`Imported session has no messages: ${targetSessionId}`);
    }

    this.applyParsedSessionLog(targetSessionId, parsed);
    this.latestSessionId = targetSessionId;

    const destinationPath = this.storage.getSessionFilePath(targetSessionId);
    await this.storage.writeSessionLog(targetSessionId, rewrittenContent);
    await this.storage.writeManifest({ latestSessionId: targetSessionId, updatedAt: Date.now() });

    return { sessionId: targetSessionId, sourcePath: resolvedInputPath, destinationPath };
  }

  async loadLatestSession(): Promise<string | null> {
    try {
      const manifest = await this.storage.readManifest();
      if (!manifest?.latestSessionId) return null;
      const loaded = await this.loadSession(manifest.latestSessionId);
      if (!loaded) {
        this.recordDiagnostic({
          level: 'error',
          code: 'latest_session_load_failed',
          message: `Latest session could not be loaded: ${manifest.latestSessionId}`,
          details: { sessionId: manifest.latestSessionId },
        });
        return null;
      }
      return manifest.latestSessionId;
    } catch (error) {
      this.recordDiagnostic({
        level: 'error',
        code: 'latest_session_load_failed',
        message: `Latest session could not be loaded: ${(error as Error).message}`,
      });
      return null;
    }
  }

  async loadSession(sessionId: string): Promise<boolean> {
    if (this.sessionModels.has(sessionId)) {
      await this.markLatestSession(sessionId);
      return true;
    }

    try {
      const content = await this.storage.readSessionLog(sessionId);
      const parsed = parseSessionLog(content, sessionId);
      this.recordParserDiagnostics('load', sessionId, parsed.diagnostics);
      if (!parsed.state.messages.length) {
        this.recordDiagnostic({
          level: 'error',
          code: 'session_load_no_messages',
          message: `Session has no active messages: ${sessionId}`,
          details: { sessionId },
        });
        return false;
      }
      this.applyParsedSessionLog(sessionId, parsed);
      await this.markLatestSession(sessionId);
      return true;
    } catch (error) {
      this.recordDiagnostic({
        level: 'error',
        code: 'session_load_failed',
        message: `Session could not be loaded: ${(error as Error).message}`,
        details: { sessionId },
      });
      return false;
    }
  }

  getDiagnostics(): RuntimeDiagnostic[] {
    return this.diagnostics.slice();
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

    await this.storage.appendEntry(leafEntry);
    await this.storage.appendEntry(branchSummaryEntry);
    await this.storage.writeManifest({ latestSessionId: sessionId, updatedAt: now });

    return summary;
  }

  async appendMessage(sessionId: string, message: Message): Promise<void> {
    const model = this.requireSessionModel(sessionId);
    const now = Date.now();
    const entry = model.appendMessage({ message, timestamp: now });
    this.latestSessionId = sessionId;

    await this.storage.appendEntry(entry);
    await this.storage.writeManifest({ latestSessionId: sessionId, updatedAt: now });
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

    await this.storage.appendEntry(entry);
    await this.storage.writeManifest({ latestSessionId: sessionId, updatedAt: now });
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

    await this.storage.appendEntry(entry);
    await this.storage.writeManifest({ latestSessionId: sessionId, updatedAt: now });

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

    await this.storage.appendEntry(entry);
    await this.storage.writeManifest({ latestSessionId: sessionId, updatedAt: now });

    return result;
  }

  async resetSession(sessionId: string, systemPrompt: string): Promise<void> {
    const now = Date.now();
    const existingModel = this.sessionModels.get(sessionId);
    const existingMetadata = existingModel?.getMetadata();
    const lineageInfo = existingModel?.getLineageInfo() ?? createLineageInfo(sessionId, now);
    const {
      model,
      initialEntry,
    } = createInitialSessionModel({
      sessionId,
      systemPrompt,
      timestamp: now,
      createdAt: existingMetadata?.createdAt ?? now,
      lineage: lineageInfo,
    });
    this.sessionModels.set(sessionId, model);
    this.touchSession(sessionId, now);

    await this.writeSessionStart(sessionId, now, lineageInfo);
    await this.storage.appendEntry(initialEntry);
    await this.storage.writeManifest({ latestSessionId: sessionId, updatedAt: now });
  }

  async listSessions(): Promise<SessionListItem[]> {
    const manifest = await this.storage.readManifest();
    const sessions: SessionListItem[] = [];
    for (const sessionId of await this.storage.listSessionIds()) {
      try {
        const content = await this.storage.readSessionLog(sessionId);
        const parsed = parseSessionLog(content, sessionId);
        this.recordParserDiagnostics('list', sessionId, parsed.diagnostics);
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
    await this.storage.writeSessionStart(entry);
  }

  private touchSession(sessionId: string, updatedAt: number): void {
    this.requireSessionModel(sessionId).touch(updatedAt);
    this.latestSessionId = sessionId;
  }

  private applyParsedSessionLog(sessionId: string, parsed: ParsedSessionLog): void {
    this.sessionModels.set(sessionId, createSessionModelFromParsedLog({
      sessionId,
      state: parsed.state,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      lineage: parsed.lineage,
      entryTree: parsed.entryTree,
      pathEntries: parsed.pathEntries,
      activeEntryId: parsed.activeEntryId,
      format: parsed.format,
    }));
  }

  private requireSessionModel(sessionId: string): SessionModel {
    const model = this.sessionModels.get(sessionId);
    if (!model) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return model;
  }

  private buildActiveState(sessionId: string): SessionEntryPathState {
    return this.sessionModels.get(sessionId)?.getActiveState() ?? buildSessionStateFromEntryPath([]);
  }

  private async markLatestSession(sessionId: string): Promise<void> {
    const updatedAt = Date.now();
    this.touchSession(sessionId, updatedAt);
    await this.storage.writeManifest({ latestSessionId: sessionId, updatedAt });
  }

  private recordParserDiagnostics(
    operation: string,
    sessionId: string,
    diagnostics: SessionLogDiagnostic[],
  ): void {
    for (const diagnostic of diagnostics) {
      this.recordDiagnostic({
        level: diagnostic.level,
        code: diagnostic.code,
        message: diagnostic.message,
        details: {
          ...diagnostic.details,
          operation,
          sessionId,
          line: diagnostic.line,
        },
      });
    }
  }

  private recordDiagnostic({
    level,
    code,
    message,
    details,
  }: {
    level: RuntimeDiagnostic['level'];
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }): void {
    this.diagnostics.push(createDiagnostic({
      source: 'session',
      level,
      code,
      message,
      details,
    }));
  }

  private sortSessionList(sessions: SessionListItem[]): SessionListItem[] {
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
  }
}
