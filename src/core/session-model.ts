import type { Message, TokenUsage } from '../schema.js';
import {
  chooseFirstKeptMessageIndex,
  createCompactionSummaryMessage,
  rebuildCompactedMessages,
  type CompactionResult,
} from './compaction.js';
import {
  copySessionPathEntry,
  createEntryTreeFromPathEntries,
  createEntryTreeNode,
  createEntryTreeViewItem,
  entryTreeFields,
  SessionEntryStore,
} from './session-entry-store.js';
import type {
  BranchSummaryEntry,
  CompactionEntry,
  InternalEntry,
  LeafEntry,
  MessageEntry,
  SessionBranchSummary,
  SessionCompactionInfo,
  SessionEntryPathState,
  SessionFormatInfo,
  SessionInternalEntry,
  SessionLineageInfo,
  SessionPathEntry,
  SessionStartEntry,
  UsageEntry,
  SessionUsageInfo,
  SessionUsageSource,
} from './session-manager.js';

export const CURRENT_SESSION_SCHEMA_VERSION = 1;

export interface SessionMetadata {
  createdAt: number;
  updatedAt: number;
}

export interface SessionLineageOptions {
  parentSessionId?: string;
  rootSessionId?: string;
  forkedFromMessageIndex?: number;
}

export interface SessionCompactionAppendResult {
  entry: CompactionEntry;
  result: CompactionResult;
}

export interface SessionBranchOperationResult {
  leafEntry: LeafEntry;
  branchSummaryEntry: BranchSummaryEntry;
  summary: SessionBranchSummary;
}

export interface ForkSessionModelResult {
  model: SessionModel;
  pathEntries: SessionPathEntry[];
  lineage: SessionLineageInfo;
}

export class SessionModel {
  readonly sessionId: string;
  readonly entryStore: SessionEntryStore;
  private metadata: SessionMetadata;
  private lineage: SessionLineageInfo;
  private format: SessionFormatInfo;
  private activeState: SessionEntryPathState;

  constructor({
    sessionId,
    metadata,
    lineage,
    format,
    entryStore,
    activeState,
  }: {
    sessionId: string;
    metadata: SessionMetadata;
    lineage: SessionLineageInfo;
    format: SessionFormatInfo;
    entryStore: SessionEntryStore;
    activeState?: SessionEntryPathState;
  }) {
    this.sessionId = sessionId;
    this.metadata = { ...metadata };
    this.lineage = copyLineageInfo(lineage);
    this.format = copySessionFormatInfo(format);
    this.entryStore = entryStore;
    this.activeState = activeState ? copySessionEntryPathState(activeState) : this.buildActiveState();
  }

  getMetadata(): SessionMetadata {
    return { ...this.metadata };
  }

  touch(updatedAt: number): void {
    this.metadata = {
      createdAt: this.metadata.createdAt,
      updatedAt,
    };
  }

  getLineageInfo(): SessionLineageInfo {
    return copyLineageInfo(this.lineage);
  }

  setLineageInfo(lineage: SessionLineageInfo): void {
    this.lineage = copyLineageInfo(lineage);
  }

  getFormatInfo(): SessionFormatInfo {
    return copySessionFormatInfo(this.format);
  }

  setFormatInfo(format: SessionFormatInfo): void {
    this.format = copySessionFormatInfo(format);
  }

  getActiveState(): SessionEntryPathState {
    return copySessionEntryPathState(this.activeState);
  }

  applyEntryPathState(state: SessionEntryPathState): void {
    this.activeState = copySessionEntryPathState(state);
  }

  syncActiveState(): SessionEntryPathState {
    const state = this.buildActiveState();
    this.applyEntryPathState(state);
    return this.getActiveState();
  }

  applyActiveEntryPath(leafEntryId: string): {
    entryPath: SessionPathEntry[];
    state: SessionEntryPathState;
    targetEntry: SessionPathEntry;
  } {
    const entryPath = this.entryStore.getEntryPath(leafEntryId);
    if (!entryPath.length) {
      throw new Error(`Entry not found in session ${this.sessionId}: ${leafEntryId}`);
    }

    const state = buildSessionStateFromEntryPath(entryPath);
    if (!state.messages.length) {
      throw new Error(`Entry path has no messages in session ${this.sessionId}: ${leafEntryId}`);
    }

    const targetEntry = entryPath[entryPath.length - 1];
    if (!targetEntry) {
      throw new Error(`Entry path has no target in session ${this.sessionId}: ${leafEntryId}`);
    }

    this.applyEntryPathState(state);
    this.entryStore.setActiveEntryId(leafEntryId);

    return { entryPath, state: copySessionEntryPathState(state), targetEntry };
  }

