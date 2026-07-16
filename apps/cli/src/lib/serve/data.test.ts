/**
 * Tests for the read-only serve data assembly + the gitDiff helper.
 *
 * These exercise the real critical path: a real temp git repo with a real
 * commit and a real uncommitted modification, run through the real `git diff`
 * helper — no mocking of the code under test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { gitDiff } from '../teams/worktree.js';
import { buildWorktreeDiffs } from './data.js';
import type { WorktreeAgentLike } from './data.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

describe('gitDiff', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-git-'));
    await git(repo, 'init', '-q');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'file.txt'), 'original line\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'initial');
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns the uncommitted diff for a modified tracked file', async () => {
    await fs.writeFile(path.join(repo, 'file.txt'), 'modified line\n');
    const diff = await gitDiff(repo);
    expect(diff).toContain('file.txt');
    expect(diff).toContain('-original line');
    expect(diff).toContain('+modified line');
  });

  it('returns empty string for a clean worktree', async () => {
    const diff = await gitDiff(repo);
    expect(diff).toBe('');
  });

  it('returns empty string for a non-git directory (no throw)', async () => {
    const notGit = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-notgit-'));
    try {
      expect(await gitDiff(notGit)).toBe('');
    } finally {
      await fs.rm(notGit, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('caps the diff at maxBytes and marks it truncated', async () => {
    const big = 'x'.repeat(5000) + '\n';
    await fs.writeFile(path.join(repo, 'file.txt'), big);
    const diff = await gitDiff(repo, 500);
    expect(diff.length).toBeLessThan(700);
    expect(diff).toContain('[diff truncated at 500 bytes]');
  });
});

describe('buildWorktreeDiffs', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-wt-'));
    await git(repo, 'init', '-q');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'app.ts'), 'export const x = 1;\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'initial');
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('attaches a real diff to a teammate that has a worktree with changes', async () => {
    await fs.writeFile(path.join(repo, 'app.ts'), 'export const x = 2;\n');
    const agents: WorktreeAgentLike[] = [
      {
        agentId: 'abc123',
        name: 'builder',
        agentType: 'claude',
        status: 'running',
        worktreeName: 'feature',
        worktreePath: repo,
        prUrl: 'https://github.com/o/r/pull/1',
      },
    ];
    const diffs = await buildWorktreeDiffs(agents);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].agent_id).toBe('abc123');
    expect(diffs[0].pr_url).toBe('https://github.com/o/r/pull/1');
    expect(diffs[0].diff).toContain('-export const x = 1;');
    expect(diffs[0].diff).toContain('+export const x = 2;');
  });

  it('skips teammates that have no worktree path', async () => {
    const agents: WorktreeAgentLike[] = [
      {
        agentId: 'noweave',
        name: null,
        agentType: 'codex',
        status: 'completed',
        worktreeName: null,
        worktreePath: null,
        prUrl: null,
      },
    ];
    expect(await buildWorktreeDiffs(agents)).toHaveLength(0);
  });
});
