import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, TokenUsage } from '../schema.js';
import {
  chooseFirstKeptMessageIndex,
  rebuildCompactedMessages,
  type CompactionResult,
} from './compaction.js';

type PersistenceMode = 'memory' | 'jsonl';

interface SessionManifest {
  latestSessionId: string;
  updatedAt: number;
}

export interface SessionStartEntry {
  type: 'session_start';
  sessionId: string;
  workspaceDir: string;
  createdAt: number;
  parentSessionId?: string;
  rootSessionId?: string;
  forkedFromMessageIndex?: number;
}

export interface MessageEntry {
  type: 'message';
  sessionId: string;
  timestamp: number;
  entryId?: string;
  parentEntryId?: string | null;
  message: Message;
}

export interface CompactionEntry {
  type: 'compaction';
  sessionId: string;
  timestamp: number;
  entryId?: string;
  parentEntryId?: string | null;
  summary: string;
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
  entryId?: string;
  parentEntryId?: string | null;
  source: SessionUsageSource;
  usage: TokenUsage;
}

export interface InternalEntry {
  type: 'internal';
  sessionId: string;
  timestamp: number;
  entryId?: string;
  parentEntryId?: string | null;
  kind: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export type SessionEntry = SessionStartEntry | MessageEntry | CompactionEntry | UsageEntry | InternalEntry;

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

interface SessionMetadata {
  createdAt: number;
  updatedAt: number;
}

export interface SessionCompactionInfo {
  compacted: boolean;
  timestamp?: number;
  summaryLength?: number;
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

export interface SessionLineageInfo {
  sessionId: string;
  parentSessionId?: string;
  rootSessionId: string;
  forkedFromMessageIndex?: number;
  createdAt?: number;
}

interface SessionLineageOptions {
  parentSessionId?: string;
  rootSessionId?: string;
  forkedFromMessageIndex?: number;
}

export class SessionManager {
  private readonly mode: PersistenceMode;
  private readonly workspaceDir: string;
  private readonly baseDir: string;
  private readonly workspaceKey: string;
  private readonly sessions = new Map<string, Message[]>();
  private readonly sessionMetadata = new Map<string, SessionMetadata>();
  private readonly sessionCompactions = new Map<string, SessionCompactionInfo>();
  private readonly sessionUsage = new Map<string, SessionUsageInfo>();
  private readonly sessionInternalEntries = new Map<string, SessionInternalEntry[]>();
  private readonly sessionLineage = new Map<string, SessionLineageInfo>();
  private readonly sessionEntryTrees = new Map<string, SessionEntryTreeNode[]>();
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
    this.sessions.set(id, initialMessages);
    this.sessionMetadata.set(id, { createdAt: now, updatedAt: now });
    this.sessionCompactions.delete(id);
    this.sessionUsage.delete(id);
    this.sessionInternalEntries.delete(id);
    this.sessionLineage.set(id, lineageInfo);
    this.sessionEntryTrees.set(id, [systemEntryNode]);
    this.sessionActiveEntryIds.set(id, systemEntryNode.entryId);
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
  }: {
    sourceSessionId: string;
    sessionId?: string;
  }): Promise<string> {
    if (!this.sessions.has(sourceSessionId) && !await this.loadSession(sourceSessionId)) {
      throw new Error(`Session not found: ${sourceSessionId}`);
    }

    const sourceMessages = this.sessions.get(sourceSessionId);
    if (!sourceMessages?.length) {
      throw new Error(`Session not found: ${sourceSessionId}`);
    }

    const id = sessionId ?? randomUUID();
    const now = Date.now();
    const forkedMessages = sourceMessages.map(copyMessage);
    const forkedEntryNodes = createLinearMessageEntryTree(forkedMessages.length, now);
    const sourceLineage = this.getLineageInfo(sourceSessionId);
    const lineageInfo = createLineageInfo(id, now, {
      parentSessionId: sourceSessionId,
      rootSessionId: sourceLineage.rootSessionId,
      forkedFromMessageIndex: forkedMessages.length - 1,
    });

    this.sessions.set(id, forkedMessages);
    this.sessionMetadata.set(id, { createdAt: now, updatedAt: now });
    this.sessionCompactions.delete(id);
    this.sessionUsage.delete(id);
    this.sessionInternalEntries.delete(id);
    this.sessionLineage.set(id, lineageInfo);
    this.sessionEntryTrees.set(id, forkedEntryNodes);
    this.setActiveEntryId(id, forkedEntryNodes[forkedEntryNodes.length - 1]?.entryId);
    this.latestSessionId = id;

    if (this.mode === 'jsonl') {
      await this.ensureWorkspaceDir();
      await this.writeSessionStart(id, now, lineageInfo);
      for (const [index, message] of forkedMessages.entries()) {
        const entryNode = forkedEntryNodes[index];
        await this.appendEntry({
          type: 'message',
          sessionId: id,
          timestamp: now,
          ...entryTreeFields(entryNode),
          message,
        });
      }
      await this.writeManifest({ latestSessionId: id, updatedAt: now });
    }

    return id;
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
      if (!parsed.messages.length) return false;
      this.sessions.set(sessionId, parsed.messages);
      this.sessionMetadata.set(sessionId, {
        createdAt: parsed.createdAt ?? parsed.updatedAt,
        updatedAt: parsed.updatedAt,
      });
      this.sessionCompactions.set(sessionId, parsed.compaction);
      this.sessionUsage.set(sessionId, parsed.usage);
      this.sessionInternalEntries.set(sessionId, parsed.internalEntries);
      this.sessionLineage.set(sessionId, parsed.lineage);
      this.sessionEntryTrees.set(sessionId, parsed.entryTree);
      this.setActiveEntryId(sessionId, parsed.activeEntryId);
      await this.markLatestSession(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  getMessages(sessionId: string): Message[] {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  getCompactionInfo(sessionId: string): SessionCompactionInfo {
    return this.sessionCompactions.get(sessionId) ?? { compacted: false };
  }

  getUsageInfo(sessionId: string): SessionUsageInfo {
    return this.sessionUsage.get(sessionId) ?? createEmptyUsageInfo();
  }

  getInternalEntries(sessionId: string, kind?: string): SessionInternalEntry[] {
    const entries = this.sessionInternalEntries.get(sessionId) ?? [];
    return entries
      .filter((entry) => !kind || entry.kind === kind)
      .map(copyInternalEntry);
  }

  getLineageInfo(sessionId: string): SessionLineageInfo {
    return copyLineageInfo(this.sessionLineage.get(sessionId) ?? createLineageInfo(sessionId));
  }

  getEntryTreeInfo(sessionId: string): SessionEntryTreeInfo {
    const activeEntryId = this.sessionActiveEntryIds.get(sessionId);
    return {
      sessionId,
      activeEntryId,
      entries: (this.sessionEntryTrees.get(sessionId) ?? []).map(copyEntryTreeNode),
    };
  }

  async appendMessage(sessionId: string, message: Message): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const now = Date.now();
    const entryNode = this.createNextEntryTreeNode(sessionId, 'message', now, {
      messageIndex: existing.length,
    });
    existing.push(message);
    this.sessions.set(sessionId, existing);
    this.recordEntryTreeNode(sessionId, entryNode);
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
    this.sessionUsage.set(
      sessionId,
      addUsage(this.getUsageInfo(sessionId), usage, now, source),
    );
    this.recordEntryTreeNode(sessionId, entryNode);
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
      kind: normalizedKind,
      content,
      metadata: metadata ? { ...metadata } : undefined,
    };
    this.sessionInternalEntries.set(sessionId, [
      ...(this.sessionInternalEntries.get(sessionId) ?? []),
      copyInternalEntry(entry),
    ]);
    this.recordEntryTreeNode(sessionId, entryNode);
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
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      throw new Error(`Session not found: ${sessionId}`);
    }
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
    const result: CompactionResult = {
      summary,
      firstKeptMessageIndex,
      messagesBefore: existing.length,
      messagesAfter: compactedMessages.length,
    };

    this.sessions.set(sessionId, compactedMessages);
    this.sessionCompactions.set(sessionId, {
      compacted: true,
      timestamp: now,
      summaryLength: summary.length,
      firstKeptMessageIndex,
      messagesBefore: result.messagesBefore,
      messagesAfter: result.messagesAfter,
      customInstructions,
    });
    this.recordEntryTreeNode(sessionId, entryNode);
    this.touchSession(sessionId, now);

    if (this.mode === 'jsonl') {
      await this.appendEntry({
        type: 'compaction',
        sessionId,
        timestamp: now,
        ...entryTreeFields(entryNode),
        summary,
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
    this.sessions.set(sessionId, resetMessages);
    this.sessionCompactions.delete(sessionId);
    this.sessionUsage.delete(sessionId);
    this.sessionInternalEntries.delete(sessionId);
    const lineageInfo = this.sessionLineage.get(sessionId) ?? createLineageInfo(sessionId, now);
    this.sessionLineage.set(sessionId, lineageInfo);
    this.sessionEntryTrees.set(sessionId, [systemEntryNode]);
    this.sessionActiveEntryIds.set(sessionId, systemEntryNode.entryId);
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
        [...this.sessions.entries()].map(([sessionId, messages]) => {
          const lineage = this.getLineageInfo(sessionId);
          return {
            sessionId,
            messageCount: messages.length,
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
        if (!parsed.messages.length) continue;
        sessions.push({
          sessionId,
          messageCount: parsed.messages.length,
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

  private recordEntryTreeNode(sessionId: string, entryNode: SessionEntryTreeNode): void {
    this.sessionEntryTrees.set(sessionId, [
      ...(this.sessionEntryTrees.get(sessionId) ?? []),
      copyEntryTreeNode(entryNode),
    ]);
    this.sessionActiveEntryIds.set(sessionId, entryNode.entryId);
  }

  private setActiveEntryId(sessionId: string, entryId: string | undefined): void {
    if (entryId) {
      this.sessionActiveEntryIds.set(sessionId, entryId);
    } else {
      this.sessionActiveEntryIds.delete(sessionId);
    }
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
  ): {
    messages: Message[];
    createdAt?: number;
    updatedAt: number;
    compaction: SessionCompactionInfo;
    usage: SessionUsageInfo;
    internalEntries: SessionInternalEntry[];
    lineage: SessionLineageInfo;
    entryTree: SessionEntryTreeNode[];
    activeEntryId?: string;
  } {
    const messages: Message[] = [];
    let createdAt: number | undefined;
    let updatedAt = 0;
    let compaction: SessionCompactionInfo = { compacted: false };
    let usage = createEmptyUsageInfo();
    const internalEntries: SessionInternalEntry[] = [];
    let lineage = createLineageInfo(sessionId);
    const entryTree: SessionEntryTreeNode[] = [];
    let activeEntryId: string | undefined;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as SessionEntry;
        if (entry.sessionId !== sessionId) continue;
        if (entry.type === 'session_start') {
          createdAt = entry.createdAt;
          updatedAt = Math.max(updatedAt, entry.createdAt);
          lineage = createLineageInfo(sessionId, entry.createdAt, {
            parentSessionId: entry.parentSessionId,
            rootSessionId: entry.rootSessionId,
            forkedFromMessageIndex: entry.forkedFromMessageIndex,
          });
          continue;
        }
        if (entry.type === 'message') {
          const entryNode = readEntryTreeNode(entry, {
            messageIndex: messages.length,
          });
          if (entryNode) {
            entryTree.push(entryNode);
            activeEntryId = entryNode.entryId;
          }
          messages.push(entry.message);
          updatedAt = Math.max(updatedAt, entry.timestamp);
          continue;
        }
        if (entry.type === 'compaction') {
          const entryNode = readEntryTreeNode(entry);
          if (entryNode) {
            entryTree.push(entryNode);
            activeEntryId = entryNode.entryId;
          }
          messages.splice(
            0,
            messages.length,
            ...rebuildCompactedMessages({
              messages,
              summary: entry.summary,
              firstKeptMessageIndex: entry.firstKeptMessageIndex,
            }),
          );
          updatedAt = Math.max(updatedAt, entry.timestamp);
          compaction = {
            compacted: true,
            timestamp: entry.timestamp,
            summaryLength: entry.summary.length,
            firstKeptMessageIndex: entry.firstKeptMessageIndex,
            messagesBefore: entry.messagesBefore,
            messagesAfter: entry.messagesAfter,
            customInstructions: entry.customInstructions,
          };
          continue;
        }
        if (entry.type === 'usage') {
          const entryNode = readEntryTreeNode(entry);
          if (entryNode) {
            entryTree.push(entryNode);
            activeEntryId = entryNode.entryId;
          }
          updatedAt = Math.max(updatedAt, entry.timestamp);
          usage = addUsage(usage, entry.usage, entry.timestamp, entry.source);
          continue;
        }
        if (entry.type === 'internal') {
          const entryNode = readEntryTreeNode(entry, { kind: entry.kind });
          if (entryNode) {
            entryTree.push(entryNode);
            activeEntryId = entryNode.entryId;
          }
          updatedAt = Math.max(updatedAt, entry.timestamp);
          internalEntries.push(copyInternalEntry(entry));
        }
      } catch {
        continue;
      }
    }

    return {
      messages,
      createdAt,
      updatedAt,
      compaction,
      usage,
      internalEntries,
      lineage,
      entryTree,
      activeEntryId,
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

function createLinearMessageEntryTree(messageCount: number, timestamp: number): SessionEntryTreeNode[] {
  const entries: SessionEntryTreeNode[] = [];
  let parentEntryId: string | null = null;
  for (let index = 0; index < messageCount; index += 1) {
    const entryNode = createEntryTreeNode({
      parentEntryId,
      type: 'message',
      timestamp,
      messageIndex: index,
    });
    entries.push(entryNode);
    parentEntryId = entryNode.entryId;
  }
  return entries;
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
  entry: MessageEntry | CompactionEntry | UsageEntry | InternalEntry,
  options: {
    messageIndex?: number;
    kind?: string;
  } = {},
): SessionEntryTreeNode | null {
  if (!entry.entryId) return null;
  const entryNode: SessionEntryTreeNode = {
    entryId: entry.entryId,
    parentEntryId: entry.parentEntryId ?? null,
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

function copyInternalEntry(entry: SessionInternalEntry): SessionInternalEntry {
  return {
    timestamp: entry.timestamp,
    kind: entry.kind,
    content: entry.content,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  };
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