  appendMessage({
    message,
    timestamp,
  }: {
    message: Message;
    timestamp: number;
  }): MessageEntry {
    const entryNode = this.entryStore.createNextEntryTreeNode('message', timestamp, {
      messageIndex: this.activeState.messages.length,
    });
    const entry: MessageEntry = {
      type: 'message',
      sessionId: this.sessionId,
      timestamp,
      ...entryTreeFields(entryNode),
      message: copyMessage(message),
    };

    this.entryStore.appendEntryTreeNode(entryNode);
    this.entryStore.appendPathEntry(entry);
    this.syncActiveState();
    this.touch(timestamp);

    return copySessionPathEntry(entry) as MessageEntry;
  }

  appendUsage({
    usage,
    source,
    timestamp,
  }: {
    usage: TokenUsage;
    source: SessionUsageSource;
    timestamp: number;
  }): UsageEntry {
    const entryNode = this.entryStore.createNextEntryTreeNode('usage', timestamp);
    const entry: UsageEntry = {
      type: 'usage',
      sessionId: this.sessionId,
      timestamp,
      ...entryTreeFields(entryNode),
      source,
      usage: { ...usage },
    };

    this.entryStore.appendEntryTreeNode(entryNode);
    this.entryStore.appendPathEntry(entry);
    this.syncActiveState();
    this.touch(timestamp);

    return copySessionPathEntry(entry) as UsageEntry;
  }

  appendInternalEntry({
    kind,
    content,
    metadata,
    timestamp,
  }: {
    kind: string;
    content?: string;
    metadata?: Record<string, unknown>;
    timestamp: number;
  }): InternalEntry {
    const normalizedKind = kind.trim();
    if (!normalizedKind) {
      throw new Error('Internal entry kind is required');
    }

    const entryNode = this.entryStore.createNextEntryTreeNode('internal', timestamp, {
      kind: normalizedKind,
    });
    const entry: InternalEntry = {
      type: 'internal',
      sessionId: this.sessionId,
      timestamp,
      ...entryTreeFields(entryNode),
      kind: normalizedKind,
      content,
      metadata: metadata ? { ...metadata } : undefined,
    };

    this.entryStore.appendEntryTreeNode(entryNode);
    this.entryStore.appendPathEntry(entry);
    this.syncActiveState();
    this.touch(timestamp);

    return copySessionPathEntry(entry) as InternalEntry;
  }

  appendCompaction({
    summary,
    customInstructions,
    keepRecentMessages,
    timestamp,
  }: {
    summary: string;
    customInstructions?: string;
    keepRecentMessages: number;
    timestamp: number;
  }): SessionCompactionAppendResult {
    const existing = this.activeState.messages;
    if (existing.length <= 2) {
      throw new Error('Nothing to compact (session too small)');
    }

    const firstKeptMessageIndex = chooseFirstKeptMessageIndex(existing, keepRecentMessages);
    const compactedMessages = rebuildCompactedMessages({
      messages: existing,
      summary,
      firstKeptMessageIndex,
    });
    const firstKeptEntryId = findFirstKeptEntryIdFromPath(
      this.entryStore.getEntryPath(),
      firstKeptMessageIndex,
    );
    const result: CompactionResult = {
      summary,
      firstKeptMessageIndex,
      messagesBefore: existing.length,
      messagesAfter: compactedMessages.length,
    };

    const entryNode = this.entryStore.createNextEntryTreeNode('compaction', timestamp);
    const entry: CompactionEntry = {
      type: 'compaction',
      sessionId: this.sessionId,
      timestamp,
      ...entryTreeFields(entryNode),
      summary,
      firstKeptEntryId,
      firstKeptMessageIndex,
      messagesBefore: result.messagesBefore,
      messagesAfter: result.messagesAfter,
      customInstructions,
    };

    this.entryStore.appendEntryTreeNode(entryNode);
    this.entryStore.appendPathEntry(entry);
    this.syncActiveState();
    this.touch(timestamp);

    return {
      entry: copySessionPathEntry(entry) as CompactionEntry,
      result,
    };
  }

