import type { LLMClient } from '../llm/llm-client.js';
import { RetryExhaustedError } from '../retry.js';
import type { LLMResponse, Message, ToolCall, ToolExecutionResult } from '../schema.js';
import type { Tool } from '../tools/base.js';
import type { ContextBuilder } from './context-builder.js';

export type ToolExecutionMode = 'parallel' | 'sequential';

export interface BeforeToolCallContext {
  toolCall: ToolCall;
  tool?: Tool;
  args: Record<string, unknown>;
  messages: Message[];
}

export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

export interface AfterToolCallContext {
  toolCall: ToolCall;
  tool: Tool;
  args: Record<string, unknown>;
  result: ToolExecutionResult;
  messages: Message[];
}

export type AfterToolCallResult = Partial<Pick<ToolExecutionResult, 'success' | 'content' | 'error'>>;

export type AgentLoopEvent =
  | { type: 'agent_start' }
  | { type: 'turn_start'; step: number; maxSteps?: number | null }
  | { type: 'input_message'; message: Message }
  | { type: 'message_start'; step: number; maxSteps?: number | null }
  | { type: 'assistant_message'; message: Extract<Message, { role: 'assistant' }> }
  | { type: 'thinking_delta'; text: string }
  | { type: 'content_delta'; text: string }
  | { type: 'tool_call'; tool_call: ToolCall }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool_execution_end'; result: ToolExecutionResult }
  | { type: 'tool_result'; result: ToolExecutionResult }
  | { type: 'usage'; usage: NonNullable<LLMResponse['usage']> }
  | { type: 'message_end'; step: number; elapsedMs: number; totalElapsedMs: number; response: LLMResponse }
  | { type: 'turn_end'; step: number; response?: LLMResponse; toolResults: ToolExecutionResult[] }
  | { type: 'agent_end'; messages: Message[]; finalContent: string }
  | { type: 'error'; message: string; error?: string };

export type AgentLoopEventSink = (event: AgentLoopEvent) => void | Promise<void>;

export interface AgentLoopConfig {
  llmClient: LLMClient;
  tools: Tool[];
  maxSteps?: number | null;
  systemPrompt?: string;
  messages: Message[];
  contextBuilder?: ContextBuilder;
  signal?: AbortSignal;
  emit?: AgentLoopEventSink;
  toolExecution?: ToolExecutionMode;
  getSteeringMessages?: () => Message[] | Promise<Message[]>;
  getFollowUpMessages?: () => Message[] | Promise<Message[]>;
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => BeforeToolCallResult | Promise<BeforeToolCallResult | undefined> | undefined;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => AfterToolCallResult | Promise<AfterToolCallResult | undefined> | undefined;
}

export interface AgentLoopResult {
  messages: Message[];
  finalContent: string;
  apiTotalTokens: number;
}

async function emit(sink: AgentLoopEventSink | undefined, event: AgentLoopEvent): Promise<void> {
  await sink?.(event);
}

async function drainMessages(callback?: () => Message[] | Promise<Message[]>): Promise<Message[]> {
  return (await callback?.()) ?? [];
}

