// Shell command execution tool — mirrors eva_ai/tools/bash_tool.py
// Python uses asyncio.create_subprocess_*; TypeScript uses Node.js child_process.

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAbortedToolResult, isToolExecutionAborted, type Tool, type ToolExecutionContext, type ToolResult, type ToolResultDetails } from './base.js';
import {
  DEFAULT_TOOL_OUTPUT_MAX_CHARS,
  truncateTailByChars,
  type ToolOutputTruncationDetails,
} from './truncate.js';

const MAX_INLINE_OUTPUT_CHARS = DEFAULT_TOOL_OUTPUT_MAX_CHARS;
type BashShellStatus = 'running' | 'completed' | 'failed' | 'terminated' | 'error';

export interface BashOutputResult extends ToolResult<BashToolDetails> {
  stdout: string;
  stderr: string;
  exitCode: number;
  bashId?: string;
  fullOutputPath?: string;
}

export interface BashToolDetails extends ToolResultDetails {
  exitCode: number;
  stdoutChars?: number;
  stderrChars?: number;
  fullOutputPath?: string;
  truncation?: ToolOutputTruncationDetails;
  bashId?: string;
  status?: BashShellStatus;
  outputLines?: number;
}

export interface BashExecOptions {
  signal?: AbortSignal;
  timeoutSecs: number;
}

export interface BashSpawnOptions {
  cwd?: string;
  isWindows: boolean;
}

export interface BashOperations {
  exec?: (command: string, cwd: string | undefined, isWindows: boolean, options: BashExecOptions) => Promise<BashOutputResult>;
  spawn?: (command: string, options: BashSpawnOptions) => cp.ChildProcess;
}

function abortedBashResult(): BashOutputResult {
  const result = createAbortedToolResult<BashToolDetails>();
  return {
    success: result.success,
    content: result.content,
    error: result.error,
    stdout: '',
    stderr: result.error ?? '',
    exitCode: -1,
  };
}

