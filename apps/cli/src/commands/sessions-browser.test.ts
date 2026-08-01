import { describe, it, expect } from 'vitest';
import {
  browserFilterToArgv,
  cycle,
  cycleWindow,
  sessionMatchesQuery,
  normalizeDeviceSeed,
  activeBrowserSeed,
  bareBrowserSeed,
  liveRowKey,
  indexLiveRows,
  liveSessionToMeta,
  mergeLiveIntoPool,
  type BrowserFilter,
} from './sessions-browser.js';
import { liveHostLabel } from './sessions.js';
import type { SessionMeta } from '../lib/session/types.js';
import type { ActiveSession } from '../lib/session/active.js';

const row = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 'x',
    shortId: 'a1b2c3d4',
    agent: 'claude',
    timestamp: '2026-07-16T00:00:00Z',
    filePath: '/tmp/x.jsonl',
    project: 'my-app',
    topic: "Review Taylor's PRs and release",
    ...over,
  }) as SessionMeta;

const base: BrowserFilter = {
  running: false,
  teams: false,
  agent: undefined,
  device: undefined,
  projectScope: 'repo',
  window: undefined,
};

describe('browserFilterToArgv — the human↔agent contract', () => {
  it('an empty repo-scoped filter is just `sessions`', () => {
    // projectScope 'repo' is the default view, so it emits no flag.
    expect(browserFilterToArgv(base)).toEqual(['sessions']);
  });

  it('running-only maps to --active', () => {
    expect(browserFilterToArgv({ ...base, running: true })).toEqual(['sessions', '--active']);
  });

  it('all-dirs scope maps to --all; repo scope emits nothing', () => {
    expect(browserFilterToArgv({ ...base, projectScope: 'all' })).toEqual(['sessions', '--all']);
    expect(browserFilterToArgv({ ...base, projectScope: 'repo' })).toEqual(['sessions']);
  });

  it('stacks every dimension in a stable, reproducible order', () => {
    const f: BrowserFilter = {
      running: true,
      teams: true,
      agent: 'claude',
      device: 'zion',
      projectScope: 'all',
      window: '7d',
    };
    expect(browserFilterToArgv(f)).toEqual([
      'sessions',
      '--active',
      '--teams',
      '-a',
      'claude',
      '--device',
      'zion',
      '--all',
      '--since',
      '7d',
    ]);
  });

  it('appends a search query as a quoted positional', () => {
    expect(browserFilterToArgv({ ...base, agent: 'codex' }, 'auth bug')).toEqual([
      'sessions',
      '-a',
      'codex',
      '"auth bug"',
    ]);
  });

  it('ignores a blank query', () => {
    expect(browserFilterToArgv(base, '   ')).toEqual(['sessions']);
  });
});

describe('cycle — [none, ...options] wrapping for A/D hotkeys', () => {
  it('none → first → … → last → none', () => {
    const opts = ['claude', 'codex', 'droid'];
    expect(cycle(undefined, opts)).toBe('claude');
    expect(cycle('claude', opts)).toBe('codex');
    expect(cycle('droid', opts)).toBeUndefined(); // wraps back to "all"
  });

  it('a value no longer in the pool restarts at the first option', () => {
    // findIndex returns -1 → (-1 + 1) % len === 0 → first entry (undefined).
    expect(cycle('gone', ['claude'])).toBeUndefined();
  });

  it('an empty pool always yields none', () => {
    expect(cycle(undefined, [])).toBeUndefined();
  });
});

describe('cycleWindow — W hotkey', () => {
  it('cycles all → 1d → 7d → 30d → all', () => {
    expect(cycleWindow(undefined)).toBe('1d');
    expect(cycleWindow('1d')).toBe('7d');
    expect(cycleWindow('7d')).toBe('30d');
    expect(cycleWindow('30d')).toBeUndefined();
  });
});

describe('activeBrowserSeed — the --active call-site filter (fleet-wide)', () => {
  it('is fleet-wide (projectScope all), not repo-scoped', () => {
    // The static --active is fleet-wide; the interactive one must match, else
    // `sessions --active` silently narrows to the current directory.
    expect(activeBrowserSeed({}).projectScope).toBe('all');
  });

  it('is running-only and defaults the window to 30d', () => {
    const f = activeBrowserSeed({});
    expect(f.running).toBe(true);
    expect(f.window).toBe('30d');
  });

  it('seeds the window from --since', () => {
    expect(activeBrowserSeed({ since: '2h' }).window).toBe('2h');
  });

  it('normalizes a user@host / FQDN device seed to the canonical machine id', () => {
    expect(activeBrowserSeed({ host: ['muqsit@mac-mini.local'] }).device).toBe('mac-mini');
    expect(activeBrowserSeed({ host: ['YOSEMITE-S1'] }).device).toBe('yosemite-s1');
    expect(activeBrowserSeed({}).device).toBeUndefined();
  });
});

