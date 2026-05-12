import type { LLMResponse, Message } from '../schema.js';

export interface CompactionResult {
  summary: string;
  firstKeptMessageIndex: number;
  messagesBefore: number;
  messagesAfter: number;
}

export interface BuildCompactionMessagesOptions {
  messages: Message[];
  customInstructions?: string;
}

const SUMMARY_HEADER = [
  '<conversation_summary>',
  'The previous conversation was compacted. Use this summary as context for continuing the task.',
  '',
  '',
].join('\n');

export function createCompactionSummaryMessage(summary: string): Message {
  return {
    role: 'user',
    content: `${SUMMARY_HEADER}${summary.trim()}\n</conversation_summary>`,
  };
}

export function isCompactionSummaryMessage(message: Message): boolean {
  return message.role === 'user'
    && message.content.startsWith(SUMMARY_HEADER)
    && message.content.trimEnd().endsWith('</conversation_summary>');
}

export function buildCompactionMessages({
  messages,
  customInstructions,
}: BuildCompactionMessagesOptions): Message[] {
  const extraInstructions = customInstructions?.trim()
    ? `\n\nAdditional user instructions for this summary:\n${customInstructions.trim()}`
    : '';

  return [
    {
      role: 'system',
      content: [
        'You summarize coding assistant sessions for future continuation.',
        'Preserve concrete user goals, decisions, files changed, commands run, errors, unresolved tasks, and next steps.',
        'Do not invent details. Keep the summary concise but operational.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Summarize this conversation so the assistant can continue from the compacted context.',
        extraInstructions,
        '',
        '<transcript>',
        serializeMessages(messages),
        '</transcript>',
      ].join('\n'),
    },
  ];
}

export function extractCompactionSummary(response: LLMResponse): string {
  const summary = response.content.trim();
  if (!summary) {
    throw new Error('Compaction summary is empty');
  }
  return summary;
}

export function rebuildCompactedMessages({
  messages,
  summary,
  firstKeptMessageIndex,
}: {
  messages: Message[];
  summary: string;
  firstKeptMessageIndex: number;
}): Message[] {
  const systemMessage = messages.find((message) => message.role === 'system');
  const rebuilt: Message[] = systemMessage ? [{ ...systemMessage }] : [];
  rebuilt.push(createCompactionSummaryMessage(summary));
  rebuilt.push(...messages.slice(firstKeptMessageIndex).map((message) => ({ ...message }) as Message));
  return rebuilt;
}

export function chooseFirstKeptMessageIndex(messages: Message[], keepRecentMessages: number): number {
  if (messages.length <= 1) return messages.length;

  const targetIndex = Math.max(1, messages.length - Math.max(0, keepRecentMessages));
  const userBoundary = messages.findIndex((message, index) => index >= targetIndex && message.role === 'user');
  if (userBoundary >= 0) return userBoundary;

  const nonToolBoundary = messages.findIndex((message, index) => index >= targetIndex && message.role !== 'tool');
  if (nonToolBoundary >= 0) return nonToolBoundary;

  return messages.length;
}

function serializeMessages(messages: Message[]): string {
  return messages
    .map((message, index) => {
      if (message.role === 'assistant') {
        const toolCalls = message.tool_calls?.length
          ? `\nTool calls: ${message.tool_calls.map((toolCall) => toolCall.function.name).join(', ')}`
          : '';
        const thinking = message.thinking ? `\nThinking: ${message.thinking}` : '';
        return `#${index} assistant:\n${message.content}${thinking}${toolCalls}`;
      }
      if (message.role === 'tool') {
        return `#${index} tool ${message.name ?? message.tool_call_id}:\n${message.content}`;
      }
      return `#${index} ${message.role}:\n${message.content}`;
    })
    .join('\n\n');
}
