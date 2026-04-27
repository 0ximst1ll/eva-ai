// Shell command execution tool — mirrors eva_ai/tools/bash_tool.py
// Python uses asyncio.create_subprocess_*; TypeScript uses Node.js child_process.

import * as cp from 'node:child_process';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolResult } from './base.js';

// Extended result type with bash-specific fields.
// Python uses Pydantic inheritance (BashOutputResult extends ToolResult);
// TypeScript uses an intersection / extended interface.
export interface BashOutputResult extends ToolResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  bashId?: string;
}

// ============ BackgroundShell ============

class BackgroundShell {
  readonly bashId: string;
  readonly command: string;
  readonly startTime: number;
  private readonly process: cp.ChildProcess;
  private readonly outputLines: string[] = [];
  private lastReadIndex = 0;
  status: 'running' | 'completed' | 'failed' | 'terminated' | 'error' = 'running';
  exitCode: number | null = null;

  constructor(bashId: string, command: string, process: cp.ChildProcess) {
    this.bashId = bashId;
    this.command = command;
    this.startTime = Date.now();
    this.process = process;
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
      this.process.kill('SIGTERM');
      // Force kill after 5 s
      setTimeout(() => this.process.kill('SIGKILL'), 5000);
    });
  }
}

// ============ BackgroundShellManager (module-level singleton) ============
// Python uses class-level dicts; TypeScript uses module-level Maps.

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
    for (const line of lines) {
      if (line) shell.addOutput(line);
    }
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

// ============ BashTool ============

interface BashInput extends Record<string, unknown> {
  command: string;
  timeout?: number;
  run_in_background?: boolean;
}

export class BashTool implements Tool<BashInput> {
  private readonly isWindows: boolean;

  constructor(private readonly workspaceDir?: string) {
    this.isWindows = os.platform() === 'win32';
  }

  readonly name = 'bash';

  get description(): string {
    if (this.isWindows) {
      return `Execute PowerShell commands in foreground or background.

For terminal operations like git, npm, docker, etc. DO NOT use for file operations - use specialized tools.

Parameters:
  - command (required): PowerShell command to execute
  - timeout (optional): Timeout in seconds (default: 120, max: 600) for foreground commands
  - run_in_background (optional): Set true for long-running commands (servers, etc.)

Tips:
  - Quote file paths with spaces: cd "My Documents"
  - Chain dependent commands with semicolon: git add . ; git commit -m "msg"
  - Use absolute paths instead of cd when possible
  - For background commands, monitor with bash_output and terminate with bash_kill

Examples:
  - git status
  - npm test
  - python -m http.server 8080 (with run_in_background=true)`;
    }
    return `Execute bash commands in foreground or background.

For terminal operations like git, npm, docker, etc. DO NOT use for file operations - use specialized tools.

Parameters:
  - command (required): Bash command to execute
  - timeout (optional): Timeout in seconds (default: 120, max: 600) for foreground commands
  - run_in_background (optional): Set true for long-running commands (servers, etc.)

Tips:
  - Quote file paths with spaces: cd "My Documents"
  - Chain dependent commands with &&: git add . && git commit -m "msg"
  - Use absolute paths instead of cd when possible
  - For background commands, monitor with bash_output and terminate with bash_kill

Examples:
  - git status
  - npm test
  - python3 -m http.server 8080 (with run_in_background=true)`;
  }

  readonly parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute.' },
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

