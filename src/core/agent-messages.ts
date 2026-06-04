import type { AgentMessage, InternalAgentMessage, LlmMessage } from '../schema.js';

export type TransformContext = (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

export type ConvertToLlm = (
  messages: AgentMessage[],
) => LlmMessage[] | Promise<LlmMessage[]>;

export function defaultTransformContext(messages: AgentMessage[]): AgentMessage[] {
  return messages.slice();
}

export function defaultConvertToLlm(messages: AgentMessage[]): LlmMessage[] {
  return messages.filter(isLlmMessage).map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.tool_call_id,
        name: message.name,
      };
    }
    return { ...message };
  });
}

export function isLlmMessage(message: AgentMessage): message is LlmMessage {
  if (!message || typeof message !== 'object') return false;
  const role = (message as { role?: unknown }).role;
  return role === 'system' || role === 'user' || role === 'assistant' || role === 'tool';
}

export function createInternalAgentMessage({
  kind,
  content,
  metadata,
}: {
  kind: string;
  content?: string;
  metadata?: Record<string, unknown>;
}): InternalAgentMessage {
  return {
    role: 'internal',
    kind,
    content,
    metadata,
  };
}

export function isInternalAgentMessage(message: AgentMessage): message is InternalAgentMessage {
  return !!message && typeof message === 'object' && (message as { role?: unknown }).role === 'internal';
}