function ensureLogDir(): string {
  const base = path.join(os.tmpdir(), 'eva-ai-bash-logs');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function writeFullOutput(command: string, stdout: string, stderr: string): string | undefined {
  try {
    const filePath = path.join(ensureLogDir(), `${Date.now()}-${randomUUID().slice(0, 8)}.log`);
    fs.writeFileSync(filePath, `$ ${command}\n\n[stdout]\n${stdout}\n\n[stderr]\n${stderr}\n`, 'utf-8');
    return filePath;
  } catch {
    return undefined;
  }
}

function truncateOutput(content: string, fullOutputPath?: string): {
  content: string;
  truncation?: ToolOutputTruncationDetails;
} {
  if (content.length <= MAX_INLINE_OUTPUT_CHARS) return { content: content || '(no output)' };
  const truncated = truncateTailByChars(
    content,
    MAX_INLINE_OUTPUT_CHARS,
    `[Showing last output. Output truncated: original=${content.length} chars; full output: ${fullOutputPath ?? 'unavailable'}]`,
  );
  return {
    content: truncated.content,
    truncation: fullOutputPath && truncated.truncation
      ? { ...truncated.truncation, fullOutputPath }
      : truncated.truncation,
  };
}

function createBashDetails({
  exitCode,
  stdout,
  stderr,
  fullOutputPath,
  truncation,
}: {
  exitCode: number;
  stdout: string;
  stderr: string;
  fullOutputPath?: string;
  truncation?: ToolOutputTruncationDetails;
}): BashToolDetails {
  return {
    exitCode,
    stdoutChars: stdout.length,
    stderrChars: stderr.length,
    fullOutputPath,
    truncation,
  };
}

function renderBashResult(result: ToolResult<BashToolDetails>): string | undefined {
  const details = result.details;
  if (!details) return undefined;
  const parts: string[] = [];
  if (details.bashId) parts.push(`bash_id=${details.bashId}`);
  if (details.status) parts.push(`status=${details.status}`);
  if (typeof details.exitCode === 'number') parts.push(`exit=${details.exitCode}`);
  if (typeof details.outputLines === 'number') parts.push(`${details.outputLines} new lines`);
  if (typeof details.stdoutChars === 'number') parts.push(`stdout=${details.stdoutChars} chars`);
  if (typeof details.stderrChars === 'number' && details.stderrChars > 0) {
    parts.push(`stderr=${details.stderrChars} chars`);
  }
  if (details.truncation?.truncated) {
    parts.push(`truncated ${details.truncation.shownChars}/${details.truncation.originalChars} chars`);
  }
  if (details.fullOutputPath) parts.push(`full output: ${details.fullOutputPath}`);
  return parts.length ? parts.join('; ') : undefined;
}

function killProcessTree(proc: cp.ChildProcess, isWindows: boolean): void {
  if (!proc.pid) return;
  try {
    if (isWindows) {
      cp.spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
    setTimeout(() => {
      try {
        process.kill(-proc.pid!, 'SIGKILL');
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Process already exited.
        }
      }
    }, 5000).unref();
  } catch {
    // Best effort termination only.
  }
}

class BackgroundShell {
  readonly bashId: string;
  readonly command: string;
  readonly startTime: number;
  private readonly process: cp.ChildProcess;
  private readonly isWindows: boolean;
  private readonly outputLines: string[] = [];
  private lastReadIndex = 0;
  status: BashShellStatus = 'running';
  exitCode: number | null = null;

  constructor(bashId: string, command: string, process: cp.ChildProcess, isWindows: boolean) {
    this.bashId = bashId;
    this.command = command;
    this.startTime = Date.now();
    this.process = process;
    this.isWindows = isWindows;
  }

  addOutput(line: string): void {
    this.outputLines.push(line);
  }

  getNewOutput(filterPattern?: string): string[] {
    const newLines = this.outputLines.slice(this.lastReadIndex);
    this.lastReadIndex = this.outputLines.length;

    if (!filterPattern) return newLines;
    try {
      const re = new RegExp(filterPattern);
      return newLines.filter((l) => re.test(l));
    } catch {
      return newLines;
    }
  }

  updateStatus(isAlive: boolean, exitCode?: number): void {
    if (!isAlive) {
      this.exitCode = exitCode ?? null;
      this.status = exitCode === 0 ? 'completed' : 'failed';
    }
  }

  terminate(): Promise<void> {
    return new Promise((resolve) => {
      if (this.process.exitCode !== null) {
        this.status = 'terminated';
        resolve();
        return;
      }
      this.process.once('exit', () => {
        this.status = 'terminated';
        this.exitCode = this.process.exitCode;
        resolve();
      });
      killProcessTree(this.process, this.isWindows);
    });
  }
}

const _shells = new Map<string, BackgroundShell>();

function addShell(shell: BackgroundShell): void {
  _shells.set(shell.bashId, shell);
}

function getShell(bashId: string): BackgroundShell | undefined {
  return _shells.get(bashId);
}

function getAvailableIds(): string[] {
  return [..._shells.keys()];
}

function removeShell(bashId: string): void {
  _shells.delete(bashId);
}

function startMonitor(shell: BackgroundShell): void {
  const proc = shell['process'] as cp.ChildProcess;
  proc.stdout?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString('utf-8').split('\n');
    for (const line of lines) if (line) shell.addOutput(line);
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString('utf-8').split('\n');
    for (const line of lines) if (line) shell.addOutput(`[stderr] ${line}`);
  });
  proc.once('exit', (code) => {
    shell.updateStatus(false, code ?? undefined);
  });
}

async function terminateShell(bashId: string): Promise<BackgroundShell> {
  const shell = getShell(bashId);
  if (!shell) throw new Error(`Shell not found: ${bashId}`);
  await shell.terminate();
  removeShell(bashId);
  return shell;
}

interface BashInput extends Record<string, unknown> {
  command: string;
  timeout?: number;
  run_in_background?: boolean;
}

export class BashTool implements Tool<BashInput, BashToolDetails> {
  private readonly isWindows: boolean;

  constructor(
    private readonly workspaceDir?: string,
    private readonly operations: BashOperations = {},
  ) {
    this.isWindows = os.platform() === 'win32';
  }

  readonly name = 'bash';

  get description(): string {
    return `Execute ${this.isWindows ? 'PowerShell' : 'bash'} commands in foreground or background.

For terminal operations like git, npm, docker, etc. DO NOT use for file operations - use specialized tools.

Parameters:
  - command (required): command to execute
  - timeout (optional): Timeout in seconds (default: 120, max: 600) for foreground commands
  - run_in_background (optional): Set true for long-running commands (servers, etc.)

For background commands, monitor with bash_output and terminate with bash_kill.`;
  }

