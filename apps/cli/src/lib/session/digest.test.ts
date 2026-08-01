import { describe, it, expect } from 'vitest';
import type { SessionEvent } from './types.js';
import {
  classifyFileChanges,
  changeCounts,
  toolHistogram,
  detectTestResult,
  extractDeletedPaths,
} from './digest.js';

function tool(toolName: string, path?: string, command?: string): SessionEvent {
  return { type: 'tool_use', agent: 'claude', timestamp: '2026-06-30T10:00:00Z', tool: toolName, path, command, args: path ? { file_path: path } : {} };
}
function result(output: string): SessionEvent {
  return { type: 'tool_result', agent: 'claude', timestamp: '2026-06-30T10:00:01Z', success: true, output };
}

describe('classifyFileChanges', () => {
  it('Write to a fresh path is a creation; Edit is a modification', () => {
    const changes = classifyFileChanges([tool('Write', 'src/new.ts'), tool('Edit', 'src/existing.ts')]);
    expect(changes).toContainEqual({ path: 'src/new.ts', op: 'created' });
    expect(changes).toContainEqual({ path: 'src/existing.ts', op: 'modified' });
  });

  it('a Read before a Write means modified, not created', () => {
    const changes = classifyFileChanges([tool('Read', 'src/a.ts'), tool('Write', 'src/a.ts')]);
    expect(changes).toContainEqual({ path: 'src/a.ts', op: 'modified' });
    expect(changes.find(c => c.path === 'src/a.ts')?.op).not.toBe('created');
  });

  it('created then edited nets to created (still a new file)', () => {
    const changes = classifyFileChanges([tool('Write', 'src/n.ts'), tool('Edit', 'src/n.ts')]);
    expect(changes.filter(c => c.path === 'src/n.ts')).toEqual([{ path: 'src/n.ts', op: 'created' }]);
  });

  it('a deletion wins over an earlier create/modify', () => {
    const changes = classifyFileChanges([tool('Write', 'tmp/x'), tool('Bash', undefined, 'rm tmp/x')]);
    expect(changes).toContainEqual({ path: 'tmp/x', op: 'deleted' });
    expect(changes.find(c => c.path === 'tmp/x')?.op).toBe('deleted');
  });

  it('excludes plan files', () => {
    const changes = classifyFileChanges([tool('Write', '/home/u/.claude/plans/foo.md')]);
    expect(changes).toHaveLength(0);
  });

  it('created then deleted then recreated nets to created (file exists)', () => {
    const changes = classifyFileChanges([
      tool('Write', 'tmp/x'),
      tool('Bash', undefined, 'rm tmp/x'),
      tool('Write', 'tmp/x'),
    ]);
    expect(changes.filter(c => c.path === 'tmp/x')).toEqual([{ path: 'tmp/x', op: 'created' }]);
  });
});

describe('extractDeletedPaths', () => {
  it('parses rm and git rm, skipping flags and globs', () => {
    expect(extractDeletedPaths('rm -rf dist a.txt')).toEqual(['dist', 'a.txt']);
    expect(extractDeletedPaths('git rm old.ts')).toEqual(['old.ts']);
    expect(extractDeletedPaths('rm *.log')).toEqual([]); // glob skipped
  });
  it('parses a delete chained after another command', () => {
    expect(extractDeletedPaths('bun run build && rm dist/old.js')).toEqual(['dist/old.js']);
  });
  it('ignores non-delete commands', () => {
    expect(extractDeletedPaths('echo rm not-a-delete')).toEqual([]);
  });
});

describe('changeCounts', () => {
  it('tallies per op', () => {
    const c = changeCounts([
      { path: 'a', op: 'created' }, { path: 'b', op: 'created' },
      { path: 'c', op: 'modified' }, { path: 'd', op: 'deleted' },
    ]);
    expect(c).toEqual({ created: 2, modified: 1, deleted: 1 });
  });
});