describe('bareBrowserSeed — the bare-listing call-site filter', () => {
  it('defaults to this-repo scope, widens to all dirs with --all', () => {
    expect(bareBrowserSeed({}).projectScope).toBe('repo');
    expect(bareBrowserSeed({ all: true }).projectScope).toBe('all');
  });

  it('is not running-only and seeds the window from --since', () => {
    expect(bareBrowserSeed({}).running).toBeUndefined();
    expect(bareBrowserSeed({ since: '7d' }).window).toBe('7d');
  });
});

describe('normalizeDeviceSeed — canonical .machine form', () => {
  it('strips user@ and domain, lowercases', () => {
    expect(normalizeDeviceSeed('user@Zion.local')).toBe('zion');
    expect(normalizeDeviceSeed('mac-mini')).toBe('mac-mini');
    expect(normalizeDeviceSeed(undefined)).toBeUndefined();
  });
});

describe('sessionMatchesQuery — the S search predicate (cheap, not FTS)', () => {
  it('empty query matches everything', () => {
    expect(sessionMatchesQuery(row(), '')).toBe(true);
    expect(sessionMatchesQuery(row(), '   ')).toBe(true);
  });

  it('matches case-insensitively across topic / project / id', () => {
    expect(sessionMatchesQuery(row(), 'taylor')).toBe(true); // topic
    expect(sessionMatchesQuery(row(), 'MY-APP')).toBe(true); // project
    expect(sessionMatchesQuery(row(), 'a1b2')).toBe(true); // shortId prefix
  });

  it('requires every whitespace-separated term (AND)', () => {
    expect(sessionMatchesQuery(row(), 'taylor release')).toBe(true);
    expect(sessionMatchesQuery(row(), 'taylor nope')).toBe(false);
  });

  it('non-matching query excludes the row', () => {
    expect(sessionMatchesQuery(row(), 'zzzznomatch')).toBe(false);
  });

  it('matches the ticket/PR ref', () => {
    expect(sessionMatchesQuery(row({ prNumber: 1248 }), 'pr#1248')).toBe(true);
  });
});

/**
 * The running filter used to be a pure intersection with the transcript pool
 * (`pool.filter(r => live.has(r.id))`) fed by a LOCAL-ONLY live scan. Both
 * halves hid real sessions: `agents sessions --active --json` listed 32 live
 * sessions across 7 machines while the browser showed 4. These pin the union
 * semantics that replaced it.
 */
const live = (over: Partial<ActiveSession> = {}): ActiveSession =>
  ({
    context: 'terminal',
    kind: 'claude',
    status: 'running',
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    cwd: '/home/muqsit/src/app',
    ...over,
  }) as ActiveSession;

describe('liveRowKey — the join key between the live scan and the pool', () => {
  it('keys on the session id so a live row and its transcript row collapse', () => {
    expect(liveRowKey(live(), 'zion')).toBe('aaaaaaaa-1111-2222-3333-444444444444');
  });

  it('falls back to machine+pid so an id-less live agent still gets one row', () => {
    expect(liveRowKey(live({ sessionId: undefined, machine: 'yosemite-s0', pid: 4242 }), 'zion'))
      .toBe('live:yosemite-s0:4242');
  });

  it('attributes an untagged live row to the local machine', () => {
    expect(liveRowKey(live({ sessionId: undefined, pid: 7 }), 'zion')).toBe('live:zion:7');
  });

  it('keys a pid-less cloud task on its task id so two never collapse into one row', () => {
    const a = live({ sessionId: undefined, pid: undefined, context: 'cloud', cloudTaskId: 'task-a' });
    const b = live({ sessionId: undefined, pid: undefined, context: 'cloud', cloudTaskId: 'task-b' });
    expect(liveRowKey(a, 'zion')).not.toBe(liveRowKey(b, 'zion'));
    expect(indexLiveRows([a, b], 'zion').size).toBe(2);
  });
});

