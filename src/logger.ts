// Agent run logger — mirrors mini_agent/logger.py

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Message, ToolCall } from './schema.js';

export class AgentLogger {
  private readonly logDir: string;
  private logFile: string | null = null;
  private logIndex = 0;

  constructor() {
    this.logDir = path.join(os.homedir(), '.mini-agent', 'log');
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  startNewRun(): void {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, (c) => (c === 'T' ? '_' : c))
      .slice(0, 15);
    this.logFile = path.join(this.logDir, `agent_run_${timestamp}.log`);
    this.logIndex = 0;

    fs.writeFileSync(
      this.logFile,
      '='.repeat(80) + '\n' +
      `Agent Run Log - ${new Date().toLocaleString()}\n` +
      '='.repeat(80) + '\n\n',
      'utf-8',
    );
  }

  getLogFilePath(): string | null {
    return this.logFile;
  }

  logRequest(messages: Message[], tools?: { name: string }[]): void {
    this.logIndex++;

    // Convert discriminated union messages to plain objects for JSON serialization.
    // Python uses Pydantic's .model_dump(); here we spread and conditionally add fields.
    const msgList = messages.map((msg) => {
      const base: Record<string, unknown> = { role: msg.role, content: msg.content };
      if (msg.role === 'assistant') {
        if (msg.thinking) base['thinking'] = msg.thinking;
        if (msg.tool_calls) base['tool_calls'] = msg.tool_calls;
      }
      if (msg.role === 'tool') {
        base['tool_call_id'] = msg.tool_call_id;
        if (msg.name) base['name'] = msg.name;
      }
      return base;
    });

    const data = {
      messages: msgList,
      tools: tools ? tools.map((t) => t.name) : [],
    };

    this._writeLog('REQUEST', 'LLM Request:\n\n' + JSON.stringify(data, null, 2));
  }

  logResponse(
    content: string,
    thinking?: string,
    toolCalls?: ToolCall[],
    finishReason?: string,
  ): void {
    this.logIndex++;

    const data: Record<string, unknown> = { content };
    if (thinking) data['thinking'] = thinking;
    if (toolCalls) data['tool_calls'] = toolCalls;
    if (finishReason) data['finish_reason'] = finishReason;

    this._writeLog('RESPONSE', 'LLM Response:\n\n' + JSON.stringify(data, null, 2));
  }

  logToolResult(
    toolName: string,
    args: Record<string, unknown>,
    success: boolean,
    content?: string,
    error?: string,
  ): void {
    this.logIndex++;

    const data: Record<string, unknown> = { tool_name: toolName, arguments: args, success };
    if (success) data['result'] = content;
    else data['error'] = error;

    this._writeLog('TOOL_RESULT', 'Tool Execution:\n\n' + JSON.stringify(data, null, 2));
  }

  private _writeLog(logType: string, content: string): void {
    if (!this.logFile) return;

    const entry =
      '\n' + '-'.repeat(80) + '\n' +
      `[${this.logIndex}] ${logType}\n` +
      `Timestamp: ${new Date().toISOString()}\n` +
      '-'.repeat(80) + '\n' +
      content + '\n';

    fs.appendFileSync(this.logFile, entry, 'utf-8');
  }
}
