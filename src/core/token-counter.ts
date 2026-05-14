import type { LLMClient } from '../llm/llm-client.js';
import { LLMProvider } from '../schema.js';
import type { LlmMessage } from '../schema.js';
import type { Tool } from '../tools/base.js';
import { estimateMessagesTokens } from './token-estimator.js';

export type TokenCountSource = 'provider' | 'local';
export type TokenCountMethod = 'anthropic_count_tokens' | 'google_count_tokens' | 'gpt-tokenizer';

export interface TokenCountResult {
  tokens: number;
  source: TokenCountSource;
  method: TokenCountMethod;
}

export interface TokenCounter {
  countMessages(input: {
    messages: LlmMessage[];
    tools?: Tool[] | null;
  }): Promise<TokenCountResult>;
}

export function createTokenCounter({
  llmClient,
  tools,
}: {
  llmClient: LLMClient;
  tools?: Tool[] | null;
}): TokenCounter {
  return {
    async countMessages({ messages, tools: inputTools }): Promise<TokenCountResult> {
      const providerTokens = await llmClient.countTokens(messages, inputTools ?? tools ?? null);
      if (providerTokens !== null) {
        return {
          tokens: providerTokens,
          source: 'provider',
          method: getProviderCountMethod(llmClient.provider),
        };
      }
      return countMessagesLocally(messages);
    },
  };
}

function getProviderCountMethod(provider: LLMProvider | undefined): TokenCountMethod {
  if (provider === LLMProvider.GOOGLE) return 'google_count_tokens';
  return 'anthropic_count_tokens';
}

export function countMessagesLocally(messages: LlmMessage[]): TokenCountResult {
  const estimate = estimateMessagesTokens(messages);
  return {
    tokens: estimate.tokens,
    source: 'local',
    method: estimate.method,
  };
}
