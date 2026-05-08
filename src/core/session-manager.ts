import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message } from '../schema.js';

type PersistenceMode = 'memory' | 'jsonl';

interface SessionManifest {
  latestSessionId: string;
  updatedAt: number;
}

interface SessionStartEntry {
  type: 'session_start';
  sessionId: string;
  workspaceDir: string;
  createdAt: number;
}

interface MessageEntry {
  type: 'message';
  sessionId: string;
  timestamp: number;
  message: Message;
}

type SessionLogEntry = SessionStartEntry | MessageEntry;

interface SessionMetadata {
  createdAt: number;
  updatedAt: number;
}

export interface SessionListItem {
  sessionId: string;
  messageCount: number;
  updatedAt: number;
  isLatest: boolean;
}

export class SessionManager {
  private readonly mode: PersistenceMode;
  private readonly workspaceDir: string;
  private readonly baseDir: string;
  private readonly workspaceKey: string;
  private readonly sessions = new Map<string, Message[]>();
  private readonly sessionMetadata = new Map<string, SessionMetadata>();
  private latestSessionId?: string;

  constructor({
    workspaceDir,
    mode = 'jsonl',
    baseDir,
  }: {
    workspaceDir: string;
    mode?: PersistenceMode;
    baseDir?: string;
  }) {
    this.mode = mode;
    this.workspaceDir = path.resolve(workspaceDir);
    this.baseDir = baseDir ?? path.join(os.homedir(), '.eva-ai', 'sessions');
    this.workspaceKey = encodeURIComponent(this.workspaceDir);
  }

  async createSession(systemPrompt: string, sessionId?: string): Promise<string> {
    const id = sessionId ?? randomUUID();
    const now = Date.now();
    const initialMessages: Message[] = [{ role: 'system', content: systemPrompt }];
    this.sessions.set(id, initialMessages);
    this.sessionMetadata.set(id, { createdAt: now, updatedAt: now });
    this.latestSessionId = id;

    if (this.mode === 'jsonl') {
      await this.ensureWorkspaceDir();
      await this.writeSessionStart(id);
      await this.appendEntry({
        type: 'message',
        sessionId: id,
        timestamp: now,
        message: initialMessages[0],
      });
      await this.writeManifest({ latestSessionId: id, updatedAt: now });
    }
    return id;
  }

  async loadLatestSession(): Promise<string | null> {
    if (this.mode !== 'jsonl') return null;
    try {
      const manifest = await this.readManifest();
      if (!manifest?.latestSessionId) return null;
      await this.loadSession(manifest.latestSessionId);
      return manifest.latestSessionId;
    } catch {
      return null;
    }
  }

  async loadSession(sessionId: string): Promise<boolean> {
    if (this.sessions.has(sessionId)) {
      await this.markLatestSession(sessionId);
      return true;
    }
    if (this.mode !== 'jsonl') return false;

    try {
      const content = await fs.readFile(this.getSessionFilePath(sessionId), 'utf-8');
      const parsed = this.parseSessionLog(content, sessionId);
      if (!parsed.messages.length) return false;
      this.sessions.set(sessionId, parsed.messages);
      this.sessionMetadata.set(sessionId, {
        createdAt: parsed.createdAt ?? parsed.updatedAt,
        updatedAt: parsed.updatedAt,
      });
      await this.markLatestSession(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  getMessages(sessionId: string): Message[] {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  async appendMessage(sessionId: string, message: Message): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    existing.push(message);
    this.sessions.set(sessionId, existing);
    const now = Date.now();
    this.touchSession(sessionId, now);

    if (this.mode === 'jsonl') {
      await this.appendEntry({
        type: 'message',
        sessionId,
        timestamp: now,
        message,
      });
      await this.writeManifest({ latestSessionId: sessionId, updatedAt: now });
    }
  }

  async resetSession(sessionId: string, systemPrompt: string): Promise<void> {
    const now = Date.now();
    const resetMessages: Message[] = [{ role: 'system', content: systemPrompt }];
    this.sessions.set(sessionId, resetMessages);
    this.touchSession(sessionId, now);

    if (this.mode === 'jsonl') {
      await fs.writeFile(this.getSessionFilePath(sessionId), '', 'utf-8');
      await this.writeSessionStart(sessionId);
      await this.appendEntry({
        type: 'message',
        sessionId,
        timestamp: now,
        message: resetMessages[0],
      });
      await this.writeManifest({ latestSessionId: sessionId, updatedAt: now });
    }
  }

  async listSessions(): Promise<SessionListItem[]> {
    if (this.mode === 'memory') {
      return this.sortSessionList(
        [...this.sessions.entries()].map(([sessionId, messages]) => ({
          sessionId,
          messageCount: messages.length,
          updatedAt: this.sessionMetadata.get(sessionId)?.updatedAt ?? 0,
          isLatest: this.latestSessionId === sessionId,
        })),
      );
    }

    const manifest = await this.readManifest();
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.getWorkspaceDataDir());
    } catch {
      return [];
    }

    const sessions: SessionListItem[] = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith('.jsonl')) continue;
      const sessionId = fileName.slice(0, -'.jsonl'.length);
      try {
        const content = await fs.readFile(this.getSessionFilePath(sessionId), 'utf-8');
        const parsed = this.parseSessionLog(content, sessionId);
        if (!parsed.messages.length) continue;
        sessions.push({
          sessionId,
          messageCount: parsed.messages.length,
          updatedAt: parsed.updatedAt,
          isLatest: manifest?.latestSessionId === sessionId,
        });
      } catch {
        continue;
      }
    }

