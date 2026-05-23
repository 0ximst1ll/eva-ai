import { randomUUID } from 'node:crypto';
import type {
  SessionEntryNodeType,
  SessionEntryTreeInfo,
  SessionEntryTreeNode,
  SessionEntryTreeViewItem,
  SessionEntryTreeViewNode,
  SessionPathEntry,
} from './session-manager.js';

export interface CreateSessionEntryStoreOptions {
  entryTree?: SessionEntryTreeNode[];
  pathEntries?: SessionPathEntry[];
  activeEntryId?: string;
}

export class SessionEntryStore {
  private entryTree: SessionEntryTreeNode[];
  private pathEntries: SessionPathEntry[];
  private activeEntryId?: string;

  constructor({
    entryTree = [],
    pathEntries = [],
    activeEntryId,
  }: CreateSessionEntryStoreOptions = {}) {
    this.entryTree = entryTree.map(copyEntryTreeNode);
    this.pathEntries = pathEntries.map(copySessionPathEntry);
    this.activeEntryId = activeEntryId;
  }

  getActiveEntryId(): string | undefined {
    return this.activeEntryId;
  }

  setActiveEntryId(entryId: string | undefined): void {
    this.activeEntryId = entryId;
  }

  createNextEntryTreeNode(
    type: SessionEntryNodeType,
    timestamp: number,
    options: {
      messageIndex?: number;
      kind?: string;
    } = {},
  ): SessionEntryTreeNode {
    return createEntryTreeNode({
      parentEntryId: this.activeEntryId ?? null,
      type,
      timestamp,
      ...options,
    });
  }

  appendEntryTreeNode(entryNode: SessionEntryTreeNode, options: { setActive?: boolean } = {}): void {
    this.entryTree = [
      ...this.entryTree,
      copyEntryTreeNode(entryNode),
    ];
    if (options.setActive ?? true) {
      this.activeEntryId = entryNode.entryId;
    }
  }

  appendPathEntry(entry: SessionPathEntry): void {
    this.pathEntries = [
      ...this.pathEntries,
      copySessionPathEntry(entry),
    ];
  }

  getEntryTreeInfo(sessionId: string): SessionEntryTreeInfo {
    return {
      sessionId,
      activeEntryId: this.activeEntryId,
      entries: this.entryTree.map(copyEntryTreeNode),
    };
  }

  getEntryTree(): SessionEntryTreeNode[] {
    return this.entryTree.map(copyEntryTreeNode);
  }

  getPathEntries(): SessionPathEntry[] {
    return this.pathEntries.map(copySessionPathEntry);
  }

  getEntryPath(leafEntryId?: string): SessionPathEntry[] {
    const activeEntryId = leafEntryId ?? this.activeEntryId;
    if (!activeEntryId) return [];
    return buildEntryPath(this.pathEntries, activeEntryId);
  }

