import type { LLMResponse, Message, ToolCall } from '../schema.js';

export interface CompactionResult {
  summary: string;
  firstKeptMessageIndex: number;
  messagesBefore: number;
  messagesAfter: number;
}

export interface BuildCompactionMessagesOptions {
  messages: Message[];
  customInstructions?: string;
  fileOperations?: CompactionFileOperations;
}

export interface CompactionFileOperations {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface PrepareCompactionInputOptions {
  messages: Message[];
  keepRecentMessages: number;
}

export interface PreparedCompactionInput {
  messages: Message[];
  firstKeptMessageIndex: number;
  fileOperations: CompactionFileOperations;
}

const TOOL_RESULT_COMPACTION_MAX_CHARS = 4000;

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
  fileOperations,
}: BuildCompactionMessagesOptions): Message[] {
  const extraInstructions = customInstructions?.trim()
    ? `\n\nAdditional user instructions for this summary:\n${customInstructions.trim()}`
    : '';
  const fileOperationsBlock = formatFileOperations(fileOperations);

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
        fileOperationsBlock,
      ].join('\n'),
    },
  ];
}

export function prepareCompactionInput({
  messages,
  keepRecentMessages,
}: PrepareCompactionInputOptions): PreparedCompactionInput {
  const firstKeptMessageIndex = chooseFirstKeptMessageIndex(messages, keepRecentMessages);
  const messagesToSummarize = firstKeptMessageIndex > 1
    ? messages.slice(0, firstKeptMessageIndex)
    : messages;
  return {
    messages: normalizeMessagesForCompaction(messagesToSummarize),
    firstKeptMessageIndex,
    fileOperations: extractFileOperations(messagesToSummarize),
  };
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

function normalizeMessagesForCompaction(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'tool') return { ...message } as Message;
    return {
      ...message,
      content: normalizeToolResultContent(message),
    };
  });
}

function normalizeToolResultContent(message: Extract<Message, { role: 'tool' }>): string {
  const content = message.content;
  if (content.length <= TOOL_RESULT_COMPACTION_MAX_CHARS) return content;

  const header = [
    `[Tool result normalized for compaction: original=${content.length} chars, kept=${TOOL_RESULT_COMPACTION_MAX_CHARS} chars]`,
    '',
  ].join('\n');
  const budget = Math.max(0, TOOL_RESULT_COMPACTION_MAX_CHARS - header.length);
  const toolName = message.name ?? '';
  if (toolName === 'bash' || toolName === 'bash_output') {
    return `${header}${takeTailAtLineBoundary(content, budget)}`;
  }
  return `${takeHeadAtLineBoundary(content, budget)}\n\n${header.trim()}`;
}

function takeHeadAtLineBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let head = text.slice(0, maxChars);
  const lastNewline = head.lastIndexOf('\n');
  if (lastNewline > 0) head = head.slice(0, lastNewline);
  return head;
}

function takeTailAtLineBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let tail = text.slice(-maxChars);
  const firstNewline = tail.indexOf('\n');
  if (firstNewline > 0) tail = tail.slice(firstNewline + 1);
  return tail;
}

function extractFileOperations(messages: Message[]): CompactionFileOperations {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const toolCall of message.tool_calls ?? []) {
      collectFileOperation(toolCall, readFiles, modifiedFiles);
    }
  }
  return {
    readFiles: [...readFiles].sort(),
    modifiedFiles: [...modifiedFiles].sort(),
  };
}

function collectFileOperation(
  toolCall: ToolCall,
  readFiles: Set<string>,
  modifiedFiles: Set<string>,
): void {
  const path = readStringArgument(toolCall.function.arguments, 'path');
  if (!path) return;
  if (toolCall.function.name === 'read_file') {
    readFiles.add(path);
    return;
  }
  if (toolCall.function.name === 'write_file' || toolCall.function.name === 'edit_file') {
    modifiedFiles.add(path);
  }
}

function readStringArgument(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function formatFileOperations(fileOperations: CompactionFileOperations | undefined): string {
  if (!fileOperations) return '';
  const parts: string[] = [];
  if (fileOperations.readFiles.length) {
    parts.push(['Read files:', ...fileOperations.readFiles.map((file) => `- ${file}`)].join('\n'));
  }
  if (fileOperations.modifiedFiles.length) {
    parts.push(['Modified files:', ...fileOperations.modifiedFiles.map((file) => `- ${file}`)].join('\n'));
  }
  return parts.length ? `\n\n<file_operations>\n${parts.join('\n\n')}\n</file_operations>` : '';
}
