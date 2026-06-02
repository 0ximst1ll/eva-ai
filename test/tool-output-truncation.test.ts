import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { BashTool } from '../src/tools/bash.js';
import { FindTool } from '../src/tools/find.js';
import { GrepTool } from '../src/tools/grep.js';
import { LsTool } from '../src/tools/ls.js';
import { ReadTool } from '../src/tools/read.js';

test('read_file keeps the head of large files and returns continuation guidance', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-read-truncate-'));
  try {
    const filePath = path.join(tempDir, 'large.txt');
    const lines = Array.from({ length: 800 }, (_, index) => `line-${index + 1} ${'x'.repeat(80)}`);
    await fs.writeFile(filePath, lines.join('\n'), 'utf-8');

    const result = await new ReadTool(tempDir).execute({ path: 'large.txt' });

    assert.equal(result.success, true);
    assert.match(result.content, /1\|line-1/);
    assert.match(result.content, /Use offset=\d+ to continue/);
    assert.doesNotMatch(result.content, /line-800/);
    assert.equal(result.details?.totalLines, 800);
    assert.equal(result.details?.startLine, 1);
    assert.ok(typeof result.details?.nextOffset === 'number');
    assert.equal(result.details?.truncation?.strategy, 'head');
    assert.equal(result.details?.truncation?.truncatedBy, 'bytes');
    assert.equal(result.details?.truncation?.totalLines, 800);
    assert.ok((result.details?.truncation?.outputLines ?? 0) < 800);
    assert.ok((result.details?.truncation?.totalBytes ?? 0) > (result.details?.truncation?.outputBytes ?? 0));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('bash keeps tail output and stores full truncated output in temp storage', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-bash-truncate-'));
  let fullOutputPath: string | undefined;
  try {
    const command = "printf '%030000d\\nTHE_END\\n' 0";
    const result = await new BashTool(tempDir).execute({ command, timeout: 10 });
    fullOutputPath = result.fullOutputPath;

    assert.equal(result.success, true);
    assert.match(result.content, /Showing last output/);
    assert.match(result.content, /THE_END/);
    assert.ok(fullOutputPath);
    assert.ok(fullOutputPath.startsWith(path.join(os.tmpdir(), 'eva-ai-bash-logs')));
    assert.doesNotMatch(fullOutputPath, new RegExp(escapeRegExp(tempDir)));
    assert.match(await fs.readFile(fullOutputPath, 'utf-8'), /THE_END/);
    assert.equal(result.details?.exitCode, 0);
    assert.equal(result.details?.fullOutputPath, fullOutputPath);
    assert.equal(result.details?.truncation?.strategy, 'tail');
    assert.equal(result.details?.truncation?.truncatedBy, 'bytes');
    assert.equal(result.details?.truncation?.totalLines, 2);
    assert.ok((result.details?.truncation?.outputLines ?? 0) <= 2);
    assert.ok((result.details?.truncation?.totalBytes ?? 0) > (result.details?.truncation?.outputBytes ?? 0));
  } finally {
    if (fullOutputPath) await fs.rm(fullOutputPath, { force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('grep_files reports max result boundaries', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-grep-truncate-'));
  try {
    await fs.writeFile(path.join(tempDir, 'matches.txt'), ['needle one', 'needle two', 'needle three'].join('\n'), 'utf-8');

    const result = await new GrepTool(tempDir).execute({ pattern: 'needle', max_results: 2 });

    assert.equal(result.success, true);
    assert.match(result.content, /matches\.txt:1: needle one/);
    assert.match(result.content, /Stopped after max_results=2/);
    assert.doesNotMatch(result.content, /needle three/);
    assert.equal(result.details?.matchCount, 2);
    assert.equal(result.details?.maxResults, 2);
    assert.equal(result.details?.limitedByMaxResults, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('list_files truncates large directory listings from the head', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-ls-truncate-'));
  try {
    const longName = `${'a'.repeat(240)}.txt`;
    for (let i = 0; i < 150; i++) {
      await fs.writeFile(path.join(tempDir, `${String(i).padStart(3, '0')}-${longName}`), '', 'utf-8');
    }

    const result = await new LsTool(tempDir).execute({});

    assert.equal(result.success, true);
    assert.match(result.content, /\[file\] 000-/);
    assert.match(result.content, /Directory listing truncated/);
    assert.doesNotMatch(result.content, /\[file\] 149-/);
    assert.equal(result.details?.resultCount, 150);
    assert.equal(result.details?.truncation?.strategy, 'head');
    assert.equal(result.details?.truncation?.truncatedBy, 'bytes');
    assert.equal(result.details?.truncation?.totalLines, 150);
    assert.ok((result.details?.truncation?.outputLines ?? 0) < 150);
    assert.ok((result.details?.truncation?.totalBytes ?? 0) > (result.details?.truncation?.outputBytes ?? 0));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('find_files reports result boundaries in details', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-find-details-'));
  try {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(tempDir, `match-${i}.txt`), '', 'utf-8');
    }

    const result = await new FindTool(tempDir).execute({ pattern: 'match', max_results: 2 });

    assert.equal(result.success, true);
    assert.match(result.content, /Stopped after max_results=2/);
    assert.equal(result.details?.resultCount, 2);
    assert.equal(result.details?.maxResults, 2);
    assert.equal(result.details?.limitedByMaxResults, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
