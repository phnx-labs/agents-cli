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

describe('detectTestResult', () => {
  it('correlates a runner with the following result (vitest pass/fail)', () => {
    const r = detectTestResult([
      tool('Bash', undefined, 'bun run test'),
      result('Test Files 1 failed | 16 passed\nTests 4 failed | 294 passed'),
    ]);
    expect(r?.runner).toBe('tests');
    expect(r?.passed).toBe(294);
    expect(r?.failed).toBe(4);
  });

  it('reads tsc as clean when no TS errors', () => {
    const r = detectTestResult([tool('Bash', undefined, 'npx tsc --noEmit'), result('')]);
    expect(r?.runner).toBe('tsc');
    expect(r?.failed).toBe(0);
    expect(r?.ok).toBe(true);
  });

  it('returns the LAST run when several happen', () => {
    const r = detectTestResult([
      tool('Bash', undefined, 'bun test'), result('1 passed'),
      tool('Bash', undefined, 'pytest'), result('3 passed, 1 failed'),
    ]);
    expect(r?.runner).toBe('pytest');
    expect(r?.passed).toBe(3);
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
});
