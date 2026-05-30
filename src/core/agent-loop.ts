import type { LLMClient } from '../llm/llm-client.js';
import { formatProviderError } from '../llm/provider-errors.js';
import { RetryExhaustedError } from '../retry.js';
import type { AgentMessage, LLMResponse, LlmMessage, ToolCall, ToolExecutionResult } from '../schema.js';
import type { Tool, ToolExecutionContext } from '../tools/base.js';
import {
  createInternalAgentMessage,
  defaultConvertToLlm,
  defaultTransformContext,
  isLlmMessage,
  type ConvertToLlm,
  type TransformContext,
} from './agent-messages.js';
import type { ContextBuilder, ProviderRequestView } from './context-builder.js';
import {
  applyToolResultBudget,
  formatToolResultMessageContent,
  type ToolResultBudgetOptions,
} from './tool-result-budget.js';

export type ToolExecutionMode = 'parallel' | 'sequential';
type ToolExecutionBatch = {
  mode: ToolExecutionMode;
  toolCalls: ToolCall[];
};

export interface BeforeToolCallContext {
  toolCall: ToolCall;
  tool?: Tool;
  args: Record<string, unknown>;
  messages: AgentMessage[];
}

export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
  toolExecutionContext?: Partial<ToolExecutionContext>;
}

export interface AfterToolCallContext {
  toolCall: ToolCall;
  tool: Tool;
  args: Record<string, unknown>;
  result: ToolExecutionResult;
  messages: AgentMessage[];
}

export type AfterToolCallResult = Partial<Pick<
  ToolExecutionResult,
  'success' | 'content' | 'error' | 'details'
>>;

export type AgentLoopEvent =
  | { type: 'agent_start' }
  | { type: 'turn_start'; step: number; maxSteps?: number | null }
  | { type: 'input_message'; message: AgentMessage }
  | { type: 'message_start'; step: number; maxSteps?: number | null }
  | { type: 'assistant_message'; message: Extract<AgentMessage, { role: 'assistant' }> }
  | { type: 'thinking_delta'; text: string }
  | { type: 'content_delta'; text: string }
  | { type: 'tool_call'; tool_call: ToolCall }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool_execution_end'; result: ToolExecutionResult }
  | { type: 'tool_result'; result: ToolExecutionResult }
  | { type: 'usage'; usage: NonNullable<LLMResponse['usage']> }
  | { type: 'message_end'; step: number; elapsedMs: number; totalElapsedMs: number; response: LLMResponse }
  | { type: 'turn_end'; step: number; response?: LLMResponse; toolResults: ToolExecutionResult[] }
  | { type: 'agent_end'; messages: AgentMessage[]; finalContent: string }
  | { type: 'error'; message: string; error?: string };

export type AgentLoopEventSink = (event: AgentLoopEvent) => void | Promise<void>;

export interface AgentLoopConfig {
  llmClient: LLMClient;
  tools: Tool[];
  maxSteps?: number | null;
  systemPrompt?: string;
  messages: AgentMessage[];
  contextBuilder?: ContextBuilder;
  transformContext?: TransformContext;
  convertToLlm?: ConvertToLlm;
  signal?: AbortSignal;
  emit?: AgentLoopEventSink;
  toolExecution?: ToolExecutionMode;
  toolResultBudget?: ToolResultBudgetOptions;
  getSteeringMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
  getFollowUpMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
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
  messages: AgentMessage[];
  finalContent: string;
  apiTotalTokens: number;
}

async function emit(sink: AgentLoopEventSink | undefined, event: AgentLoopEvent): Promise<void> {
  await sink?.(event);
}

async function drainMessages(callback?: () => AgentMessage[] | Promise<AgentMessage[]>): Promise<AgentMessage[]> {
  return (await callback?.()) ?? [];
}

