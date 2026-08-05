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

  it('maps timeline → feed --filter updates unless filter already set', () => {
    expect(expandObserveAlias('timeline', ['--json'])).toEqual({
      argv: ['feed', '--filter', 'updates', '--json'],
      note: expect.stringContaining('updates'),
    });
    expect(expandObserveAlias('timeline', ['--filter', 'all', '--json'])).toEqual({
      argv: ['feed', '--filter', 'all', '--json'],
      note: expect.stringContaining('timeline'),
    });
    expect(expandObserveAlias('timeline', ['--filter=needs'])).toEqual({
      argv: ['feed', '--filter=needs'],
      note: expect.stringContaining('timeline'),
    });
  });

  it('maps roster → sessions --active unless --active already set', () => {
    expect(expandObserveAlias('roster')).toEqual({
      argv: ['sessions', '--active'],
      note: expect.stringContaining('sessions --active'),
    });
    expect(expandObserveAlias('roster', ['--json', '--local'])).toEqual({
      argv: ['sessions', '--active', '--json', '--local'],
      note: expect.stringContaining('roster'),
    });
    expect(expandObserveAlias('roster', ['--active', '--waiting'])).toEqual({
      argv: ['sessions', '--active', '--waiting'],
      note: expect.stringContaining('roster'),
    });
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

  it('lists the three public observe aliases', () => {
    expect([...OBSERVE_ALIASES].sort()).toEqual(['inbox', 'roster', 'timeline']);
  });
});
