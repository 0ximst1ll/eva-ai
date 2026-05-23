import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionEntry, SessionStartEntry } from './session-manager.js';

export interface SessionManifest {
  latestSessionId: string;
  updatedAt: number;
}

export class WorkspaceSessionStore {
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
