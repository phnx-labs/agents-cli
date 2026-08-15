import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestTemplate } from './execute';
import { worktreePath, ciLayout } from './paths';
import { initRepo } from './test-repo';
import type { ExecutorRequest } from './types';
import { createRunWorktree, removeRunWorktree } from './worktree';

describe('namespaced worktrees', () => {
  test('two runs of the same repo get distinct detached worktrees from one mirror', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-wt-'));
    try {
      const src = initRepo(root, 'src');
      const layout = ciLayout(join(root, 'ci'));
      const a = requestTemplate({
        owner: 'phnx-labs',
        repo: 'agi-cli',
        checkRunId: 'run-a',
        candidateCommitSha: src.commit,
        candidateTreeSha: src.tree,
      }) as unknown as ExecutorRequest;
      const b = requestTemplate({
        owner: 'phnx-labs',
        repo: 'agi-cli',
        checkRunId: 'run-b',
        candidateCommitSha: src.commit,
        candidateTreeSha: src.tree,
      }) as unknown as ExecutorRequest;

      const pathA = createRunWorktree(layout, a, src.gitDir);
      const pathB = createRunWorktree(layout, b, src.gitDir);
      expect(pathA).not.toBe(pathB);
      expect(pathA).toBe(worktreePath(layout, a));
      expect(readFileSync(join(pathA, 'README.md'), 'utf8')).toBe('src\n');
      expect(readFileSync(join(pathB, 'README.md'), 'utf8')).toBe('src\n');

      removeRunWorktree(layout, a, src.gitDir);
      expect(existsSync(pathA)).toBe(false);
      expect(existsSync(pathB)).toBe(true);
      removeRunWorktree(layout, b, src.gitDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