async function generateResponseWithStreaming({
  llmClient,
  messages,
  tools,
  emit: eventSink,
}: {
  llmClient: LLMClient;
  messages: LlmMessage[];
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

function createAbortedToolResult(toolCall: ToolCall): ToolExecutionResult {
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    success: false,
    content: '',
    error: 'Tool execution aborted',
  };
}

async function executeToolCall(
  toolCall: ToolCall,
  toolMap: Map<string, Tool>,
  messages: AgentMessage[],
  config: AgentLoopConfig,
): Promise<ToolExecutionResult> {
  const { id: toolCallId, function: fn } = toolCall;
  const { name: toolName, arguments: args } = fn;

  if (config.signal?.aborted) {
    return applyToolResultBudget(createAbortedToolResult(toolCall), config.toolResultBudget);
  }

  await emit(config.emit, { type: 'tool_execution_start', toolCallId, toolName, args });

  const tool = toolMap.get(toolName);
  if (!tool) {
    const result = applyToolResultBudget(
      {
        toolCallId,
        toolName,
        success: false,
        content: '',
        error: `Unknown tool: ${toolName}`,
      },
      config.toolResultBudget,
    );
    await emit(config.emit, { type: 'tool_execution_end', result });
    return result;
  }

  try {
    const before = await config.beforeToolCall?.({ toolCall, tool, args, messages }, config.signal);
    if (config.signal?.aborted) {
      const result = applyToolResultBudget(createAbortedToolResult(toolCall), config.toolResultBudget);
      await emit(config.emit, { type: 'tool_execution_end', result });
      return result;
    }
    if (before?.block) {
      const result = applyToolResultBudget(
        createBlockedToolResult(toolCall, before.reason),
        config.toolResultBudget,
      );
      await emit(config.emit, { type: 'tool_execution_end', result });
      return result;
    }

    const output = await tool.execute(args, {
      ...before?.toolExecutionContext,
      toolCallId,
      signal: config.signal,
    });
    let result: ToolExecutionResult = {
      toolCallId,
      toolName,
      success: output.success,
      content: output.content,
      error: output.error,
      details: output.details,
    };

    if (!config.signal?.aborted) {
      const after = await config.afterToolCall?.({ toolCall, tool, args, result, messages }, config.signal);
      if (after) result = { ...result, ...after };
    }
    result = applyToolResultBudget(result, config.toolResultBudget);

    await emit(config.emit, { type: 'tool_execution_end', result });
    return result;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (config.signal?.aborted) {
      const result = applyToolResultBudget(createAbortedToolResult(toolCall), config.toolResultBudget);
      await emit(config.emit, { type: 'tool_execution_end', result });
      return result;
    }
    const result = applyToolResultBudget(
      {
        toolCallId,
        toolName,
        success: false,
        content: '',
        error: `Tool execution failed: ${err.message}\n\nStack:\n${err.stack ?? ''}`,
      },
      config.toolResultBudget,
    );
    await emit(config.emit, { type: 'tool_execution_end', result });
    return result;
  }
}

function canRunToolCallInParallel(toolCall: ToolCall, toolMap: Map<string, Tool>): boolean {
  const tool = toolMap.get(toolCall.function.name);
  const metadata = tool?.metadata;
  if (!metadata) return false;

  return metadata.category === 'read'
    && metadata.riskLevel !== 'high'
    && metadata.isReadOnly
    && metadata.isConcurrencySafe;
}

function createToolExecutionBatches(
  toolCalls: ToolCall[],
  toolMap: Map<string, Tool>,
  mode?: ToolExecutionMode,
): ToolExecutionBatch[] {
  if (mode === 'sequential') {
    return [{ mode: 'sequential', toolCalls }];
  }

  const batches: ToolExecutionBatch[] = [];
  let parallelBatch: ToolCall[] = [];

  const flushParallelBatch = () => {
    if (parallelBatch.length === 0) return;
    batches.push({ mode: 'parallel', toolCalls: parallelBatch });
    parallelBatch = [];
  };

  for (const toolCall of toolCalls) {
    if (canRunToolCallInParallel(toolCall, toolMap)) {
      parallelBatch.push(toolCall);
      continue;
    }

    flushParallelBatch();
    batches.push({ mode: 'sequential', toolCalls: [toolCall] });
  }

  flushParallelBatch();
  return batches;
}

async function executeToolCalls(
  toolCalls: ToolCall[],
  toolMap: Map<string, Tool>,
  messages: AgentMessage[],
  config: AgentLoopConfig,
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];
  const batches = createToolExecutionBatches(toolCalls, toolMap, config.toolExecution);

  for (const batch of batches) {
    if (config.signal?.aborted) break;

    if (batch.mode === 'parallel') {
      results.push(...(await Promise.all(
        batch.toolCalls.map((toolCall) => executeToolCall(toolCall, toolMap, messages, config)),
      )));
      if (config.signal?.aborted) break;
      continue;
    }

    for (const toolCall of batch.toolCalls) {
      if (config.signal?.aborted) break;
      results.push(await executeToolCall(toolCall, toolMap, messages, config));
      if (config.signal?.aborted) break;
    }
  }

  return results;
}

