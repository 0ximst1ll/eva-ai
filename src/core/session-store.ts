import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolResultArtifactReference } from '../schema.js';
import type { SessionEntry, SessionStartEntry } from './session-manager.js';

export interface SessionManifest {
  latestSessionId: string;
  updatedAt: number;
}

export interface SessionStorage {
  readonly kind: 'memory' | 'jsonl';
  getSessionFilePath(sessionId: string): string | undefined;
  writeToolResultArtifact(record: ToolResultArtifactRecord): Promise<ToolResultArtifactReference>;
  readToolResultArtifact(sessionId: string, artifactId: string): Promise<string>;
  writeSessionStart(entry: SessionStartEntry): Promise<void>;
  appendEntry(entry: SessionEntry): Promise<void>;
  readSessionLog(sessionId: string): Promise<string>;
  writeSessionLog(sessionId: string, content: string): Promise<void>;
  copySessionLog(sessionId: string, outputPath: string): Promise<void>;
  listSessionIds(): Promise<string[]>;
  readManifest(): Promise<SessionManifest | null>;
  writeManifest(manifest: SessionManifest): Promise<void>;
}

export interface ToolResultArtifactRecord {
  artifactId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  kind: 'content' | 'error';
  content: string;
  createdAt: number;
}

export class JsonlSessionStorage implements SessionStorage {
  readonly kind = 'jsonl';
  private readonly workspaceKey: string;

  constructor(
    private readonly workspaceDir: string,
    private readonly baseDir: string,
  ) {
    this.workspaceKey = encodeURIComponent(path.resolve(workspaceDir));
  }

  getWorkspaceDataDir(): string {
    return path.join(this.baseDir, this.workspaceKey);
  }

  getSessionFilePath(sessionId: string): string {
    return path.join(this.getWorkspaceDataDir(), `${sessionId}.jsonl`);
  }

  getToolResultArtifactPath(sessionId: string, artifactId: string): string {
    return path.join(this.getWorkspaceDataDir(), 'artifacts', sessionId, `${artifactId}.txt`);
  }

  getManifestFilePath(): string {
    return path.join(this.getWorkspaceDataDir(), 'manifest.json');
  }

  async ensureWorkspaceDir(): Promise<void> {
    await fs.mkdir(this.getWorkspaceDataDir(), { recursive: true });
  }

  async writeSessionStart(entry: SessionStartEntry): Promise<void> {
    await this.ensureWorkspaceDir();
    await fs.writeFile(this.getSessionFilePath(entry.sessionId), `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  async writeToolResultArtifact(record: ToolResultArtifactRecord): Promise<ToolResultArtifactReference> {
    const artifactPath = this.getToolResultArtifactPath(record.sessionId, record.artifactId);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, record.content, 'utf-8');
    return {
      artifactId: record.artifactId,
      sessionId: record.sessionId,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      kind: record.kind,
      path: path.relative(this.getWorkspaceDataDir(), artifactPath).split(path.sep).join('/'),
      byteLength: Buffer.byteLength(record.content, 'utf-8'),
      charLength: record.content.length,
      createdAt: record.createdAt,
    };
  }

  async readToolResultArtifact(sessionId: string, artifactId: string): Promise<string> {
    return fs.readFile(this.getToolResultArtifactPath(sessionId, artifactId), 'utf-8');
  }

  async appendEntry(entry: SessionEntry): Promise<void> {
    await this.ensureWorkspaceDir();
    await fs.appendFile(this.getSessionFilePath(entry.sessionId), `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  async readSessionLog(sessionId: string): Promise<string> {
    return fs.readFile(this.getSessionFilePath(sessionId), 'utf-8');
  }

  async writeSessionLog(sessionId: string, content: string): Promise<void> {
    await this.ensureWorkspaceDir();
    await fs.writeFile(this.getSessionFilePath(sessionId), content, 'utf-8');
  }

  async copySessionLog(sessionId: string, outputPath: string): Promise<void> {
    await fs.copyFile(this.getSessionFilePath(sessionId), outputPath);
  }

  async listSessionIds(): Promise<string[]> {
    try {
      const fileNames = await fs.readdir(this.getWorkspaceDataDir());
      return fileNames
        .filter((fileName) => fileName.endsWith('.jsonl'))
        .map((fileName) => fileName.slice(0, -'.jsonl'.length));
    } catch {
      return [];
    }
  }

  async readManifest(): Promise<SessionManifest | null> {
    try {
      const raw = await fs.readFile(this.getManifestFilePath(), 'utf-8');
      const parsed = JSON.parse(raw) as SessionManifest;
      if (!parsed.latestSessionId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async writeManifest(manifest: SessionManifest): Promise<void> {
    await this.ensureWorkspaceDir();
    await fs.writeFile(this.getManifestFilePath(), JSON.stringify(manifest, null, 2), 'utf-8');
  }
}

export class MemorySessionStorage implements SessionStorage {
  readonly kind = 'memory';
  private readonly sessionLogs = new Map<string, string>();
  private readonly toolResultArtifacts = new Map<string, string>();
  private manifest: SessionManifest | null = null;

  getSessionFilePath(): undefined {
    return undefined;
  }

  async writeSessionStart(entry: SessionStartEntry): Promise<void> {
    this.sessionLogs.set(entry.sessionId, `${JSON.stringify(entry)}\n`);
  }

  async writeToolResultArtifact(record: ToolResultArtifactRecord): Promise<ToolResultArtifactReference> {
    this.toolResultArtifacts.set(createArtifactKey(record.sessionId, record.artifactId), record.content);
    return {
      artifactId: record.artifactId,
      sessionId: record.sessionId,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      kind: record.kind,
      byteLength: Buffer.byteLength(record.content, 'utf-8'),
      charLength: record.content.length,
      createdAt: record.createdAt,
    };
  }

  async readToolResultArtifact(sessionId: string, artifactId: string): Promise<string> {
    const content = this.toolResultArtifacts.get(createArtifactKey(sessionId, artifactId));
    if (content === undefined) {
      throw new Error(`Tool result artifact not found: ${artifactId}`);
    }
    return content;
  }

  async appendEntry(entry: SessionEntry): Promise<void> {
    const current = this.sessionLogs.get(entry.sessionId) ?? '';
    this.sessionLogs.set(entry.sessionId, `${current}${JSON.stringify(entry)}\n`);
  }

  async readSessionLog(sessionId: string): Promise<string> {
    const content = this.sessionLogs.get(sessionId);
    if (content === undefined) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return content;
  }

  async writeSessionLog(sessionId: string, content: string): Promise<void> {
    this.sessionLogs.set(sessionId, content.endsWith('\n') ? content : `${content}\n`);
  }

  async copySessionLog(sessionId: string, outputPath: string): Promise<void> {
    await fs.writeFile(outputPath, await this.readSessionLog(sessionId), 'utf-8');
  }

  async listSessionIds(): Promise<string[]> {
    return [...this.sessionLogs.keys()];
  }

  async readManifest(): Promise<SessionManifest | null> {
    return this.manifest;
  }

  async writeManifest(manifest: SessionManifest): Promise<void> {
    this.manifest = { ...manifest };
  }
}

export { JsonlSessionStorage as WorkspaceSessionStore };

function createArtifactKey(sessionId: string, artifactId: string): string {
  return `${sessionId}:${artifactId}`;
}
