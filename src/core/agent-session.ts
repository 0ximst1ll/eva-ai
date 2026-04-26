import type { LLMClient } from '../llm/llm-client.js';
import type {
  AgentSessionEvent,
  LLMResponse,
  Message,
  ToolCall,
  ToolExecutionResult,
} from '../schema.js';
import type { Tool } from '../tools/base.js';
import { RetryExhaustedError } from '../retry.js';
import { SessionManager } from './session-manager.js';

export class AgentSession {
  private readonly llm: LLMClient;
  private readonly tools: Map<string, Tool>;
  private readonly maxSteps: number;
  private readonly sessionManager: SessionManager;
  readonly sessionId: string;
  readonly systemPrompt: string;

  apiTotalTokens = 0;

  constructor({
    llmClient,
    systemPrompt,
    tools,
    maxSteps = 50,
    sessionManager,
    sessionId,
  }: {
    llmClient: LLMClient;
    systemPrompt: string;
    tools: Tool[];
    maxSteps?: number;
    sessionManager: SessionManager;
    sessionId: string;
  }) {
    this.llm = llmClient;
    this.maxSteps = maxSteps;
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.systemPrompt = systemPrompt;
    this.sessionManager = sessionManager;
    this.sessionId = sessionId;
  }

  get messages(): Message[] {
    return this.sessionManager.getMessages(this.sessionId);
  }

  async addUserMessage(content: string): Promise<void> {
    await this.sessionManager.appendMessage(this.sessionId, { role: 'user', content });
  }

  async clear(): Promise<void> {
    await this.sessionManager.resetSession(this.sessionId, this.systemPrompt);
  }

  async run({
    signal,
    onEvent,
  }: {
    signal?: AbortSignal;
    onEvent?: (event: AgentSessionEvent) => void;
  } = {}): Promise<string> {
    const runStart = Date.now();
    const emit = (event: AgentSessionEvent): void => onEvent?.(event);

    for (let step = 0; step < this.maxSteps; step++) {
      if (signal?.aborted) {
        const message = 'Task cancelled by user.';
        emit({ type: 'error', message });
        return message;
      }

      const stepStart = Date.now();
      emit({ type: 'message_start', step: step + 1, maxSteps: this.maxSteps });

      let response: LLMResponse;
      try {
        response = await this.generateResponseWithStreaming(emit);
      } catch (e) {
        let message: string;
        if (e instanceof RetryExhaustedError) {
          message = `LLM call failed after ${e.attempts} retries\nLast error: ${e.lastException.message}`;
        } else {
          message = `LLM call failed: ${String(e)}`;
        }
        emit({
          type: 'error',
          message,
          error: e instanceof Error ? e.stack : String(e),
        });
        return message;
      }

      if (response.usage) {
        this.apiTotalTokens = response.usage.total_tokens;
      }

      await this.sessionManager.appendMessage(this.sessionId, {
        role: 'assistant',
        content: response.content,
        thinking: response.thinking,
        tool_calls: response.tool_calls,
      });

      if (!response.tool_calls?.length) {
        emit({
          type: 'message_end',
          step: step + 1,
          elapsedMs: Date.now() - stepStart,
          totalElapsedMs: Date.now() - runStart,
          response,
        });
        return response.content;
      }

      for (const toolCall of response.tool_calls) {
        if (signal?.aborted) {
          const message = 'Task cancelled by user.';
          emit({ type: 'error', message });
          return message;
        }

        const result = await this.executeTool(toolCall);
        emit({ type: 'tool_result', result });

        await this.sessionManager.appendMessage(this.sessionId, {
          role: 'tool',
          content: result.success ? result.content : `Error: ${result.error ?? 'Unknown error'}`,
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
        });
      }

      emit({
        type: 'message_end',
        step: step + 1,
        elapsedMs: Date.now() - stepStart,
        totalElapsedMs: Date.now() - runStart,
        response,
      });
    }

    const message = `Task couldn't be completed after ${this.maxSteps} steps.`;
    emit({ type: 'error', message });
    return message;
  }

  private async generateResponseWithStreaming(
    emit: (event: AgentSessionEvent) => void,
  ): Promise<LLMResponse> {
    let streamedResponse: LLMResponse | null = null;
    let content = '';
    let thinking = '';
    const toolCalls: ToolCall[] = [];
    let usage = undefined as LLMResponse['usage'];

    for await (const event of this.llm.generateStream(this.messages, [...this.tools.values()])) {
      if (event.type === 'thinking_delta') {
        thinking += event.text;
        emit({ type: 'thinking_delta', text: event.text });
        continue;
      }
      if (event.type === 'content_delta') {
        content += event.text;
        emit({ type: 'content_delta', text: event.text });
        continue;
      }
      if (event.type === 'tool_call') {
        toolCalls.push(event.tool_call);
        emit({ type: 'tool_call', tool_call: event.tool_call });
        continue;
      }
      if (event.type === 'usage') {
        usage = event.usage;
        emit({ type: 'usage', usage: event.usage });
        continue;
      }
      streamedResponse = event.response;
    }

    if (streamedResponse) return streamedResponse;
    return {
      content,
      thinking: thinking || undefined,
      tool_calls: toolCalls.length ? toolCalls : undefined,
      finish_reason: 'stop',
      usage,
    };
  }

  private async executeTool(toolCall: ToolCall): Promise<ToolExecutionResult> {
    const { id: toolCallId, function: fn } = toolCall;
    const { name: functionName, arguments: args } = fn;

    const tool = this.tools.get(functionName);
    if (!tool) {
      return {
        toolCallId,
        toolName: functionName,
        success: false,
        content: '',
        error: `Unknown tool: ${functionName}`,
      };
    }

    try {
      const result = await tool.execute(args);
      return {
        toolCallId,
        toolName: functionName,
        success: result.success,
        content: result.content,
        error: result.error,
      };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      return {
        toolCallId,
        toolName: functionName,
        success: false,
        content: '',
        error: `Tool execution failed: ${err.message}\n\nStack:\n${err.stack ?? ''}`,
      };
    }
  }
}
