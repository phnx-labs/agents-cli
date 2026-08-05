import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCiScope, formatGitHubOutputs } from './ci-scope';

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
