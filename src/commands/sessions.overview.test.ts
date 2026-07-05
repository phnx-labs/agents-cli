import { describe, it, expect } from 'vitest';
import { overviewProjectKey, buildOverviewGroups } from './sessions.js';
import type { SessionMeta } from '../lib/session/types.js';

function s(id: string, project: string | undefined, timestamp: string, cwd?: string): SessionMeta {
  return { id, shortId: id.slice(0, 8), agent: 'claude', timestamp, project, cwd, filePath: '' } as SessionMeta;
}

describe('overviewProjectKey', () => {
  it('prefers the indexed project name', () => {
    expect(overviewProjectKey({ project: 'agents-cli', cwd: '/anything' })).toBe('agents-cli');
  });

  it('folds a worktree path back to its repo', () => {
    expect(overviewProjectKey({ project: undefined, cwd: '/home/me/src/swarmify/.agents/worktrees/floor-redesign' })).toBe('swarmify');
  });

  it('falls back to the leaf dir for a monorepo subdir with no project', () => {
    // A monorepo subdir with no indexed project name groups by its leaf dir — the
    // customizable path->project mapping is a separate follow-up.
    expect(overviewProjectKey({ project: undefined, cwd: '/home/me/src/agents/prix/api' })).toBe('api');
  });

  it('returns a sentinel for an empty cwd and no project', () => {
    expect(overviewProjectKey({ project: undefined, cwd: '' })).toBe('(no project)');
    expect(overviewProjectKey({ project: '  ', cwd: undefined })).toBe('(no project)');
  });
});

describe('buildOverviewGroups', () => {
  // Pool is recency-descending, as discoverSessions returns it.
  const pool: SessionMeta[] = [
    s('a1', 'agents-cli', '2026-07-04T10:00:05.000Z'),
    s('b1', 'swarmify', '2026-07-04T10:00:04.000Z'),
    s('a2', 'agents-cli', '2026-07-04T10:00:03.000Z'),
    s('c1', 'rush', '2026-07-04T10:00:02.000Z'),
    s('a3', 'agents-cli', '2026-07-04T10:00:01.000Z'),
  ];

  it('groups by project with accurate per-project totals (cap not exceeded)', () => {
    const { groups, projectCount } = buildOverviewGroups(pool, 5);
    expect(projectCount).toBe(3);
    const cli = groups.find((g) => g.key === 'agents-cli')!;
    expect(cli.total).toBe(3);
    expect(cli.shown.map((x) => x.id)).toEqual(['a1', 'a2', 'a3']);
    expect(cli.more).toBe(0);
  });

  it('orders groups by most-recent activity, NOT by count', () => {
    // 'newproj' has one very recent session; 'bigproj' has three older ones.
    const p: SessionMeta[] = [
      s('x', 'newproj', '2026-07-04T09:00:09.000Z'),
      s('g1', 'bigproj', '2026-07-04T09:00:08.000Z'),
      s('g2', 'bigproj', '2026-07-04T09:00:07.000Z'),
      s('g3', 'bigproj', '2026-07-04T09:00:06.000Z'),
    ];
    const { groups } = buildOverviewGroups(p, 4);
    expect(groups.map((g) => g.key)).toEqual(['newproj', 'bigproj']);
  });

  it('caps rows per project and rolls the rest into "more"', () => {
    // cap 1 → each project shows only its most-recent row; every project still appears.
    const { groups } = buildOverviewGroups(pool, 1);
    expect(groups.map((g) => g.key)).toEqual(['agents-cli', 'swarmify', 'rush']); // recency order
    const cli = groups.find((g) => g.key === 'agents-cli')!;
    expect(cli.shown.map((x) => x.id)).toEqual(['a1']); // most-recent only
    expect(cli.total).toBe(3);
    expect(cli.more).toBe(2); // a2, a3 rolled into "more"
    const rush = groups.find((g) => g.key === 'rush')!;
    expect(rush.shown.map((x) => x.id)).toEqual(['c1']);
    expect(rush.more).toBe(0);
  });

  it('expands every row when the cap is Infinity', () => {
    const { groups } = buildOverviewGroups(pool, Infinity);
    const cli = groups.find((g) => g.key === 'agents-cli')!;
    expect(cli.shown).toHaveLength(3);
    expect(cli.more).toBe(0);
  });
});
