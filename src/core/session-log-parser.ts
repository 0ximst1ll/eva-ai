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
  diagnostics: SessionLogDiagnostic[];
}

export type SessionLogDiagnosticLevel = 'warning' | 'error';

export type SessionLogDiagnosticCode =
  | 'session_log_invalid_json'
  | 'session_log_unsupported_schema'
  | 'session_log_entry_before_start'
  | 'session_log_missing_entry_metadata'
  | 'session_log_unknown_entry_type'
  | 'session_log_active_leaf_missing'
  | 'session_log_broken_parent_chain';

export interface SessionLogDiagnostic {
  level: SessionLogDiagnosticLevel;
  code: SessionLogDiagnosticCode;
  message: string;
  line?: number;
  details?: Record<string, unknown>;
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
  const diagnostics: SessionLogDiagnostic[] = [];

  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as SessionEntry;
      if (entry.sessionId !== sessionId) continue;
      if (entry.type === 'session_start') {
        if (entry.schemaVersion !== CURRENT_SESSION_SCHEMA_VERSION) {
          diagnostics.push({
            level: 'error',
            code: 'session_log_unsupported_schema',
            message: `Unsupported session schema version: ${entry.schemaVersion}`,
            line: lineNumber,
            details: {
              schemaVersion: entry.schemaVersion,
              expectedSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
            },
          });
          continue;
        }
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
      if (!hasCurrentSessionStart) {
        diagnostics.push({
          level: 'warning',
          code: 'session_log_entry_before_start',
          message: 'Ignored session entry before a valid session_start entry',
          line: lineNumber,
          details: { type: entry.type },
        });
        continue;
      }
      if (entry.type === 'message') {
        const entryNode = readEntryTreeNode(entry, {
          messageIndex,
        });
        if (!entryNode) {
          diagnostics.push(createMissingEntryMetadataDiagnostic(entry, lineNumber));
          continue;
        }
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
        if (!entryNode) {
          diagnostics.push(createMissingEntryMetadataDiagnostic(entry, lineNumber));
          continue;
        }
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
        if (!entryNode) {
          diagnostics.push(createMissingEntryMetadataDiagnostic(entry, lineNumber));
          continue;
        }
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
        if (!entryNode) {
          diagnostics.push(createMissingEntryMetadataDiagnostic(entry, lineNumber));
          continue;
        }
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
        if (!entryNode) {
          diagnostics.push(createMissingEntryMetadataDiagnostic(entry, lineNumber));
          continue;
        }
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
        if (!entryNode) {
          diagnostics.push(createMissingEntryMetadataDiagnostic(entry, lineNumber));
          continue;
        }
        entryTree.push(entryNode);
        pathEntries.push(copySessionPathEntry({
          ...entry,
          entryId: entryNode.entryId,
          parentEntryId: entryNode.parentEntryId,
        }));
        activeEntryId = entry.targetEntryId ?? undefined;
        updatedAt = Math.max(updatedAt, entry.timestamp);
        continue;
      }
      diagnostics.push({
        level: 'warning',
        code: 'session_log_unknown_entry_type',
        message: `Ignored unknown session entry type: ${(entry as { type?: unknown }).type}`,
        line: lineNumber,
        details: { type: (entry as { type?: unknown }).type },
      });
    } catch (error) {
      diagnostics.push({
        level: 'error',
        code: 'session_log_invalid_json',
        message: `Invalid session JSONL line: ${(error as Error).message}`,
        line: lineNumber,
      });
    }
  }

  const activePathEntries = buildEntryPath(pathEntries, activeEntryId);
  if (activeEntryId && activePathEntries.length === 0) {
    diagnostics.push({
      level: 'error',
      code: 'session_log_active_leaf_missing',
      message: `Active entry not found in session path entries: ${activeEntryId}`,
      details: { activeEntryId },
    });
  } else if (activePathEntries[0]?.parentEntryId) {
    diagnostics.push({
      level: 'error',
      code: 'session_log_broken_parent_chain',
      message: `Active entry path is missing parent entry: ${activePathEntries[0].parentEntryId}`,
      details: {
        activeEntryId,
        missingParentEntryId: activePathEntries[0].parentEntryId,
      },
    });
  }
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
    diagnostics,
  };
}

function createMissingEntryMetadataDiagnostic(
  entry: SessionEntry,
  line: number,
): SessionLogDiagnostic {
  return {
    level: 'error',
    code: 'session_log_missing_entry_metadata',
    message: `Session entry is missing valid entryId/parentEntryId metadata: ${entry.type}`,
    line,
    details: { type: entry.type },
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
