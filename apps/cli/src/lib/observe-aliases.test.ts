import { describe, it, expect } from 'vitest';

import {
  expandObserveAlias,
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

  it('returns null for the removed timeline alias (RUSH-2692)', () => {
    expect(expandObserveAlias('timeline')).toBeNull();
    expect(expandObserveAlias('timeline', ['--json'])).toBeNull();
  });
});

describe('flag helpers / alias list', () => {
  it('detects the --active form', () => {
    expect(hasActiveFlag(['--active'])).toBe(true);
    expect(hasActiveFlag(['--json'])).toBe(false);
  });

  it('lists the two public observe aliases', () => {
    expect([...OBSERVE_ALIASES].sort()).toEqual(['inbox', 'roster']);
  });
});
