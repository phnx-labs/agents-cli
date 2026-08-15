import { describe, expect, test } from 'bun:test';
import { bunCachePath, ciLayout, resultPath, runDir, worktreePath, assertSafeSegment } from './paths';

describe('directory contract', () => {
  test('names mirrors, runs, results, and bun cache exactly as the plan specifies', () => {
    const layout = ciLayout('/srv/ci');
    expect(layout.mirrors).toBe('/srv/ci/mirrors');
    expect(worktreePath(layout, {
      owner: 'phnx-labs',
      repo: 'agi-cli',
      candidateTreeSha: 'abc',
      checkRunId: '99',
    })).toBe('/srv/ci/runs/phnx-labs/agi-cli/abc/99/worktree');
    expect(runDir(layout, {
      owner: 'phnx-labs',
      repo: 'agi-cli',
      candidateTreeSha: 'abc',
      checkRunId: '99',
    })).toBe('/srv/ci/runs/phnx-labs/agi-cli/abc/99');
    expect(resultPath(layout, 'phnx-labs', 'agi-cli', '99')).toBe('/srv/ci/results/phnx-labs/agi-cli/99');
    expect(bunCachePath(layout, 'deadbeef')).toBe('/srv/ci/cache/bun/deadbeef');
    expect(() => assertSafeSegment('../x', 'owner')).toThrow(/not a safe path segment/);
  });
});
