import type { LLMClient } from './llm/llm-client.js';
import type { AgentSessionEvent, Message } from './schema.js';
import type { Tool } from './tools/base.js';
import { AgentSession } from './core/agent-session.js';
import { SessionManager } from './core/session-manager.js';
import * as path from 'node:path';

export class Agent {
    private readonly session: AgentSession;
    private readonly sessionManager: SessionManager;
    private readonly ready: Promise<void>;

    apiTotalTokens = 0;

    constructor({
        llmClient,
        systemPrompt,
        tools,
        maxSteps = 50,
        workspaceDir = './workspace',
        tokenLimit = 80000,
    }: {
        llmClient: LLMClient;
        systemPrompt: string;
        tools: Tool[];
        maxSteps?: number;
        workspaceDir?: string;
        tokenLimit?: number;
    }) {
        void tokenLimit;
        const resolvedWorkspace = path.resolve(workspaceDir);
        this.sessionManager = new SessionManager({
            workspaceDir: resolvedWorkspace,
            mode: 'memory',
        });
        const sessionId = `session-${Date.now()}`;
        this.ready = this.sessionManager.createSession(systemPrompt, sessionId).then(() => undefined);
        this.session = new AgentSession({
            llmClient,
            systemPrompt,
            tools,
            maxSteps,
            sessionManager: this.sessionManager,
            sessionId,
        });
    }

    get messages(): Message[] {
        return this.session.messages;
    }

    set messages(nextMessages: Message[]) {
        void nextMessages;
        throw new Error('Direct message replacement is no longer supported. Use SessionManager APIs.');
    }

    async addUserMessage(content: string): Promise<void> {
        await this.ready;
        await this.session.addUserMessage(content);
    }

    async run(
        signalOrOptions?: AbortSignal | { signal?: AbortSignal; onEvent?: (event: AgentSessionEvent) => void },
    ): Promise<string> {
        await this.ready;
        const isOptionsObject =
            typeof signalOrOptions === 'object' &&
            signalOrOptions !== null &&
            ('signal' in signalOrOptions || 'onEvent' in signalOrOptions);
        if (!isOptionsObject) {
            return this.session.run({ signal: signalOrOptions as AbortSignal | undefined });
        }
        return this.session.run(signalOrOptions);
    }

    getHistory(): Message[] {
        return this.messages;
    }
}
