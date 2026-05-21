import {
  createRuntime,
  type CreateRuntimeOptions,
  type Runtime,
  type RuntimeResourceReloadResult,
  RuntimeSessionNotFoundError,
} from './runtime.js';
import type { AgentSession } from './agent-session.js';
import type { SessionBranchSummary, SessionListItem } from './session-manager.js';

export interface RuntimeHostOptions extends Omit<CreateRuntimeOptions, 'createNewSession' | 'sessionId' | 'createSessionIfMissing'> {
  createNewSession?: boolean;
  sessionId?: string;
}

export class RuntimeChildSessionNotFoundError extends Error {
  readonly parentSessionId: string;
  readonly sessionId: string;

  constructor(parentSessionId: string, sessionId: string) {
    super(`Child session not found under ${parentSessionId}: ${sessionId}`);
    this.name = 'RuntimeChildSessionNotFoundError';
    this.parentSessionId = parentSessionId;
    this.sessionId = sessionId;
  }
}

export class RuntimeChildSessionAmbiguousError extends Error {
  readonly parentSessionId: string;
  readonly childSessions: SessionListItem[];

  constructor(parentSessionId: string, childSessions: SessionListItem[]) {
    super(`Multiple child sessions found under ${parentSessionId}`);
    this.name = 'RuntimeChildSessionAmbiguousError';
    this.parentSessionId = parentSessionId;
    this.childSessions = childSessions;
  }
}

export class RuntimeHost {
  private currentRuntime: Runtime;
  private readonly options: RuntimeHostOptions;

  private constructor(options: RuntimeHostOptions, runtime: Runtime) {
    this.options = { ...options };
    this.currentRuntime = runtime;
  }

  static async create(options: RuntimeHostOptions): Promise<RuntimeHost> {
    const runtime = await createRuntime({
      ...options,
      createNewSession: options.createNewSession,
      sessionId: options.sessionId,
    });
    return new RuntimeHost(options, runtime);
  }

  get runtime(): Runtime {
    return this.currentRuntime;
  }

  get session(): AgentSession {
    return this.currentRuntime.session;
  }

  get sessionId(): string {
    return this.currentRuntime.sessionId;
  }

  async newSession(): Promise<Runtime> {
    this.currentRuntime = await createRuntime({
      ...this.options,
      createNewSession: true,
      sessionId: undefined,
    });
    return this.currentRuntime;
  }

  async resumeLatestSession(): Promise<Runtime> {
    this.currentRuntime = await createRuntime({
      ...this.options,
      createNewSession: false,
      sessionId: undefined,
    });
    return this.currentRuntime;
  }

  async switchSession(sessionId: string): Promise<Runtime> {
    const runtime = await createRuntime({
      ...this.options,
      createNewSession: false,
      createSessionIfMissing: false,
      sessionId,
    });

    if (runtime.sessionId !== sessionId) {
      throw new RuntimeSessionNotFoundError(sessionId);
    }

    this.currentRuntime = runtime;
    return this.currentRuntime;
  }

  async switchToParentSession(): Promise<Runtime | null> {
    const parentSessionId = this.currentRuntime.sessionManager.getLineageInfo(this.sessionId).parentSessionId;
    if (!parentSessionId) return null;
    return this.switchSession(parentSessionId);
  }

  async listChildSessions(): Promise<SessionListItem[]> {
    return this.currentRuntime.sessionManager.listChildSessions(this.sessionId);
  }

  async switchToChildSession(sessionId?: string): Promise<Runtime | null> {
    const childSessions = await this.listChildSessions();
    if (!childSessions.length) return null;

    const firstChildSession = childSessions[0];
    if (!firstChildSession) return null;

    let targetSession = firstChildSession;
    if (sessionId) {
      const matchingSession = childSessions.find((session) => session.sessionId === sessionId);
      if (!matchingSession) {
        throw new RuntimeChildSessionNotFoundError(this.sessionId, sessionId);
      }
      targetSession = matchingSession;
    } else if (childSessions.length > 1) {
      throw new RuntimeChildSessionAmbiguousError(this.sessionId, childSessions);
    }

    return this.switchSession(targetSession.sessionId);
  }

  async branchSession(leafEntryId: string): Promise<SessionBranchSummary> {
    return this.currentRuntime.session.branchToEntry(leafEntryId);
  }

  async forkSession(sessionId?: string, leafEntryId?: string): Promise<Runtime> {
    const forkedSessionId = await this.currentRuntime.sessionManager.forkSession({
      sourceSessionId: this.sessionId,
      sessionId,
      leafEntryId,
    });
    this.currentRuntime = await createRuntime({
      ...this.options,
      createNewSession: false,
      createSessionIfMissing: false,
      sessionId: forkedSessionId,
    });
    return this.currentRuntime;
  }

  async cloneSession(sessionId?: string, leafEntryId?: string): Promise<Runtime> {
    const clonedSessionId = await this.currentRuntime.sessionManager.cloneSession({
      sourceSessionId: this.sessionId,
      sessionId,
      leafEntryId,
    });
    this.currentRuntime = await createRuntime({
      ...this.options,
      createNewSession: false,
      createSessionIfMissing: false,
      sessionId: clonedSessionId,
    });
    return this.currentRuntime;
  }

  async exportSession(outputPath?: string): Promise<string> {
    const result = await this.currentRuntime.sessionManager.exportSession({
      sessionId: this.sessionId,
      outputPath,
    });
    return result.path;
  }

  async importSession(inputPath: string): Promise<Runtime> {
    const result = await this.currentRuntime.sessionManager.importSession({ inputPath });
    this.currentRuntime = await createRuntime({
      ...this.options,
      createNewSession: false,
      createSessionIfMissing: false,
      sessionId: result.sessionId,
    });
    return this.currentRuntime;
  }

  async reloadResources(): Promise<RuntimeResourceReloadResult> {
    return this.currentRuntime.reloadResources();
  }
}
