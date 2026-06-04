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
  | 'session_log_invalid_entry'
  | 'session_log_unsupported_schema'
  | 'session_log_missing_session_start'
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
      const parsedEntry = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsedEntry)) {
        diagnostics.push(createInvalidEntryDiagnostic(parsedEntry, lineNumber, 'entry must be an object'));
        continue;
      }
      const entry = parsedEntry as unknown as SessionEntry;
      if (entry.sessionId !== sessionId) continue;
      if (entry.type === 'session_start') {
        const invalidReason = validateSessionStartEntry(entry);
        if (invalidReason) {
          diagnostics.push(createInvalidEntryDiagnostic(entry, lineNumber, invalidReason));
          continue;
        }
        if (entry.schemaVersion !== CURRENT_SESSION_SCHEMA_VERSION) {
          diagnostics.push({
            level: 'error',
            code: 'session_log_unsupported_schema',
            message: `Unsupported session schema version: ${entry.schemaVersion}; supported version: ${CURRENT_SESSION_SCHEMA_VERSION}`,
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
        const invalidReason = validateMessageEntry(entry);
        if (invalidReason) {
          diagnostics.push(createInvalidEntryDiagnostic(entry, lineNumber, invalidReason));
          continue;
        }
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
        const invalidReason = validateCompactionEntry(entry);
        if (invalidReason) {
          diagnostics.push(createInvalidEntryDiagnostic(entry, lineNumber, invalidReason));
          continue;
        }
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
        const invalidReason = validateUsageEntry(entry);
        if (invalidReason) {
          diagnostics.push(createInvalidEntryDiagnostic(entry, lineNumber, invalidReason));
          continue;
        }
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
        const invalidReason = validateInternalEntry(entry);
        if (invalidReason) {
          diagnostics.push(createInvalidEntryDiagnostic(entry, lineNumber, invalidReason));
          continue;
        }
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
        const invalidReason = validateBranchSummaryEntry(entry);
        if (invalidReason) {
          diagnostics.push(createInvalidEntryDiagnostic(entry, lineNumber, invalidReason));
          continue;
        }
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
        const invalidReason = validateLeafEntry(entry);
        if (invalidReason) {
          diagnostics.push(createInvalidEntryDiagnostic(entry, lineNumber, invalidReason));
          continue;
        }
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

  if (!hasCurrentSessionStart) {
    diagnostics.push({
      level: 'error',
      code: 'session_log_missing_session_start',
      message: 'Session log is missing a valid session_start entry',
      details: { sessionId },
    });
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

function createInvalidEntryDiagnostic(
  entry: unknown,
  line: number,
  reason: string,
): SessionLogDiagnostic {
  return {
    level: 'error',
    code: 'session_log_invalid_entry',
    message: `Invalid session entry: ${reason}`,
    line,
    details: {
      reason,
      type: isRecord(entry) ? entry['type'] : typeof entry,
    },
  };
}

function validateSessionStartEntry(entry: SessionEntry): string | null {
  if (entry.type !== 'session_start') return null;
  if (!isNonEmptyString(entry.sessionId)) return 'session_start.sessionId must be a non-empty string';
  if (typeof entry.workspaceDir !== 'string') return 'session_start.workspaceDir must be a string';
  if (!isFiniteNumber(entry.createdAt)) return 'session_start.createdAt must be a finite number';
  if (!isFiniteNumber(entry.schemaVersion)) return 'session_start.schemaVersion must be a finite number';
  if (entry.parentSessionId !== undefined && !isNonEmptyString(entry.parentSessionId)) {
    return 'session_start.parentSessionId must be a non-empty string when present';
  }
  if (entry.rootSessionId !== undefined && !isNonEmptyString(entry.rootSessionId)) {
    return 'session_start.rootSessionId must be a non-empty string when present';
  }
  if (entry.forkedFromMessageIndex !== undefined && !isFiniteNumber(entry.forkedFromMessageIndex)) {
    return 'session_start.forkedFromMessageIndex must be a finite number when present';
  }
  return null;
}

function validateMessageEntry(entry: SessionEntry): string | null {
  if (entry.type !== 'message') return null;
  const commonError = validatePathEntryBase(entry);
  if (commonError) return commonError;
  const message = entry.message;
  if (!isRecord(message)) return 'message.message must be an object';
  if (!['system', 'user', 'assistant', 'tool'].includes(String(message['role']))) {
    return 'message.message.role must be system, user, assistant, or tool';
  }
  if (typeof message['content'] !== 'string') return 'message.message.content must be a string';
  if (message['role'] === 'tool' && !isNonEmptyString(message['tool_call_id'])) {
    return 'message.message.tool_call_id must be a non-empty string for tool messages';
  }
  if (message['role'] === 'tool' && message['details'] !== undefined && !isRecord(message['details'])) {
    return 'message.message.details must be an object when present';
  }
  if (message['role'] === 'tool' && message['contentBlocks'] !== undefined && !isValidToolContentBlocks(message['contentBlocks'])) {
    return 'message.message.contentBlocks must be an array of supported content blocks when present';
  }
  if (message['role'] === 'assistant' && message['thinking'] !== undefined && typeof message['thinking'] !== 'string') {
    return 'message.message.thinking must be a string when present';
  }
  if (message['role'] === 'assistant' && message['tool_calls'] !== undefined && !Array.isArray(message['tool_calls'])) {
    return 'message.message.tool_calls must be an array when present';
  }
  return null;
}

function validateCompactionEntry(entry: SessionEntry): string | null {
  if (entry.type !== 'compaction') return null;
  const commonError = validatePathEntryBase(entry);
  if (commonError) return commonError;
  if (typeof entry.summary !== 'string') return 'compaction.summary must be a string';
  if (!isFiniteNumber(entry.firstKeptMessageIndex)) return 'compaction.firstKeptMessageIndex must be a finite number';
  if (!isFiniteNumber(entry.messagesBefore)) return 'compaction.messagesBefore must be a finite number';
  if (!isFiniteNumber(entry.messagesAfter)) return 'compaction.messagesAfter must be a finite number';
  if (entry.firstKeptEntryId !== undefined && !isNonEmptyString(entry.firstKeptEntryId)) {
    return 'compaction.firstKeptEntryId must be a non-empty string when present';
  }
  if (entry.customInstructions !== undefined && typeof entry.customInstructions !== 'string') {
    return 'compaction.customInstructions must be a string when present';
  }
  return null;
}

function validateUsageEntry(entry: SessionEntry): string | null {
  if (entry.type !== 'usage') return null;
  const commonError = validatePathEntryBase(entry);
  if (commonError) return commonError;
  if (!['assistant', 'compaction'].includes(entry.source)) return 'usage.source must be assistant or compaction';
  if (!isRecord(entry.usage)) return 'usage.usage must be an object';
  if (!isFiniteNumber(entry.usage.prompt_tokens)) return 'usage.usage.prompt_tokens must be a finite number';
  if (!isFiniteNumber(entry.usage.completion_tokens)) return 'usage.usage.completion_tokens must be a finite number';
  if (!isFiniteNumber(entry.usage.total_tokens)) return 'usage.usage.total_tokens must be a finite number';
  return null;
}

function validateInternalEntry(entry: SessionEntry): string | null {
  if (entry.type !== 'internal') return null;
  const commonError = validatePathEntryBase(entry);
  if (commonError) return commonError;
  if (!isNonEmptyString(entry.kind)) return 'internal.kind must be a non-empty string';
  if (entry.content !== undefined && typeof entry.content !== 'string') return 'internal.content must be a string when present';
  if (entry.metadata !== undefined && !isRecord(entry.metadata)) return 'internal.metadata must be an object when present';
  return null;
}

function validateBranchSummaryEntry(entry: SessionEntry): string | null {
  if (entry.type !== 'branch_summary') return null;
  const commonError = validatePathEntryBase(entry);
  if (commonError) return commonError;
  if (entry.fromEntryId !== null && !isNonEmptyString(entry.fromEntryId)) {
    return 'branch_summary.fromEntryId must be null or a non-empty string';
  }
  if (!isNonEmptyString(entry.toEntryId)) return 'branch_summary.toEntryId must be a non-empty string';
  if (!isFiniteNumber(entry.pathEntryCount)) return 'branch_summary.pathEntryCount must be a finite number';
  if (!isFiniteNumber(entry.messageCount)) return 'branch_summary.messageCount must be a finite number';
  if (entry.label !== undefined && typeof entry.label !== 'string') return 'branch_summary.label must be a string when present';
  if (entry.reason !== undefined && typeof entry.reason !== 'string') return 'branch_summary.reason must be a string when present';
  return null;
}

function validateLeafEntry(entry: SessionEntry): string | null {
  if (entry.type !== 'leaf') return null;
  const commonError = validatePathEntryBase(entry);
  if (commonError) return commonError;
  if (entry.targetEntryId !== null && !isNonEmptyString(entry.targetEntryId)) {
    return 'leaf.targetEntryId must be null or a non-empty string';
  }
  return null;
}

function validatePathEntryBase(entry: Extract<SessionEntry, { entryId: string }>): string | null {
  if (!isNonEmptyString(entry.sessionId)) return `${entry.type}.sessionId must be a non-empty string`;
  if (!isFiniteNumber(entry.timestamp)) return `${entry.type}.timestamp must be a finite number`;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidToolContentBlocks(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((block) => (
    isRecord(block)
    && block['type'] === 'text'
    && typeof block['text'] === 'string'
  ));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