  readonly parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      timeout: {
        type: 'integer',
        description: 'Optional: Timeout in seconds (default: 120, max: 600). Only applies to foreground commands.',
        default: 120,
      },
      run_in_background: {
        type: 'boolean',
        description: 'Optional: Set to true to run the command in the background.',
        default: false,
      },
    },
    required: ['command'],
  };

  renderResult = renderBashResult;

  async execute(
    { command, timeout = 120, run_in_background = false }: BashInput,
    context?: ToolExecutionContext,
  ): Promise<BashOutputResult> {
    try {
      if (isToolExecutionAborted(context)) return abortedBashResult();
      const effectiveTimeout = Math.min(Math.max(timeout, 1), 600);
      if (run_in_background) return this._runBackground(command);
      return this._runForeground(command, effectiveTimeout, context?.signal);
    } catch (err) {
      return {
        success: false,
        content: '',
        error: String(err),
        stdout: '',
        stderr: String(err),
        exitCode: -1,
      };
    }
  }

  private _spawn(command: string): cp.ChildProcess {
    if (this.operations.spawn) {
      return this.operations.spawn(command, { cwd: this.workspaceDir, isWindows: this.isWindows });
    }
    return this.isWindows
      ? cp.spawn('powershell.exe', ['-NoProfile', '-Command', command], {
          cwd: this.workspaceDir,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : cp.spawn('bash', ['-c', command], {
          cwd: this.workspaceDir,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
  }

  private _runBackground(command: string): BashOutputResult {
    const bashId = randomUUID().slice(0, 8);
    const proc = this._spawn(command);
    const shell = new BackgroundShell(bashId, command, proc, this.isWindows);
    addShell(shell);
    startMonitor(shell);

    const formatted = `Command started in background. Use bash_output to monitor (bash_id='${bashId}').\n\nCommand: ${command}\nBash ID: ${bashId}`;
    return {
      success: true,
      content: formatted,
      stdout: `Background command started with ID: ${bashId}`,
      stderr: '',
      exitCode: 0,
      bashId,
    };
  }

  private _runForeground(command: string, timeoutSecs: number, signal?: AbortSignal): Promise<BashOutputResult> {
    if (this.operations.exec) {
      return this.operations.exec(command, this.workspaceDir, this.isWindows, { signal, timeoutSecs });
    }

    return new Promise((resolve) => {
      const proc = this._spawn(command);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const finish = (result: BashOutputResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(proc, this.isWindows);
      }, timeoutSecs * 1000);

      const onAbort = () => {
        aborted = true;
        killProcessTree(proc, this.isWindows);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });

      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });

      proc.once('close', (code) => {
        const rawOutput = formatBashOutput(stdout, stderr, code ?? 0);
        const shouldWriteFullOutput = rawOutput.length > MAX_INLINE_OUTPUT_CHARS || aborted || timedOut;
        const fullOutputPath = shouldWriteFullOutput ? writeFullOutput(command, stdout, stderr) : undefined;
        if (aborted) {
          const content = `Command aborted. Full output: ${fullOutputPath ?? 'unavailable'}`;
          finish({
            success: false,
            content,
            error: 'Command aborted',
            stdout,
            stderr,
            exitCode: -1,
            fullOutputPath,
            details: createBashDetails({ exitCode: -1, stdout, stderr, fullOutputPath }),
          });
          return;
        }
        if (timedOut) {
          const content = `Command timed out after ${timeoutSecs} seconds. Full output: ${fullOutputPath ?? 'unavailable'}`;
          finish({
            success: false,
            content,
            error: `Command timed out after ${timeoutSecs} seconds`,
            stdout,
            stderr,
            exitCode: -1,
            fullOutputPath,
            details: createBashDetails({ exitCode: -1, stdout, stderr, fullOutputPath }),
          });
          return;
        }

        const exitCode = code ?? 0;
        const success = exitCode === 0;
        let error: string | undefined;
        if (!success) {
          error = `Command failed with exit code ${exitCode}`;
          if (stderr.trim()) error += `\n${stderr.trim()}`;
        }

        const output = truncateOutput(rawOutput, fullOutputPath);
        finish({
          success,
          content: output.content,
          error,
          stdout,
          stderr,
          exitCode,
          fullOutputPath,
          details: createBashDetails({
            exitCode,
            stdout,
            stderr,
            fullOutputPath,
            truncation: output.truncation,
          }),
        });
      });

      proc.once('error', (err) => {
        finish({
          success: false,
          content: '',
          error: err.message,
          stdout: '',
          stderr: err.message,
          exitCode: -1,
        });
      });
    });
  }
}

