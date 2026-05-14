import type { AgentMessage, LlmMessage } from '../schema.js';

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
  return messages.filter(isLlmMessage).map((message) => ({ ...message }));
}

export function isLlmMessage(message: AgentMessage): message is LlmMessage {
  if (!message || typeof message !== 'object') return false;
  const role = (message as { role?: unknown }).role;
  return role === 'system' || role === 'user' || role === 'assistant' || role === 'tool';
}
