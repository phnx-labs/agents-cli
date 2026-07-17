import { describe, it, expect } from 'bun:test';
import { browserFilterToArgv, cycle, cycleWindow, type BrowserFilter } from './sessions-browser.js';

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