function formatBashOutput(stdout: string, stderr: string, exitCode: number): string {
  let rawContent = stdout;
  if (stderr) rawContent += `\n[stderr]:\n${stderr}`;
  if (exitCode) rawContent += `\n[exit_code]:\n${exitCode}`;
  return rawContent;
}

interface BashOutputInput extends Record<string, unknown> {
  bash_id: string;
  filter_str?: string;
}

export class BashOutputTool implements Tool<BashOutputInput, BashToolDetails> {
  readonly name = 'bash_output';
  readonly description = 'Retrieves output from a running or completed background bash shell by bash_id.';
  readonly parameters = {
    type: 'object',
    properties: {
      bash_id: { type: 'string', description: 'The ID of the background shell to retrieve output from.' },
      filter_str: { type: 'string', description: 'Optional regular expression to filter the output lines.' },
    },
    required: ['bash_id'],
  };

  renderResult = renderBashResult;

  async execute({ bash_id, filter_str }: BashOutputInput, context?: ToolExecutionContext): Promise<BashOutputResult> {
    if (isToolExecutionAborted(context)) return abortedBashResult();
    const shell = getShell(bash_id);
    if (!shell) {
      const available = getAvailableIds();
      return {
        success: false,
        content: '',
        error: `Shell not found: ${bash_id}. Available: ${available.length ? available.join(', ') : 'none'}`,
        stdout: '',
        stderr: '',
        exitCode: -1,
      };
    }

    const newLines = shell.getNewOutput(filter_str);
    const stdout = newLines.join('\n');
    const output = truncateOutput(stdout);
    let content = output.content;
    content += `\n[status]:\n${shell.status}`;
    content += `\n[bash_id]:\n${shell.bashId}`;

    return {
      success: true,
      content: content || '(no output)',
      stdout,
      stderr: '',
      exitCode: shell.exitCode ?? 0,
      bashId: bash_id,
      details: {
        bashId: bash_id,
        status: shell.status,
        exitCode: shell.exitCode ?? 0,
        outputLines: newLines.length,
        truncation: output.truncation,
      },
    };
  }
}

interface BashKillInput extends Record<string, unknown> {
  bash_id: string;
}

export class BashKillTool implements Tool<BashKillInput, BashToolDetails> {
  readonly name = 'bash_kill';
  readonly description = 'Kills a running background bash shell by its ID.';
  readonly parameters = {
    type: 'object',
    properties: {
      bash_id: { type: 'string', description: 'The ID of the background shell to terminate.' },
    },
    required: ['bash_id'],
  };

  renderResult = renderBashResult;

  async execute({ bash_id }: BashKillInput, context?: ToolExecutionContext): Promise<BashOutputResult> {
    try {
      if (isToolExecutionAborted(context)) return abortedBashResult();
      const shell = getShell(bash_id);
      const remaining = shell ? shell.getNewOutput() : [];
      const terminated = await terminateShell(bash_id);
      const stdout = remaining.join('\n');
      return {
        success: true,
        content: stdout || '(no output)',
        stdout,
        stderr: '',
        exitCode: terminated.exitCode ?? 0,
        bashId: bash_id,
        details: {
          bashId: bash_id,
          status: terminated.status,
          exitCode: terminated.exitCode ?? 0,
          outputLines: remaining.length,
        },
      };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Shell not found')) {
        const available = getAvailableIds();
        return {
          success: false,
          content: '',
          error: `${err.message}. Available: ${available.length ? available.join(', ') : 'none'}`,
          stdout: '',
          stderr: err.message,
          exitCode: -1,
        };
      }
      return {
        success: false,
        content: '',
        error: `Failed to terminate bash shell: ${String(err)}`,
        stdout: '',
        stderr: String(err),
        exitCode: -1,
      };
    }
  }
}
