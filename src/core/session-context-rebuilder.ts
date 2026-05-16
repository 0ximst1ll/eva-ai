import type { Message } from '../schema.js';
import { createCompactionSummaryMessage } from './compaction.js';
import type {
  SessionCompactionInfo,
  SessionEntryTreeInfo,
  SessionInternalEntry,
  SessionLineageInfo,
  SessionManager,
  SessionPathEntry,
  SessionUsageInfo,
} from './session-manager.js';

export type SessionContextRebuildStrategy = 'flat_snapshot' | 'entry_path';

export interface SessionContextBranchNode {
  sessionId: string;
  parentSessionId?: string;
  rootSessionId: string;
  forkedFromMessageIndex?: number;
}

export interface SessionContextSnapshot {
  sessionId: string;
  strategy: SessionContextRebuildStrategy;
  messages: Message[];
  lineage: SessionLineageInfo;
  branchPath: SessionContextBranchNode[];
  compaction: SessionCompactionInfo;
  usage: SessionUsageInfo;
  internalEntries: SessionInternalEntry[];
  entryTree: SessionEntryTreeInfo;
}

export interface RebuildSessionContextOptions {
  sessionManager: SessionManager;
  sessionId: string;
  internalKind?: string;
}

export async function rebuildSessionContext({
  sessionManager,
  sessionId,
  internalKind,
}: RebuildSessionContextOptions): Promise<SessionContextSnapshot | null> {
  let messages = sessionManager.getMessages(sessionId);
  if (!messages.length && await sessionManager.loadSession(sessionId)) {
    messages = sessionManager.getMessages(sessionId);
  }

  const entryPath = sessionManager.getEntryPath(sessionId);
  const pathMessages = rebuildMessagesFromEntryPath(entryPath);
  const strategy: SessionContextRebuildStrategy = pathMessages.length ? 'entry_path' : 'flat_snapshot';
  if (pathMessages.length) {
    messages = pathMessages;
  }

  if (!messages.length) return null;

  const lineage = sessionManager.getLineageInfo(sessionId);
  return {
    sessionId,
    strategy,
    messages,
    lineage,
    branchPath: createBranchPath(lineage),
    compaction: sessionManager.getCompactionInfo(sessionId),
    usage: sessionManager.getUsageInfo(sessionId),
    internalEntries: sessionManager.getInternalEntries(sessionId, internalKind),
    entryTree: sessionManager.getEntryTreeInfo(sessionId),
  };
}

function createBranchPath(lineage: SessionLineageInfo): SessionContextBranchNode[] {
  if (!lineage.parentSessionId || lineage.parentSessionId === lineage.sessionId) {
    const rootNode: SessionContextBranchNode = {
      sessionId: lineage.sessionId,
      rootSessionId: lineage.rootSessionId,
    };
    if (typeof lineage.forkedFromMessageIndex === 'number') {
      rootNode.forkedFromMessageIndex = lineage.forkedFromMessageIndex;
    }
    return [rootNode];
  }

  const currentNode: SessionContextBranchNode = {
    sessionId: lineage.sessionId,
    parentSessionId: lineage.parentSessionId,
    rootSessionId: lineage.rootSessionId,
  };
  if (typeof lineage.forkedFromMessageIndex === 'number') {
    currentNode.forkedFromMessageIndex = lineage.forkedFromMessageIndex;
  }

  return [
    {
      sessionId: lineage.parentSessionId,
      rootSessionId: lineage.rootSessionId,
    },
    currentNode,
  ];
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

function copyMessage(message: Message): Message {
  return JSON.parse(JSON.stringify(message)) as Message;
}
