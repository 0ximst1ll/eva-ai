import { encode } from 'gpt-tokenizer';
import type { LlmMessage } from '../schema.js';

export const TOKEN_ESTIMATE_METHOD = 'gpt-tokenizer';

export interface TokenEstimate {
  tokens: number;
  method: typeof TOKEN_ESTIMATE_METHOD;
}

export function estimateTextTokens(text: string): TokenEstimate {
  return {
    tokens: encode(text).length,
    method: TOKEN_ESTIMATE_METHOD,
  };
}

export function estimateMessageTokens(message: LlmMessage): TokenEstimate {
  const parts = [message.role, message.content];
  if (message.role === 'assistant') {
    if (message.thinking) parts.push(message.thinking);
    if (message.tool_calls?.length) parts.push(JSON.stringify(message.tool_calls));
  }
  if (message.role === 'tool') {
    if (message.name) parts.push(message.name);
    parts.push(message.tool_call_id);
  }
  return estimateTextTokens(parts.join('\n'));
}

export function estimateMessagesTokens(messages: LlmMessage[]): TokenEstimate {
  let tokens = 0;
  for (const message of messages) {
    tokens += estimateMessageTokens(message).tokens;
  }
  return {
    tokens,
    method: TOKEN_ESTIMATE_METHOD,
  };
}