  async execute({ command, timeout = 120, run_in_background = false }: BashInput): Promise<BashOutputResult> {
    try {
      const effectiveTimeout = Math.min(Math.max(timeout, 1), 600);

      if (run_in_background) {
        return this._runBackground(command);
      }
      return this._runForeground(command, effectiveTimeout);
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

  private _runBackground(command: string): BashOutputResult {
    const bashId = randomUUID().slice(0, 8);
    const proc = this.isWindows
      ? cp.spawn('powershell.exe', ['-NoProfile', '-Command', command], {
          cwd: this.workspaceDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : cp.spawn('bash', ['-c', command], {
          cwd: this.workspaceDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

    const shell = new BackgroundShell(bashId, command, proc);
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

  private _runForeground(command: string, timeoutSecs: number): Promise<BashOutputResult> {
    return new Promise((resolve) => {
      const proc = this.isWindows
        ? cp.spawn('powershell.exe', ['-NoProfile', '-Command', command], {
            cwd: this.workspaceDir,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : cp.spawn('bash', ['-c', command], {
            cwd: this.workspaceDir,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, timeoutSecs * 1000);

      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });

      proc.once('exit', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            success: false,
            content: '',
            error: `Command timed out after ${timeoutSecs} seconds`,
            stdout: '',
            stderr: `Command timed out after ${timeoutSecs} seconds`,
            exitCode: -1,
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

        let content = stdout;
        if (stderr) content += `\n[stderr]:\n${stderr}`;
        if (exitCode) content += `\n[exit_code]:\n${exitCode}`;
        if (!content) content = '(no output)';

        resolve({ success, content, error, stdout, stderr, exitCode });
      });

      proc.once('error', (err) => {
        clearTimeout(timer);
        resolve({
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

// ============ BashOutputTool ============

interface BashOutputInput extends Record<string, unknown> {
  bash_id: string;
  filter_str?: string;
}

export class BashOutputTool implements Tool<BashOutputInput> {
  readonly name = 'bash_output';
  readonly description = `Retrieves output from a running or completed background bash shell.

        - Takes a bash_id parameter identifying the shell
        - Always returns only new output since the last check
        - Returns stdout and stderr output along with shell status
        - Supports optional regex filtering to show only lines matching a pattern
        - Use this tool when you need to monitor or check the output of a long-running shell
        - Shell IDs can be found using the bash tool with run_in_background=true

        Process status values:
          - "running": Still executing
          - "completed": Finished successfully
          - "failed": Finished with error
          - "terminated": Was terminated
          - "error": Error occurred

        Example: bash_output(bash_id="abc12345")`;
  readonly parameters = {
    type: 'object',
    properties: {
      bash_id: {
        type: 'string',
        description: 'The ID of the background shell to retrieve output from.',
      },
      filter_str: {
        type: 'string',
        description: 'Optional regular expression to filter the output lines.',
      },
    },
    required: ['bash_id'],
  };

  async execute({ bash_id, filter_str }: BashOutputInput): Promise<BashOutputResult> {
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
    let content = stdout;
    if (shell.bashId) content += `\n[bash_id]:\n${shell.bashId}`;
    if (!content) content = '(no output)';

    return {
      success: true,
      content,
      stdout,
      stderr: '',
      exitCode: shell.exitCode ?? 0,
      bashId: bash_id,
    };
  }
}

// ============ BashKillTool ============

interface BashKillInput extends Record<string, unknown> {
  bash_id: string;
}

export class BashKillTool implements Tool<BashKillInput> {
  readonly name = 'bash_kill';
  readonly description = `Kills a running background bash shell by its ID.

        - Takes a bash_id parameter identifying the shell to kill
        - Attempts graceful termination (SIGTERM) first, then forces (SIGKILL) if needed
        - Returns the final status and any remaining output before termination
        - Cleans up all resources associated with the shell
        - Use this tool when you need to terminate a long-running shell
        - Shell IDs can be found using the bash tool with run_in_background=true

        Example: bash_kill(bash_id="abc12345")`;
  readonly parameters = {
    type: 'object',
    properties: {
      bash_id: {
        type: 'string',
        description: 'The ID of the background shell to terminate.',
      },
    },
    required: ['bash_id'],
  };

  async execute({ bash_id }: BashKillInput): Promise<BashOutputResult> {
    try {
      const shell = getShell(bash_id);
      const remaining = shell ? shell.getNewOutput() : [];

      const terminated = await terminateShell(bash_id);
      const stdout = remaining.join('\n');
      let content = stdout;
      if (!content) content = '(no output)';

      return {
        success: true,
        content,
        stdout,
        stderr: '',
        exitCode: terminated.exitCode ?? 0,
        bashId: bash_id,
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
