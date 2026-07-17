import { describe, it, expect } from 'vitest';
import {
  browserFilterToArgv,
  cycle,
  cycleWindow,
  sessionMatchesQuery,
  normalizeDeviceSeed,
  activeBrowserSeed,
  bareBrowserSeed,
  type BrowserFilter,
} from './sessions-browser.js';
import type { SessionMeta } from '../lib/session/types.js';

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