async function appendInputMessages(
  messages: AgentMessage[],
  pendingMessages: AgentMessage[],
  eventSink?: AgentLoopEventSink,
): Promise<void> {
  for (const message of pendingMessages) {
    messages.push(message);
    await emit(eventSink, { type: 'input_message', message });
  }
}

function abortResult(messages: AgentMessage[], finalContent: string, apiTotalTokens: number): AgentLoopResult {
  return { messages, finalContent, apiTotalTokens };
}

function getSystemPromptForContext(config: AgentLoopConfig, messages: AgentMessage[]): string {
  if (config.systemPrompt !== undefined) return config.systemPrompt;
  const systemMessage = messages.find((message) => isLlmMessage(message) && message.role === 'system');
  return systemMessage?.content ?? '';
}

function hasStepLimit(maxSteps: number | null | undefined): maxSteps is number {
  return typeof maxSteps === 'number' && Number.isFinite(maxSteps) && maxSteps > 0;
}

function createResourceContextMarker(providerRequestView: ProviderRequestView): AgentMessage {
  const { summary } = providerRequestView;
  return createInternalAgentMessage({
    kind: 'resource_context',
    metadata: {
      injected: summary.injected,
      resources: summary.projectContextNames,
      providerRequestMessageCount: summary.providerRequestMessageCount,
      providerRequestTokens: summary.providerRequestTokenEstimate.tokens,
      projectContextTokens: summary.projectContextTokenEstimate.tokens,
      projectContextBudgetMode: summary.projectContextBudgetMode,
      projectContextTruncated: summary.projectContextTruncated,
      projectContextSkippedReason: summary.projectContextSkippedReason,
      skillsMetadataInjected: summary.skillsMetadataInjected,
      skillNames: summary.skillNames,
      skillInvocationInjected: summary.skillInvocationInjected,
      invokedSkillNames: summary.invokedSkillNames,
    },
  });
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
        const transformedMessages = await (config.transformContext ?? defaultTransformContext)(
          messages,
          config.signal,
        );
        const llmMessages = await (config.convertToLlm ?? defaultConvertToLlm)(transformedMessages);
        let requestMessages: LlmMessage[];
        if (config.contextBuilder) {
          const providerRequestView = config.contextBuilder.build({
            systemPrompt: getSystemPromptForContext(config, transformedMessages),
            llmMessages,
          });
          requestMessages = providerRequestView.messages;
          messages.push(createResourceContextMarker(providerRequestView));
        } else {
          requestMessages = llmMessages;
        }
        response = await generateResponseWithStreaming({
          llmClient: config.llmClient,
          messages: requestMessages,
          tools: config.tools,
          emit: config.emit,
        });
      } catch (e) {
        let message: string;
        let rawError: string;
        if (e instanceof RetryExhaustedError) {
          const formatted = formatProviderError(e.lastException);
          message = `LLM call failed after ${e.attempts} retries: ${formatted.message}`;
          rawError = formatted.raw;
        } else {
          const formatted = formatProviderError(e);
          message = `LLM call failed: ${formatted.message}`;
          rawError = formatted.raw;
        }
        await emit(config.emit, { type: 'error', message, error: rawError });
        await emit(config.emit, { type: 'agent_end', messages, finalContent: message });
        return { messages, finalContent: message, apiTotalTokens };
      }

      if (response.usage) apiTotalTokens += response.usage.total_tokens;
      finalContent = response.content;

      const assistantMessage = {
        role: 'assistant',
        content: response.content,
        thinking: response.thinking,
        tool_calls: response.tool_calls,
      } satisfies Extract<AgentMessage, { role: 'assistant' }>;
      messages.push(assistantMessage);
      await emit(config.emit, { type: 'assistant_message', message: assistantMessage });

      const toolResults: ToolExecutionResult[] = [];
      if (response.tool_calls?.length) {
        toolResults.push(...(await executeToolCalls(response.tool_calls, toolMap, messages, config)));
        for (const result of toolResults) {
          await emit(config.emit, { type: 'tool_result', result });
          messages.push({
            role: 'tool',
            content: formatToolResultMessageContent(result),
            tool_call_id: result.toolCallId,
            name: result.toolName,
          });
        }
        if (config.signal?.aborted) {
          const message = 'Task cancelled by user.';
          await emit(config.emit, { type: 'error', message });
          await emit(config.emit, { type: 'agent_end', messages, finalContent: message });
          return abortResult(messages, message, apiTotalTokens);
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
