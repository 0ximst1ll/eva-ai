import type { Message } from '../schema.js';
import {
  buildSessionStateFromEntryPath,
  type SessionCompactionInfo,
  type SessionEntryTreeInfo,
  type SessionInternalEntry,
  type SessionLineageInfo,
  type SessionManager,
  type SessionUsageInfo,
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
  const pathState = buildSessionStateFromEntryPath(entryPath);
  const strategy: SessionContextRebuildStrategy = pathState.messages.length ? 'entry_path' : 'flat_snapshot';
  if (pathState.messages.length) {
    messages = pathState.messages;
  }

  if (!messages.length) return null;

  const lineage = sessionManager.getLineageInfo(sessionId);
  return {
    sessionId,
    strategy,
    messages,
    lineage,
    branchPath: createBranchPath(lineage),
    compaction: strategy === 'entry_path' ? pathState.compaction : sessionManager.getCompactionInfo(sessionId),
    usage: strategy === 'entry_path' ? pathState.usage : sessionManager.getUsageInfo(sessionId),
    internalEntries: strategy === 'entry_path'
      ? filterInternalEntries(pathState.internalEntries, internalKind)
      : sessionManager.getInternalEntries(sessionId, internalKind),
    entryTree: sessionManager.getEntryTreeInfo(sessionId),
  };
}

function filterInternalEntries(entries: SessionInternalEntry[], kind?: string): SessionInternalEntry[] {
  return entries
    .filter((entry) => !kind || entry.kind === kind)
    .map((entry) => ({
      timestamp: entry.timestamp,
      kind: entry.kind,
      content: entry.content,
      metadata: entry.metadata ? { ...entry.metadata } : undefined,
    }));
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
