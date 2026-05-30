import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { BashTool, type BashOperations } from '../src/tools/bash.js';
import { ReadTool } from '../src/tools/read.js';
import { WriteTool } from '../src/tools/write.js';
import type { FileToolDirent, FileToolOperations, FileToolStats } from '../src/tools/file-operations.js';

class FakeStats implements FileToolStats {
  constructor(private readonly directory: boolean) {}

  isDirectory(): boolean {
    return this.directory;
  }
}

class FakeDirent implements FileToolDirent {
  constructor(
    readonly name: string,
    private readonly directory: boolean,
  ) {}

  isDirectory(): boolean {
    return this.directory;
  }

  isFile(): boolean {
    return !this.directory;
  }
}

function createFakeFileOperations(files: Map<string, string>): FileToolOperations {
  const dirs = new Set<string>();
  for (const filePath of files.keys()) {
    dirs.add(path.dirname(filePath));
  }

  return {
    exists(filePath) {
      return files.has(filePath) || dirs.has(filePath);
    },
    readFile(filePath) {
      const content = files.get(filePath);
      if (content === undefined) throw new Error(`Missing fake file: ${filePath}`);
      return content;
    },
    writeFile(filePath, content) {
      files.set(filePath, content);
      dirs.add(path.dirname(filePath));
    },
    stat(filePath) {
      if (dirs.has(filePath)) return new FakeStats(true);
      if (files.has(filePath)) return new FakeStats(false);
      throw new Error(`Missing fake path: ${filePath}`);
    },
    readdir(dirPath) {
      const names = new Map<string, FakeDirent>();
      for (const filePath of files.keys()) {
        if (path.dirname(filePath) !== dirPath) continue;
        names.set(path.basename(filePath), new FakeDirent(path.basename(filePath), false));
      }
      for (const childDir of dirs) {
        if (childDir === dirPath || path.dirname(childDir) !== dirPath) continue;
        names.set(path.basename(childDir), new FakeDirent(path.basename(childDir), true));
      }
      return [...names.values()];
    },
    mkdir(dirPath) {
      dirs.add(dirPath);
    },
  };
}

test('file tools can use injected file operations', async () => {
  const workspaceDir = '/workspace';
  const files = new Map<string, string>([
    [path.join(workspaceDir, 'input.txt'), 'alpha\nbeta'],
  ]);
  const operations = createFakeFileOperations(files);

  const readResult = await new ReadTool(workspaceDir, operations).execute({ path: 'input.txt' });
  assert.equal(readResult.success, true);
  assert.match(readResult.content, /1\|alpha/);

  const writeResult = await new WriteTool(workspaceDir, operations).execute({
    path: 'nested/output.txt',
    content: 'written',
  });
  assert.equal(writeResult.success, true);
  assert.equal(files.get(path.join(workspaceDir, 'nested/output.txt')), 'written');
});

test('bash foreground execution can use injected exec operations', async () => {
  const calls: Array<{ command: string; cwd: string | undefined; timeoutSecs: number }> = [];
  const operations: BashOperations = {
    async exec(command, cwd, _isWindows, options) {
      calls.push({ command, cwd, timeoutSecs: options.timeoutSecs });
      return {
        success: true,
        content: `fake:${command}`,
        stdout: 'fake stdout',
        stderr: '',
        exitCode: 0,
      };
    },
  };

  const result = await new BashTool('/workspace', operations).execute({ command: 'echo hello', timeout: 3 });

  assert.equal(result.success, true);
  assert.equal(result.content, 'fake:echo hello');
  assert.deepEqual(calls, [{ command: 'echo hello', cwd: '/workspace', timeoutSecs: 3 }]);
});
