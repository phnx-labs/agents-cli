import { expect, test, describe } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { classifySync, getSyncStatus, type SyncState } from './repoSync';

describe('classifySync', () => {
  test('dirty wins over everything', () => {
    expect(classifySync({ ahead: 5, behind: 5, dirty: true })).toBe('dirty');
    expect(classifySync({ ahead: 0, behind: 0, dirty: true })).toBe('dirty');
  });

  test('diverged when ahead and behind, not dirty', () => {
    expect(classifySync({ ahead: 2, behind: 3, dirty: false })).toBe('diverged');
  });

  test('behind only', () => {
    expect(classifySync({ ahead: 0, behind: 4, dirty: false })).toBe('behind');
  });

  test('ahead only', () => {
    expect(classifySync({ ahead: 7, behind: 0, dirty: false })).toBe('ahead');
  });

  test('in-sync when all zero and clean', () => {
    expect(classifySync({ ahead: 0, behind: 0, dirty: false })).toBe('in-sync');
  });
});

const VALID_STATES: SyncState[] = ['in-sync', 'behind', 'ahead', 'diverged', 'dirty', 'unknown'];

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
  })
    .toString()
    .trim();
}

describe('getSyncStatus', () => {
  test('reports a valid status shape against the real repo', async () => {
    const root = repoRoot();
    const status = await getSyncStatus(root);
    expect(status.root).toBe(root);
    expect(VALID_STATES).toContain(status.state);
    expect(typeof status.ahead).toBe('number');
    expect(typeof status.behind).toBe('number');
    expect(typeof status.dirty).toBe('boolean');
    expect(status.defaultBranch.length).toBeGreaterThan(0);
    expect(status.defaultBranch).not.toContain('refs/');
  });

  test('non-git path returns unknown, never throws', async () => {
    const status = await getSyncStatus('/');
    expect(status.state).toBe('unknown');
    expect(status.defaultBranch).toBe('');
  });
});