  listEntryTree(): SessionEntryTreeViewNode[] {
    const activePathEntryIds = new Set(
      buildEntryPath(this.pathEntries, this.activeEntryId).map((entry) => entry.entryId),
    );
    const entryMetadata = new Map(
      this.entryTree.map((entry) => [entry.entryId, entry]),
    );
    const nodes = new Map<string, SessionEntryTreeViewNode>();

    for (const entry of this.pathEntries) {
      nodes.set(entry.entryId, {
        entry: createEntryTreeViewItem({
          entry,
          metadata: entryMetadata.get(entry.entryId),
          activeEntryId: this.activeEntryId,
          activePathEntryIds,
        }),
        children: [],
      });
    }

    const roots: SessionEntryTreeViewNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.entry.parentEntryId ? nodes.get(node.entry.parentEntryId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    const sortNodes = (treeNodes: SessionEntryTreeViewNode[]): SessionEntryTreeViewNode[] => {
      treeNodes.sort((a, b) => a.entry.timestamp - b.entry.timestamp || a.entry.entryId.localeCompare(b.entry.entryId));
      for (const node of treeNodes) {
        sortNodes(node.children);
      }
      return treeNodes;
    };

    return sortNodes(roots);
  }
}

export function createEntryTreeNode({
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

export function createEntryTreeFromPathEntries(entries: SessionPathEntry[]): SessionEntryTreeNode[] {
  let messageIndex = 0;
  return entries.map((entry) => {
    const options: { messageIndex?: number; kind?: string } = {};
    if (entry.type === 'message') {
      options.messageIndex = messageIndex;
      messageIndex += 1;
    }
    if (entry.type === 'internal') {
      options.kind = entry.kind;
    }
    return {
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
      type: entry.type,
      timestamp: entry.timestamp,
      ...options,
    };
  });
}

export function entryTreeFields(entryNode: SessionEntryTreeNode): {
  entryId: string;
  parentEntryId: string | null;
} {
  return {
    entryId: entryNode.entryId,
    parentEntryId: entryNode.parentEntryId,
  };
}

export function readEntryTreeNode(
  entry: Extract<SessionPathEntry, { entryId: string }>,
  options: {
    messageIndex?: number;
    kind?: string;
  } = {},
): SessionEntryTreeNode | null {
  if (typeof entry.entryId !== 'string' || !entry.entryId) return null;
  if (entry.parentEntryId !== null && typeof entry.parentEntryId !== 'string') return null;
  const entryNode: SessionEntryTreeNode = {
    entryId: entry.entryId,
    parentEntryId: entry.parentEntryId,
    type: entry.type,
    timestamp: entry.timestamp,
  };
  if (typeof options.messageIndex === 'number') entryNode.messageIndex = options.messageIndex;
  if (options.kind) entryNode.kind = options.kind;
  return entryNode;
}

export function copySessionPathEntry(entry: SessionPathEntry): SessionPathEntry {
  if (entry.type === 'message') {
    return {
      type: 'message',
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
      message: copyPayload(entry.message),
    };
  }
  if (entry.type === 'compaction') {
    return {
      type: 'compaction',
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
      summary: entry.summary,
      firstKeptEntryId: entry.firstKeptEntryId,
      firstKeptMessageIndex: entry.firstKeptMessageIndex,
      messagesBefore: entry.messagesBefore,
      messagesAfter: entry.messagesAfter,
      customInstructions: entry.customInstructions,
    };
  }
  if (entry.type === 'usage') {
    return {
      type: 'usage',
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
      source: entry.source,
      usage: { ...entry.usage },
    };
  }
  if (entry.type === 'branch_summary') {
    return {
      type: 'branch_summary',
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
      fromEntryId: entry.fromEntryId,
      toEntryId: entry.toEntryId,
      pathEntryCount: entry.pathEntryCount,
      messageCount: entry.messageCount,
      label: entry.label,
      reason: entry.reason,
    };
  }
  if (entry.type === 'leaf') {
    return {
      type: 'leaf',
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
      targetEntryId: entry.targetEntryId,
    };
  }
  return {
    type: 'internal',
    sessionId: entry.sessionId,
    timestamp: entry.timestamp,
    entryId: entry.entryId,
    parentEntryId: entry.parentEntryId,
    kind: entry.kind,
    content: entry.content,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  };
}

export function buildEntryPath(entries: SessionPathEntry[], leafEntryId: string | undefined): SessionPathEntry[] {
  if (!leafEntryId) return [];
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
  const pathEntries: SessionPathEntry[] = [];
  let current = byId.get(leafEntryId);
  while (current) {
    pathEntries.unshift(copySessionPathEntry(current));
    current = current.parentEntryId ? byId.get(current.parentEntryId) : undefined;
  }
  return pathEntries;
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

export function createEntryTreeViewItem({
  entry,
  metadata,
  activeEntryId,
  activePathEntryIds,
}: {
  entry: SessionPathEntry;
  metadata?: SessionEntryTreeNode;
  activeEntryId?: string;
  activePathEntryIds?: Set<string>;
}): SessionEntryTreeViewItem {
  const item: SessionEntryTreeViewItem = {
    entryId: entry.entryId,
    parentEntryId: entry.parentEntryId,
    type: entry.type,
    timestamp: entry.timestamp,
    isActive: entry.entryId === activeEntryId,
    isActivePath: activePathEntryIds?.has(entry.entryId) ?? entry.entryId === activeEntryId,
  };

  if (typeof metadata?.messageIndex === 'number') {
    item.messageIndex = metadata.messageIndex;
  }
  if (entry.type === 'message') {
    item.messageRole = entry.message.role;
    item.preview = truncatePreview(entry.message.content);
  } else if (entry.type === 'compaction') {
    item.preview = truncatePreview(entry.summary);
  } else if (entry.type === 'usage') {
    item.preview = `total_tokens=${entry.usage.total_tokens}`;
  } else if (entry.type === 'branch_summary') {
    item.preview = `from=${entry.fromEntryId ?? 'root'} to=${entry.toEntryId} path_entries=${entry.pathEntryCount} messages=${entry.messageCount}`;
  } else if (entry.type === 'leaf') {
    item.preview = `target=${entry.targetEntryId ?? 'root'}`;
  } else {
    item.kind = entry.kind;
    item.preview = truncatePreview(entry.content ?? entry.kind);
  }

  return item;
}

function truncatePreview(content: string, maxChars = 80): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function copyPayload<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}
