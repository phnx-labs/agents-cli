import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rollupSessionsByProject, planPct, enrichProjectSignals } from './project-status.js';
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

describe('enrichProjectSignals — artifact counting from the activity log', () => {
  let actDir: string;
  const NOW = 1_754_000_000_000; // fixed epoch so window math is deterministic
  const def: ProjectDef = { name: 'rush', root: '~/src/rush' }; // no repo → gh skipped

  beforeEach(() => {
    actDir = fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));
  });
  afterEach(() => fs.rmSync(actDir, { recursive: true, force: true }));

  const ev = (tsMs: number, cwd: string, detail: string) =>
    JSON.stringify({
      v: 1,
      ts: new Date(tsMs).toISOString(),
      event: 'artifact.created',
      tier: 'milestone',
      sessionId: 's1',
      cwd,
      detail,
    });

  it('counts only this project’s in-window artifacts, newest detail surfaced', async () => {
    const inWin = NOW - 2 * 86_400_000; // 2 days ago
    const newest = NOW - 3600_000; // 1h ago
    const outWin = NOW - 30 * 86_400_000; // 30 days ago
    const rushCwd = path.join(HOME, 'src/rush/apps/web');
    fs.writeFileSync(
      path.join(actDir, 's1.jsonl'),
      [
        ev(inWin, rushCwd, 'a.html'),
        ev(newest, rushCwd, 'newest.html'),
        ev(outWin, rushCwd, 'old.html'), // outside 7d window
        ev(inWin, path.join(HOME, 'src/other'), 'other.html'), // different project
      ].join('\n') + '\n',
    );

    const sig = await enrichProjectSignals(def, 7, NOW, { activityRoot: actDir, skipRemote: true });
    expect(sig.artifacts).toBe(2); // a.html + newest.html; old.html and other.html excluded
    expect(sig.lastArtifact).toBe('newest.html');
    expect(sig.mergedPrs).toBe(0); // no repo / skipRemote
    expect(sig.windowDays).toBe(7);
  });

  it('is zero when nothing matches, and never throws on a missing log dir', async () => {
    const sig = await enrichProjectSignals(def, 7, NOW, {
      activityRoot: path.join(actDir, 'nope'),
      skipRemote: true,
    });
    expect(sig.artifacts).toBe(0);
    expect(sig.lastArtifact).toBeUndefined();
  });
});
