import { describe, it, expect } from 'vitest';

import {
  expandObserveAlias,
  hasFilterFlag,
  hasActiveFlag,
  OBSERVE_ALIASES,
} from './observe-aliases.js';

describe('expandObserveAlias', () => {
  it('maps inbox → feed and preserves flags', () => {
    expect(expandObserveAlias('inbox')).toEqual({
      argv: ['feed'],
      note: expect.stringContaining('feed'),
    });
    expect(expandObserveAlias('inbox', ['--json', '--project', 'rush'])).toEqual({
      argv: ['feed', '--json', '--project', 'rush'],
      note: expect.stringContaining('inbox'),
    });
  });

  it('does not expand retired roster (use sessions --active)', () => {
    expect(expandObserveAlias('roster')).toBeNull();
  });

  it('does not expand the retired timeline alias (use feed --filter updates, RUSH-2692)', () => {
    expect(expandObserveAlias('timeline')).toBeNull();
    expect(expandObserveAlias('timeline', ['--json'])).toBeNull();
  });

  it('returns null for unknown names', () => {
    expect(expandObserveAlias('feed')).toBeNull();
    expect(expandObserveAlias('audit')).toBeNull();
    expect(expandObserveAlias('')).toBeNull();
  });
});

describe('flag helpers / alias list', () => {
  it('detects --filter and --active forms', () => {
    expect(hasFilterFlag(['--filter', 'x'])).toBe(true);
    expect(hasFilterFlag(['--filter=x'])).toBe(true);
    expect(hasFilterFlag(['--json'])).toBe(false);
    expect(hasActiveFlag(['--active'])).toBe(true);
    expect(hasActiveFlag(['--json'])).toBe(false);
  });

  it('lists the public observe aliases (roster + timeline retired)', () => {
    expect([...OBSERVE_ALIASES].sort()).toEqual(['inbox']);
  });
});
