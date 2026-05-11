import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entrypoint = path.join(repoRoot, 'src', 'index.ts');

function runCli(args: string[]): string {
  return execFileSync('node', [tsxCli, entrypoint, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  });
}

describe('prune command', () => {
  it('surfaces prune in top-level help', () => {
    const helpText = runCli(['--help']);

    expect(helpText).toContain('prune [target]');
    expect(helpText).toContain('Remove orphan resources and older duplicate version installs');
  });

  it('shows dedicated help for agents prune', () => {
    const helpText = runCli(['prune', '--help']);

    expect(helpText).toContain('Usage: agents prune [options] [target]');
    expect(helpText).toContain('--dry-run');
    expect(helpText).toContain('agents prune --dry-run');
    expect(helpText).toContain('agents prune claude');
    expect(helpText).toContain('agents prune skills');
    expect(helpText).not.toContain('Usage: agents [command] [options]');
  });

  it('shows dry-run support for view prune help', () => {
    const helpText = runCli(['view', '--help']);

    expect(helpText).toContain('--dry-run');
    expect(helpText).toContain('agents view --prune --dry-run');
    expect(helpText).toContain('With --prune --dry-run: preview only, no deletions');
  });
});