  branchToEntry({
    leafEntryId,
    timestamp,
  }: {
    leafEntryId: string;
    timestamp: number;
  }): SessionBranchOperationResult {
    const fromEntryId = this.entryStore.getActiveEntryId() ?? null;
    const { entryPath, state, targetEntry } = this.applyActiveEntryPath(leafEntryId);
    const leafEntryNode = createEntryTreeNode({
      parentEntryId: fromEntryId,
      type: 'leaf',
      timestamp,
    });
    const leafEntry: LeafEntry = {
      type: 'leaf',
      sessionId: this.sessionId,
      timestamp,
      ...entryTreeFields(leafEntryNode),
      targetEntryId: leafEntryId,
    };

    this.entryStore.appendEntryTreeNode(leafEntryNode, { setActive: false });
    this.entryStore.appendPathEntry(leafEntry);
    this.entryStore.setActiveEntryId(leafEntryId);

    const branchEntryNode = this.entryStore.createNextEntryTreeNode('branch_summary', timestamp);
    const branchSummaryEntry: BranchSummaryEntry = {
      type: 'branch_summary',
      sessionId: this.sessionId,
      timestamp,
      ...entryTreeFields(branchEntryNode),
      fromEntryId,
      toEntryId: leafEntryId,
      pathEntryCount: entryPath.length,
      messageCount: state.messages.length,
    };

    this.entryStore.appendEntryTreeNode(branchEntryNode);
    this.entryStore.appendPathEntry(branchSummaryEntry);
    this.touch(timestamp);

    const metadata = this.entryStore.getEntryTree().find(
      (entry) => entry.entryId === leafEntryId,
    );
    const summary: SessionBranchSummary = {
      sessionId: this.sessionId,
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

    return {
      leafEntry: copySessionPathEntry(leafEntry) as LeafEntry,
      branchSummaryEntry: copySessionPathEntry(branchSummaryEntry) as BranchSummaryEntry,
      summary,
    };
  }

  private buildActiveState(): SessionEntryPathState {
    return buildSessionStateFromEntryPath(this.entryStore.getEntryPath());
  }
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

export function buildSessionStateFromEntryPath(entryPath: SessionPathEntry[]): SessionEntryPathState {
  return {
    messages: rebuildMessagesFromEntryPath(entryPath),
    compaction: getLatestCompactionFromPath(entryPath),
    usage: getUsageFromPath(entryPath),
    internalEntries: getInternalEntriesFromPath(entryPath),
  };
}

export function forkSessionModel({
  sourceModel,
  targetSessionId,
  leafEntryId,
  timestamp,
}: {
  sourceModel: SessionModel;
  targetSessionId: string;
  leafEntryId?: string;
  timestamp: number;
}): ForkSessionModelResult {
  const sourceEntryPath = sourceModel.entryStore.getEntryPath(leafEntryId);
  if (!sourceEntryPath.length) {
    if (leafEntryId) {
      throw new Error(`Entry not found in session ${sourceModel.sessionId}: ${leafEntryId}`);
    }
    throw new Error(`Session has no active entry path: ${sourceModel.sessionId}`);
  }

  const pathEntries = sourceEntryPath.map((entry) => copySessionPathEntryForSession(entry, targetSessionId));
  const state = buildSessionStateFromEntryPath(pathEntries);
  if (!state.messages.length) {
    throw new Error(`Session has no messages to fork: ${sourceModel.sessionId}`);
  }

  const entryTree = createEntryTreeFromPathEntries(pathEntries);
  const sourceLineage = sourceModel.getLineageInfo();
  const lineage = createLineageInfo(targetSessionId, timestamp, {
    parentSessionId: sourceModel.sessionId,
    rootSessionId: sourceLineage.rootSessionId,
    forkedFromMessageIndex: state.messages.length - 1,
  });

  return {
    model: new SessionModel({
      sessionId: targetSessionId,
      metadata: { createdAt: timestamp, updatedAt: timestamp },
      lineage,
      format: createCurrentSessionFormatInfo(),
      entryStore: new SessionEntryStore({
        entryTree,
        pathEntries,
        activeEntryId: entryTree[entryTree.length - 1]?.entryId,
      }),
      activeState: state,
    }),
    pathEntries: pathEntries.map(copySessionPathEntry),
    lineage,
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

export function copyInternalEntry(entry: SessionInternalEntry): SessionInternalEntry {
  return {
    timestamp: entry.timestamp,
    entryId: entry.entryId,
    parentEntryId: entry.parentEntryId,
    kind: entry.kind,
    content: entry.content,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  };
}

export function copySessionEntryPathState(state: SessionEntryPathState): SessionEntryPathState {
  return {
    messages: state.messages.map(copyMessage),
    compaction: copyCompactionInfo(state.compaction),
    usage: copyUsageInfo(state.usage),
    internalEntries: state.internalEntries.map(copyInternalEntry),
  };
}

export function createCurrentSessionFormatInfo(): SessionFormatInfo {
  return {
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
}

export function readSessionFormatInfo(entry: SessionStartEntry): SessionFormatInfo {
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

export function createLineageInfo(
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

export function copyMessage(message: Message): Message {
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

export function copySessionPathEntryForSession(entry: SessionPathEntry, sessionId: string): SessionPathEntry {
  const copy = copySessionPathEntry(entry);
  copy.sessionId = sessionId;
  return copy;
}
