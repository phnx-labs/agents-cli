import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  changedFilesBetween,
  classifyCiScope,
  formatGitHubOutputs,
} from './ci-scope';

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'ci-scope@example.invalid',
      GIT_AUTHOR_NAME: 'CI Scope Test',
      GIT_COMMITTER_EMAIL: 'ci-scope@example.invalid',
      GIT_COMMITTER_NAME: 'CI Scope Test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(Buffer.from(proc.stderr).toString('utf8'));
  }
  return Buffer.from(proc.stdout).toString('utf8').trim();
}

function writeFixture(root: string, file: string): void {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${file}\n`);
}

describe('classifyCiScope', () => {
  test('runs only CLI checks for CLI source', () => {
    expect(classifyCiScope(['apps/cli/src/lib/state.ts'])).toEqual({
      cli: true,
      cliDocs: false,
      factory: false,
      sessionTracker: false,
      windows: false,
    });
  });

  test('runs docs verification without the CLI suite for CLI docs', () => {
    expect(classifyCiScope([
      'apps/cli/docs/architecture.md',
      'apps/cli/.changelog/next/ci.md',
    ])).toEqual({
      cli: false,
      cliDocs: true,
      factory: false,
      sessionTracker: false,
      windows: false,
    });
  });

  test('runs each affected component for a mixed change', () => {
    expect(classifyCiScope([
      'apps/cli/src/index.ts',
      'apps/cli/README.md',
      'apps/factory/src/extension.ts',
      'packages/session-tracker/src/index.ts',
    ])).toEqual({
      cli: true,
      cliDocs: true,
      factory: true,
      sessionTracker: true,
      windows: false,
    });
  });

  test.each([
    'apps/cli/src/lib/hooks.ts',
    'apps/cli/src/lib/hooks/loader.ts',
    'apps/cli/src/lib/platform/paths.ts',
    'apps/cli/src/lib/shims-windows.ts',
    'apps/cli/hooks/session-start.sh',
    'apps/cli/src/lib/hosts/dispatch.ts',
  ])('marks %s as Windows-sensitive', (file) => {
    const scope = classifyCiScope([file]);
    expect(scope.cli).toBe(true);
    expect(scope.windows).toBe(true);
  });

  test('runs every component when the workflow or classifier changes', () => {
    for (const file of [
      '.github/workflows/tests.yml',
      '.github/workflows/bench.yml',
      'scripts/ci-scope.ts',
      'scripts/ci-scope.test.ts',
    ]) {
      expect(classifyCiScope([file])).toEqual({
        cli: true,
        cliDocs: true,
        factory: true,
        sessionTracker: true,
        windows: true,
      });
    }
  });

  test('does not spend component runners on unrelated repository files', () => {
    expect(classifyCiScope(['website/app/page.tsx', 'apps/ios/README.md'])).toEqual({
      cli: false,
      cliDocs: false,
      factory: false,
      sessionTracker: false,
      windows: false,
    });
  });
});

test('the executable writes GitHub outputs from NUL-delimited git paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-ci-scope-'));
  const output = join(dir, 'github-output');
  try {
    const proc = Bun.spawnSync({
      cmd: ['bun', join(import.meta.dir, 'ci-scope.ts'), output],
      stdin: Buffer.from('apps/factory/src/extension.ts\0apps/cli/docs/README.md\0'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(formatGitHubOutputs({
      cli: false,
      cliDocs: true,
      factory: true,
      sessionTracker: false,
      windows: false,
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changedFilesBetween ignores changes made only on the updated base branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-ci-merge-base-'));
  const repo = join(dir, 'repo');
  const headWorktree = join(dir, 'head');
  try {
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    writeFixture(repo, 'README.md');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'base');
    const mergeBase = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'worktree', 'add', '-b', 'pr-head', headWorktree, mergeBase);
    writeFixture(headWorktree, 'apps/factory/src/extension.ts');
    git(headWorktree, 'add', 'apps/factory/src/extension.ts');
    git(headWorktree, 'commit', '-m', 'factory change');
    const head = git(headWorktree, 'rev-parse', 'HEAD');

    writeFixture(repo, 'apps/cli/src/lib/base-only.ts');
    git(repo, 'add', 'apps/cli/src/lib/base-only.ts');
    git(repo, 'commit', '-m', 'base-only change');
    const updatedBase = git(repo, 'rev-parse', 'HEAD');

    expect(changedFilesBetween(updatedBase, head, repo)).toEqual([
      'apps/factory/src/extension.ts',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changedFilesBetween keeps both sides of a cross-component rename', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agents-ci-rename-'));
  try {
    git(repo, 'init', '-b', 'main');
    const oldPath = 'apps/cli/src/lib/hooks.ts';
    const newPath = 'website/hooks.ts';
    writeFixture(repo, oldPath);
    git(repo, 'add', oldPath);
    git(repo, 'commit', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');

    mkdirSync(join(repo, 'website'), { recursive: true });
    renameSync(join(repo, oldPath), join(repo, newPath));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'move hook');
    const head = git(repo, 'rev-parse', 'HEAD');

    const files = changedFilesBetween(base, head, repo);
    expect(files.sort()).toEqual([oldPath, newPath].sort());
    expect(classifyCiScope(files)).toMatchObject({ cli: true, windows: true });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