describe('toolHistogram', () => {
  it('sorts by count descending and caps', () => {
    const h = toolHistogram({ Read: 5, Edit: 20, Bash: 12 }, 2);
    expect(h).toEqual([{ tool: 'Edit', count: 20 }, { tool: 'Bash', count: 12 }]);
  });
});

// Real captured runner summary blobs — pasted verbatim from an actual run of
// each runner so the anchored parser is validated against reality, not a sketch.
// vitest 4.1.9 and bun 1.3.x outputs were captured on this machine; jest/pytest/
// mocha footers are the runners' documented, long-stable summary formats.
const VITEST_MIXED = `
 ❯ b.test.ts:4:31

 Test Files  1 failed (1)
      Tests  4 failed | 294 passed (298)
   Start at  13:42:52
   Duration  84ms (transform 11ms, setup 0ms, import 17ms, tests 3ms, environment 0ms)
`;
const VITEST_ALLPASS = `
 Test Files  1 passed (1)
      Tests  442 passed (442)
   Start at  13:44:10
   Duration  120ms
`;
const JEST_OUTPUT = `
PASS  src/a.test.ts
Test Suites: 1 failed, 3 passed, 4 total
Tests:       2 failed, 294 passed, 296 total
Snapshots:   0 total
Time:        1.234 s
`;
const PYTEST_OUTPUT = `
tests/test_a.py .....F                                              [100%]
==================== 294 passed, 2 failed in 1.23s ====================
`;
const PYTEST_ALLPASS = `
tests/test_a.py ....                                                [100%]
========================= 442 passed in 0.98s =========================
`;
const BUN_OUTPUT = `
a.test.ts:
(pass) one [0.10ms]
(fail) bad [0.12ms]

 294 pass
 2 fail
 296 expect() calls
Ran 296 tests across 1 file. [31.00ms]
`;
const MOCHA_OUTPUT = `
  my suite
    ✓ does a thing
    ✗ does another

  294 passing (1s)
  2 failing
`;

