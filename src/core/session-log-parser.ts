import {
  buildEntryPath,
  copySessionPathEntry,
  readEntryTreeNode,
} from './session-entry-store.js';
import {
  buildSessionStateFromEntryPath,
  createCurrentSessionFormatInfo,
  createLineageInfo,
  CURRENT_SESSION_SCHEMA_VERSION,
  readSessionFormatInfo,
} from './session-model.js';
import type {
  SessionEntry,
  SessionEntryPathState,
  SessionEntryTreeNode,
  SessionFormatInfo,
  SessionLineageInfo,
  SessionPathEntry,
  SessionStartEntry,
} from './session-manager.js';

export interface ParsedSessionLog {
  state: SessionEntryPathState;
  createdAt?: number;
  updatedAt: number;
  lineage: SessionLineageInfo;
  entryTree: SessionEntryTreeNode[];
  pathEntries: SessionPathEntry[];
  activeEntryId?: string;
  format: SessionFormatInfo;
}

export function parseSessionLog(
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

export function getSessionIdFromLog(content: string): string | null {
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

export function rewriteImportedSessionLog({
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
