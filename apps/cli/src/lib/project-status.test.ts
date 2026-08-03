import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { rollupSessionsByProject, planPct } from './project-status.js';
import type { ProjectDef } from './projects.js';
import type { ActiveSession } from './session/active.js';

const HOME = process.env.HOME ?? os.homedir();
const defs: ProjectDef[] = [
  { name: 'rush', root: '~/src/rush' },
  { name: 'other', root: '~/src/other' },
];

/** Minimal ActiveSession carrying only the fields the rollup reads. */
function s(partial: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...partial } as unknown as ActiveSession;
}

describe('rollupSessionsByProject', () => {
  it('groups by cwd, counts statuses, sums plan, dedups PRs and tickets', () => {
    const sessions = [
      s({ cwd: path.join(HOME, 'src/rush/apps/web'), status: 'running', todos: { done: 3, total: 5 } as never }),
      s({
        cwd: path.join(HOME, 'src/rush/.agents/worktrees/fix'),
        status: 'idle',
        todos: { done: 2, total: 2 } as never,
        pr: { url: 'https://github.com/o/r/pull/9', number: 9 } as never,
        worktree: { path: 'x' } as never,
      }),
      s({
        cwd: path.join(HOME, 'src/rush/apps/api'),
        status: 'input_required',
        pr: { url: 'https://github.com/o/r/pull/9', number: 9 } as never, // dup PR
        ticket: { id: 'RUSH-1' } as never,
        createdTickets: ['RUSH-2', 'RUSH-1'], // RUSH-1 dup
      }),
      s({ cwd: path.join(HOME, 'src/other'), status: 'running' }), // different project
      s({ cwd: path.join(HOME, 'src/unrelated'), status: 'running' }), // no project
    ];
    const map = rollupSessionsByProject(defs, sessions);

    const rush = map.get('rush')!;
    expect(rush.agents).toBe(3);
    expect(rush.byStatus).toEqual({ running: 1, idle: 1, input_required: 1 });
    expect(rush.plan).toEqual({ done: 5, total: 7 });
    expect(rush.openPrs).toEqual([{ url: 'https://github.com/o/r/pull/9', number: 9 }]); // deduped
    expect(rush.tickets.sort()).toEqual(['RUSH-1', 'RUSH-2']); // deduped across worked+created
    expect(rush.worktrees).toBe(1);

    expect(map.get('other')!.agents).toBe(1);
    expect(map.has('unrelated')).toBe(false);
  });

  it('is empty when no session matches a project', () => {
    const map = rollupSessionsByProject(defs, [s({ cwd: path.join(HOME, 'elsewhere') })]);
    expect(map.size).toBe(0);
  });
});

describe('planPct', () => {
  it('rounds a percentage and returns undefined for nothing tracked', () => {
    expect(planPct({ done: 5, total: 7 })).toBe(71);
    expect(planPct({ done: 0, total: 0 })).toBeUndefined();
  });
});