    return this.sortSessionList(sessions);
  }

  private getWorkspaceDataDir(): string {
    return path.join(this.baseDir, this.workspaceKey);
  }

  private getSessionFilePath(sessionId: string): string {
    return path.join(this.getWorkspaceDataDir(), `${sessionId}.jsonl`);
  }

  private getManifestFilePath(): string {
    return path.join(this.getWorkspaceDataDir(), 'manifest.json');
  }

  private async ensureWorkspaceDir(): Promise<void> {
    await fs.mkdir(this.getWorkspaceDataDir(), { recursive: true });
  }

  private async writeSessionStart(sessionId: string): Promise<void> {
    const entry: SessionStartEntry = {
      type: 'session_start',
      sessionId,
      workspaceDir: this.workspaceDir,
      createdAt: Date.now(),
    };
    await fs.writeFile(this.getSessionFilePath(sessionId), `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  private async appendEntry(entry: SessionLogEntry): Promise<void> {
    await this.ensureWorkspaceDir();
    await fs.appendFile(this.getSessionFilePath(entry.sessionId), `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  private async readManifest(): Promise<SessionManifest | null> {
    try {
      const raw = await fs.readFile(this.getManifestFilePath(), 'utf-8');
      const parsed = JSON.parse(raw) as SessionManifest;
      if (!parsed.latestSessionId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeManifest(manifest: SessionManifest): Promise<void> {
    await this.ensureWorkspaceDir();
    await fs.writeFile(this.getManifestFilePath(), JSON.stringify(manifest, null, 2), 'utf-8');
  }

  private touchSession(sessionId: string, updatedAt: number): void {
    const existing = this.sessionMetadata.get(sessionId);
    this.sessionMetadata.set(sessionId, {
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
    });
    this.latestSessionId = sessionId;
  }

  private async markLatestSession(sessionId: string): Promise<void> {
    const updatedAt = Date.now();
    this.touchSession(sessionId, updatedAt);
    if (this.mode === 'jsonl') {
      await this.writeManifest({ latestSessionId: sessionId, updatedAt });
    }
  }

  private parseSessionLog(
    content: string,
    sessionId: string,
  ): { messages: Message[]; createdAt?: number; updatedAt: number } {
    const messages: Message[] = [];
    let createdAt: number | undefined;
    let updatedAt = 0;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as SessionLogEntry;
        if (entry.sessionId !== sessionId) continue;
        if (entry.type === 'session_start') {
          createdAt = entry.createdAt;
          updatedAt = Math.max(updatedAt, entry.createdAt);
          continue;
        }
        if (entry.type === 'message') {
          messages.push(entry.message);
          updatedAt = Math.max(updatedAt, entry.timestamp);
        }
      } catch {
        continue;
      }
    }

    return { messages, createdAt, updatedAt };
  }

  private sortSessionList(sessions: SessionListItem[]): SessionListItem[] {
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
  }
}