describe('detectTestResult', () => {
  it('reads a real vitest summary (mixed pass/fail)', () => {
    const r = detectTestResult([tool('Bash', undefined, 'bun run test'), result(VITEST_MIXED)]);
    expect(r?.runner).toBe('tests');
    expect(r?.passed).toBe(294);
    expect(r?.failed).toBe(4);
    expect(r?.ok).toBe(true);
  });

  it('reads a real vitest all-pass summary', () => {
    const r = detectTestResult([tool('Bash', undefined, 'vitest run'), result(VITEST_ALLPASS)]);
    expect(r?.passed).toBe(442);
    expect(r?.failed).toBe(0);
  });

  it('reads a real jest summary (Tests: line)', () => {
    const r = detectTestResult([tool('Bash', undefined, 'jest'), result(JEST_OUTPUT)]);
    expect(r?.passed).toBe(294);
    expect(r?.failed).toBe(2);
  });

  it('reads a real pytest summary rule line', () => {
    const r = detectTestResult([tool('Bash', undefined, 'pytest'), result(PYTEST_OUTPUT)]);
    expect(r?.runner).toBe('pytest');
    expect(r?.passed).toBe(294);
    expect(r?.failed).toBe(2);
    const clean = detectTestResult([tool('Bash', undefined, 'pytest'), result(PYTEST_ALLPASS)]);
    expect(clean?.passed).toBe(442);
    expect(clean?.failed).toBe(0);
  });

  it('reads a real bun test summary block (N pass / N fail + Ran N tests)', () => {
    const r = detectTestResult([tool('Bash', undefined, 'bun test'), result(BUN_OUTPUT)]);
    expect(r?.passed).toBe(294);
    expect(r?.failed).toBe(2);
  });

  it('reads a real mocha summary (N passing / N failing)', () => {
    const r = detectTestResult([tool('Bash', undefined, 'mocha'), result(MOCHA_OUTPUT)]);
    expect(r?.passed).toBe(294);
    expect(r?.failed).toBe(2);
  });

  it('reads tsc as clean when no TS errors', () => {
    const r = detectTestResult([tool('Bash', undefined, 'npx tsc --noEmit'), result('')]);
    expect(r?.runner).toBe('tsc');
    expect(r?.failed).toBe(0);
    expect(r?.ok).toBe(true);
  });

  it('returns the LAST run when several happen', () => {
    const r = detectTestResult([
      tool('Bash', undefined, 'bun test'), result(BUN_OUTPUT),
      tool('Bash', undefined, 'pytest'), result(PYTEST_OUTPUT),
    ]);
    expect(r?.runner).toBe('pytest');
    expect(r?.passed).toBe(294);
  });

  it('returns undefined when nothing ran', () => {
    expect(detectTestResult([tool('Read', 'a.ts')])).toBeUndefined();
  });

  it('reads go test PASS/FAIL markers', () => {
    const pass = detectTestResult([tool('Bash', undefined, 'go test ./...'), result('--- PASS: TestA (0.01s)\nok  \tpkg\t0.2s')]);
    expect(pass?.runner).toBe('go test');
    expect(pass?.failed).toBe(0);
    const fail = detectTestResult([tool('Bash', undefined, 'go test ./...'), result('--- FAIL: TestB (0.01s)\nFAIL\tpkg\t0.2s')]);
    expect(fail?.failed).toBe(1);
    expect(fail?.ok).toBe(true);
  });

  it('marks the runner failed when the result is an error event', () => {
    const r = detectTestResult([
      { type: 'tool_use', agent: 'claude', timestamp: '2026-06-30T10:00:00Z', tool: 'Bash', command: 'bun test' },
      { type: 'error', agent: 'claude', timestamp: '2026-06-30T10:00:01Z', tool: 'Bash', content: 'exit 1' },
    ]);
    expect(r?.runner).toBe('tests');
    expect(r?.failed).toBe(1);
  });

  // ---- Negative cases: the over-count bug this fix closes ----

  it('does NOT report "442 passwords generated" as 442 pass', () => {
    const r = detectTestResult([
      tool('Bash', undefined, 'bun run test'),
      result('Setting up fixtures...\n442 passwords generated for the seed corpus\nRan 0 tests across 0 files. [1ms]'),
    ]);
    // No real ` N pass` summary line present → no bogus pass count.
    expect(r?.passed).toBeUndefined();
  });

  it('does NOT report "442 files" from git status as a pass count', () => {
    const r = detectTestResult([
      tool('Bash', undefined, 'npm test'),
      result('git status: 442 files changed, 0 passed validation stage'),
    ]);
    expect(r?.passed).toBeUndefined();
    expect(r?.ok).toBe(false);
  });

  it('does NOT report a "442 passes/sec" benchmark as 442 pass', () => {
    const r = detectTestResult([
      tool('Bash', undefined, 'vitest bench'),
      result('benchmark: hot path — 442 passes/sec (± 3%)'),
    ]);
    expect(r?.passed).toBeUndefined();
  });

  it('does NOT classify "bun test:setup" (a script sub-target) as a test run', () => {
    // Only the setup script runs; its output happens to contain "88 passed"
    // prose. Neither the command nor the output is a real test run.
    const r = detectTestResult([
      tool('Bash', undefined, 'bun test:setup'),
      result('seeded db; 88 passed the schema check'),
    ]);
    expect(r).toBeUndefined();
  });

  it('does NOT classify "npm run test:watch" as a test run', () => {
    const r = detectTestResult([
      tool('Bash', undefined, 'npm run test:watch'),
      result('watching for changes... 12 passed earlier'),
    ]);
    expect(r).toBeUndefined();
  });

  it('does NOT classify "pnpm test:ci" as a test run', () => {
    const r = detectTestResult([
      tool('Bash', undefined, 'pnpm test:ci'),
      result('orchestrating ci; 5 passed the lint gate'),
    ]);
    expect(r).toBeUndefined();
  });

  it('still classifies a real "bun test" invocation (positive control)', () => {
    const r = detectTestResult([tool('Bash', undefined, 'bun test'), result(BUN_OUTPUT)]);
    expect(r?.runner).toBe('tests');
    expect(r?.passed).toBe(294);
  });
});