describe('mergeLiveIntoPool — running is a SOURCE of rows, not an intersection', () => {
  it("adds a peer's live session the local transcript pool does not carry", () => {
    const rows = [row({ id: 'local-1', machine: 'zion' })];
    const remote = live({ sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', machine: 'yosemite-s0' });
    const merged = mergeLiveIntoPool(rows, indexLiveRows([remote], 'zion'), 'zion');
    expect(merged.map((r) => r.id)).toContain('bbbbbbbb-1111-2222-3333-444444444444');
    expect(merged).toHaveLength(2);
  });

  it('does not duplicate a live session already in the pool', () => {
    const rows = [row({ id: 'aaaaaaaa-1111-2222-3333-444444444444' })];
    const merged = mergeLiveIntoPool(rows, indexLiveRows([live()], 'zion'), 'zion');
    expect(merged).toHaveLength(1);
    // The pool row wins — it carries the indexed transcript metadata.
    expect(merged[0].filePath).toBe('/tmp/x.jsonl');
  });

  it('names an id-less process row by a pid short enough for the id column', () => {
    // 9 chars max: `p:` + a 7-digit Linux pid. The old `pid:` prefix overflowed
    // the 10-wide id column and cost the real pid its last digits.
    const meta = liveSessionToMeta(live({ sessionId: undefined, pid: 2813139 }), 'zion');
    expect(meta.shortId).toBe('p:2813139');
    expect(meta.shortId.length).toBeLessThanOrEqual(9);
  });

  it('keeps an id-less live session instead of dropping it', () => {
    const merged = mergeLiveIntoPool([], indexLiveRows([live({ sessionId: undefined, pid: 99 })], 'zion'), 'zion');
    expect(merged).toHaveLength(1);
    expect(merged[0].shortId).toBe('p:99');
  });

  it('leaves the pool untouched when nothing live is missing from it', () => {
    const rows = [row({ id: 'local-1' })];
    expect(mergeLiveIntoPool(rows, new Map(), 'zion')).toBe(rows);
  });
});

describe('liveSessionToMeta — the projected row', () => {
  it("marks a peer's session remote so read/resume hops back over SSH", () => {
    const meta = liveSessionToMeta(live({ machine: 'yosemite-s0' }), 'zion');
    expect(meta._remote).toBe(true);
    expect(meta.machine).toBe('yosemite-s0');
  });

  it('does not mark a local session remote', () => {
    expect(liveSessionToMeta(live({ machine: 'zion' }), 'zion')._remote).toBe(false);
  });

  it('carries the refs and cwd-derived project the picker columns render', () => {
    const meta = liveSessionToMeta(
      live({ pr: { url: 'https://github.com/o/r/pull/12', number: 12 }, ticket: { id: 'RUSH-1' } }),
      'zion',
    );
    expect(meta.project).toBe('app');
    expect(meta.prNumber).toBe(12);
    expect(meta.ticketId).toBe('RUSH-1');
  });

  it('keeps an untracked agent kind off the typed agent field', () => {
    expect(liveSessionToMeta(live({ kind: 'cursor-agent' }), 'zion').agent).toBe('claude');
  });

  it('leaves filePath empty when the scan resolved no transcript', () => {
    expect(liveSessionToMeta(live({ sessionFile: undefined }), 'zion').filePath).toBe('');
  });

  it('flattens a multi-line live topic so it cannot break the row layout', () => {
    const meta = liveSessionToMeta(live({ topic: 'refactor the parser\nsecond line' }), 'zion');
    expect(meta.topic).not.toContain('\n');
    expect(meta.topic).toContain('refactor the parser');
  });
});

describe('liveHostLabel — which program the session runs in', () => {
  it('names the host app for an editor-hosted session', () => {
    expect(liveHostLabel(live({ host: 'codium' }))).toBe('codium');
  });

  it('names both when a tmux session is being watched through another app', () => {
    expect(liveHostLabel(live({ host: 'tmux', viewingIn: { app: 'ghostty', tab: 2 } }))).toBe('tmux→ghostty');
  });

  it('stays a bare tmux when no client is attached (running detached)', () => {
    expect(liveHostLabel(live({ host: 'tmux' }))).toBe('tmux');
  });

  it('is empty when the host could not be resolved', () => {
    expect(liveHostLabel(live({ host: undefined }))).toBe('');
    expect(liveHostLabel(undefined)).toBe('');
  });
});