async function generateResponseWithStreaming({
  llmClient,
  messages,
  tools,
  emit: eventSink,
}: {
  llmClient: LLMClient;
  messages: Message[];
  tools: Tool[];
  emit?: AgentLoopEventSink;
}): Promise<LLMResponse> {
  let streamedResponse: LLMResponse | null = null;
  let content = '';
  let thinking = '';
  const toolCalls: ToolCall[] = [];
  let usage = undefined as LLMResponse['usage'];

  for await (const event of llmClient.generateStream(messages, tools)) {
    if (event.type === 'thinking_delta') {
      thinking += event.text;
      await emit(eventSink, { type: 'thinking_delta', text: event.text });
      continue;
    }
    if (event.type === 'content_delta') {
      content += event.text;
      await emit(eventSink, { type: 'content_delta', text: event.text });
      continue;
    }
    if (event.type === 'tool_call') {
      toolCalls.push(event.tool_call);
      await emit(eventSink, { type: 'tool_call', tool_call: event.tool_call });
      continue;
    }
    if (event.type === 'usage') {
      usage = event.usage;
      await emit(eventSink, { type: 'usage', usage: event.usage });
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

function createBlockedToolResult(toolCall: ToolCall, reason?: string): ToolExecutionResult {
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    success: false,
    content: '',
    error: reason || 'Tool execution was blocked',
  };
}

async function executeToolCall(
  toolCall: ToolCall,
  toolMap: Map<string, Tool>,
  messages: Message[],
  config: AgentLoopConfig,
): Promise<ToolExecutionResult> {
  const { id: toolCallId, function: fn } = toolCall;
  const { name: toolName, arguments: args } = fn;

  await emit(config.emit, { type: 'tool_execution_start', toolCallId, toolName, args });

  const tool = toolMap.get(toolName);
  if (!tool) {
    const result = {
      toolCallId,
      toolName,
      success: false,
      content: '',
      error: `Unknown tool: ${toolName}`,
    } satisfies ToolExecutionResult;
    await emit(config.emit, { type: 'tool_execution_end', result });
    return result;
  }

  try {
    const before = await config.beforeToolCall?.({ toolCall, tool, args, messages }, config.signal);
    if (before?.block) {
      const result = createBlockedToolResult(toolCall, before.reason);
      await emit(config.emit, { type: 'tool_execution_end', result });
      return result;
    }

    const output = await tool.execute(args, { toolCallId, signal: config.signal });
    let result = {
      toolCallId,
      toolName,
      success: output.success,
      content: output.content,
      error: output.error,
    } satisfies ToolExecutionResult;

    const after = await config.afterToolCall?.({ toolCall, tool, args, result, messages }, config.signal);
    if (after) result = { ...result, ...after };

    await emit(config.emit, { type: 'tool_execution_end', result });
    return result;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const result = {
      toolCallId,
      toolName,
      success: false,
      content: '',
      error: `Tool execution failed: ${err.message}\n\nStack:\n${err.stack ?? ''}`,
    } satisfies ToolExecutionResult;
    await emit(config.emit, { type: 'tool_execution_end', result });
    return result;
  }
}

function shouldRunSequential(toolCalls: ToolCall[], toolMap: Map<string, Tool>, mode?: ToolExecutionMode): boolean {
  if (mode === 'sequential') return true;
  if (mode === 'parallel') return false;
  return toolCalls.some((toolCall) => {
    const tool = toolMap.get(toolCall.function.name);
    return tool?.metadata?.isConcurrencySafe === false;
  });
}

async function executeToolCalls(
  toolCalls: ToolCall[],
  toolMap: Map<string, Tool>,
  messages: Message[],
  config: AgentLoopConfig,
): Promise<ToolExecutionResult[]> {
  if (shouldRunSequential(toolCalls, toolMap, config.toolExecution)) {
    const results: ToolExecutionResult[] = [];
    for (const toolCall of toolCalls) {
      results.push(await executeToolCall(toolCall, toolMap, messages, config));
    }
    return results;
  }

  return Promise.all(toolCalls.map((toolCall) => executeToolCall(toolCall, toolMap, messages, config)));
}

async function appendInputMessages(
  messages: Message[],
  pendingMessages: Message[],
  eventSink?: AgentLoopEventSink,
): Promise<void> {
  for (const message of pendingMessages) {
    messages.push(message);
    await emit(eventSink, { type: 'input_message', message });
  }
}

function abortResult(messages: Message[], finalContent: string, apiTotalTokens: number): AgentLoopResult {
  return { messages, finalContent, apiTotalTokens };
}

function getSystemPromptForContext(config: AgentLoopConfig, messages: Message[]): string {
  if (config.systemPrompt !== undefined) return config.systemPrompt;
  const systemMessage = messages.find((message) => message.role === 'system');
  return systemMessage?.content ?? '';
}

function hasStepLimit(maxSteps: number | null | undefined): maxSteps is number {
  return typeof maxSteps === 'number' && Number.isFinite(maxSteps) && maxSteps > 0;
}

export async function runAgentLoop(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const runStart = Date.now();
  const messages = [...config.messages];
  const toolMap = new Map(config.tools.map((tool) => [tool.name, tool]));
  let apiTotalTokens = 0;
  let finalContent = '';
  let step = 0;

  await emit(config.emit, { type: 'agent_start' });

  let pendingMessages = await drainMessages(config.getSteeringMessages);

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (config.signal?.aborted) {
        const message = 'Task cancelled by user.';
        await emit(config.emit, { type: 'error', message });
        await emit(config.emit, { type: 'agent_end', messages, finalContent: message });
        return abortResult(messages, message, apiTotalTokens);
      }

      if (pendingMessages.length > 0) {
        await appendInputMessages(messages, pendingMessages, config.emit);
        pendingMessages = [];
      }

      if (hasStepLimit(config.maxSteps) && step >= config.maxSteps) {
        const message = `Task couldn't be completed after ${config.maxSteps} steps.`;
        await emit(config.emit, { type: 'error', message });
        await emit(config.emit, { type: 'agent_end', messages, finalContent: message });
        return { messages, finalContent: message, apiTotalTokens };
      }

      step += 1;
      const stepStart = Date.now();
      await emit(config.emit, { type: 'turn_start', step, maxSteps: config.maxSteps });
      await emit(config.emit, { type: 'message_start', step, maxSteps: config.maxSteps });

      let response: LLMResponse;
      try {
        const requestMessages = config.contextBuilder
          ? config.contextBuilder.build({
            systemPrompt: getSystemPromptForContext(config, messages),
            messages,
          }).messages
          : messages;
        response = await generateResponseWithStreaming({
          llmClient: config.llmClient,
          messages: requestMessages,
          tools: config.tools,
          emit: config.emit,
        });
      } catch (e) {
        let message: string;
        if (e instanceof RetryExhaustedError) {
          message = `LLM call failed after ${e.attempts} retries\nLast error: ${e.lastException.message}`;
        } else {
          message = `LLM call failed: ${String(e)}`;
        }
        await emit(config.emit, { type: 'error', message, error: e instanceof Error ? e.stack : String(e) });
        await emit(config.emit, { type: 'agent_end', messages, finalContent: message });
        return { messages, finalContent: message, apiTotalTokens };
      }

      if (response.usage) apiTotalTokens = response.usage.total_tokens;
      finalContent = response.content;

      const assistantMessage = {
        role: 'assistant',
        content: response.content,
        thinking: response.thinking,
        tool_calls: response.tool_calls,
      } satisfies Extract<Message, { role: 'assistant' }>;
      messages.push(assistantMessage);
      await emit(config.emit, { type: 'assistant_message', message: assistantMessage });

      const toolResults: ToolExecutionResult[] = [];
      if (response.tool_calls?.length) {
        toolResults.push(...(await executeToolCalls(response.tool_calls, toolMap, messages, config)));
        for (const result of toolResults) {
          await emit(config.emit, { type: 'tool_result', result });
          messages.push({
            role: 'tool',
            content: result.success ? result.content : `Error: ${result.error ?? 'Unknown error'}`,
            tool_call_id: result.toolCallId,
            name: result.toolName,
          });
        }
      }

      await emit(config.emit, {
        type: 'message_end',
        step,
        elapsedMs: Date.now() - stepStart,
        totalElapsedMs: Date.now() - runStart,
        response,
      });
      await emit(config.emit, { type: 'turn_end', step, response, toolResults });

      hasMoreToolCalls = toolResults.length > 0;
      pendingMessages = await drainMessages(config.getSteeringMessages);
    }

    const followUpMessages = await drainMessages(config.getFollowUpMessages);
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    await emit(config.emit, { type: 'agent_end', messages, finalContent });
    return { messages, finalContent, apiTotalTokens };
  }
}
