import type { Message } from '../schema.js';
import type {
  SessionCompactionInfo,
  SessionEntryTreeInfo,
  SessionInternalEntry,
  SessionLineageInfo,
  SessionManager,
  SessionUsageInfo,
} from './session-manager.js';

export type SessionContextRebuildStrategy = 'flat_snapshot';

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
  if (!messages.length) return null;

  const lineage = sessionManager.getLineageInfo(sessionId);
  return {
    sessionId,
    strategy: 'flat_snapshot',
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
