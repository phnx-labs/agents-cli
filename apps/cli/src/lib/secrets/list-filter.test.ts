import { describe, it, expect } from 'vitest';
import {
  parseListFilters,
  parseEnumList,
  parseSortField,
  bundleMatchesFilter,
  bundleExpiry,
  sortBundles,
  filterIsActive,
  describeFilter,
  DEFAULT_EXPIRING_DAYS,
  type SecretsListFilter,
} from './list-filter.js';
import type { SecretsBundle } from './bundles.js';

const NOW = Date.UTC(2026, 7, 3, 12, 0, 0); // 2026-08-03T12:00:00Z

/** An ISO date N days from NOW, as `expires` wants it ('YYYY-MM-DD'). */
function dateOffset(days: number): string {
  return new Date(NOW + days * 86_400_000).toISOString().slice(0, 10);
}

function bundle(over: Partial<SecretsBundle> & { name: string }): SecretsBundle {
  return { vars: {}, ...over };
}

const ctx = (held: Array<[string, number]> = []) => ({ held: new Map(held), now: NOW });

describe('parseEnumList', () => {
  it('splits, trims, lowercases, and de-dups', () => {
    expect(parseEnumList('HOLD, always ,hold', '--policy', ['always', 'hold', 'never'] as const))
      .toEqual(['hold', 'always']);
  });

  it('rejects an unknown value loudly, naming the valid set', () => {
    // A silent ignore would return every bundle, which reads as "nothing
    // matches" — the user would never learn they typo'd the flag.
    expect(() => parseEnumList('hodl', '--policy', ['always', 'hold', 'never'] as const))
      .toThrow(/Invalid value "hodl" for --policy\. Valid values: always, hold, never/);
  });

  it('rejects an empty list', () => {
    expect(() => parseEnumList(' , ', '--backend', ['keychain', 'file'] as const))
      .toThrow(/requires at least one value/);
  });
});

describe('parseListFilters', () => {
  it('is empty when nothing is passed, so an unfiltered list stays unfiltered', () => {
    const f = parseListFilters({});
    expect(filterIsActive(f)).toBe(false);
  });

  it('refuses --held with --not-held', () => {
    expect(() => parseListFilters({ held: true, notHeld: true }))
      .toThrow(/--held and --not-held are mutually exclusive/);
  });

  it('maps the held pair onto one tri-state field', () => {
    expect(parseListFilters({ held: true }).held).toBe(true);
    expect(parseListFilters({ notHeld: true }).held).toBe(false);
    expect(parseListFilters({}).held).toBeUndefined();
  });

  it('treats a bare --expiring as the default window and a value as days', () => {
    expect(parseListFilters({ expiring: true }).expiringDays).toBe(DEFAULT_EXPIRING_DAYS);
    expect(parseListFilters({ expiring: '7' }).expiringDays).toBe(7);
  });

  it('rejects a non-integer --expiring rather than silently using the default', () => {
    expect(() => parseListFilters({ expiring: 'soon' })).toThrow(/Invalid --expiring/);
    expect(() => parseListFilters({ expiring: '-3' })).toThrow(/Invalid --expiring/);
  });

  it('rejects --expiring 0, which could never match anything', () => {
    // The window is `0 <= d < N`, so N=0 excludes even a key expiring today —
    // a flag that always returns nothing, silently. Point at --expired instead.
    expect(() => parseListFilters({ expiring: '0' })).toThrow(/--expiring.*>= 1/s);
    expect(() => parseListFilters({ expiring: '0' })).toThrow(/--expired/);
  });

  it('lowercases the query so name matching is case-insensitive', () => {
    expect(parseListFilters({}, '  GitHub ').query).toBe('github');
  });
});

describe('parseSortField', () => {
  it('defaults to name — the order listBundles already returns', () => {
    expect(parseSortField(undefined)).toBe('name');
  });

  it('rejects an unknown field instead of silently falling back', () => {
    // `sessions --sort` silently falls back to timestamp; that hides a typo.
    expect(() => parseSortField('cost')).toThrow(/Invalid --sort 'cost'/);
  });
});

describe('bundleExpiry', () => {
  it('separates already-lapsed keys from ones merely coming due', () => {
    const b = bundle({
      name: 'b',
      meta: {
        DEAD: { expires: dateOffset(-10) },
        SOON: { expires: dateOffset(5) },
        FAR: { expires: dateOffset(200) },
        NONE: {},
      },
    });
    expect(bundleExpiry(b, NOW)).toEqual({ expired: 1, soon: 1 });
  });

  it('treats a key expiring today as not yet expired (end-of-day UTC)', () => {
    const b = bundle({ name: 'b', meta: { K: { expires: dateOffset(0) } } });
    expect(bundleExpiry(b, NOW)).toEqual({ expired: 0, soon: 1 });
  });

  it('honours a custom window', () => {
    const b = bundle({ name: 'b', meta: { K: { expires: dateOffset(20) } } });
    expect(bundleExpiry(b, NOW, 30).soon).toBe(1);
    expect(bundleExpiry(b, NOW, 7).soon).toBe(0);
  });
});

describe('bundleMatchesFilter', () => {
  const gh = bundle({
    name: 'github.com',
    description: 'GitHub credentials',
    backend: 'file',
    policy: 'hold',
    last_used: new Date(NOW - 200 * 86_400_000).toISOString(),
    vars: { TOKEN: 'literal-value' },
    meta: { TOKEN: { type: 'token', expires: dateOffset(-5) } },
  });
  const fleet = bundle({
    name: 'fleet',
    description: 'SSH passwords',
    policy: 'never',
    last_used: new Date(NOW - 1 * 86_400_000).toISOString(),
    vars: { KEY: 'keychain:KEY' },
    meta: { KEY: { type: 'ssh-key' } },
  });

  const matches = (f: SecretsListFilter, c = ctx()) =>
    [gh, fleet].filter((b) => bundleMatchesFilter(b, f, c)).map((b) => b.name);

  it('matches name and description, case-insensitively', () => {
    expect(matches({ query: 'github' })).toEqual(['github.com']);
    expect(matches({ query: 'ssh passwords' })).toEqual(['fleet']);
  });

  it('narrows by policy — the never audit', () => {
    expect(matches({ policy: ['never'] })).toEqual(['fleet']);
  });

  it('treats an absent backend as keychain, the documented default', () => {
    expect(matches({ backend: ['keychain'] })).toEqual(['fleet']);
    expect(matches({ backend: ['file'] })).toEqual(['github.com']);
  });

  it('narrows by key type and by ref kind', () => {
    expect(matches({ type: ['ssh-key'] })).toEqual(['fleet']);
    expect(matches({ kind: ['literal'] })).toEqual(['github.com']);
    expect(matches({ kind: ['keychain'] })).toEqual(['fleet']);
  });

  it('finds already-expired keys — the case the EXPIRING column used to hide', () => {
    expect(matches({ expired: true })).toEqual(['github.com']);
  });

  it('does not confuse expired with expiring', () => {
    // gh's only key lapsed 5 days ago, so it is expired but NOT coming due.
    expect(matches({ expiringDays: 30 })).toEqual([]);
  });

  it('uses live broker state for held, and treats a lapsed entry as not held', () => {
    const live = ctx([['github.com', NOW + 86_400_000]]);
    expect(matches({ held: true }, live)).toEqual(['github.com']);
    expect(matches({ held: false }, live)).toEqual(['fleet']);
    const stale = ctx([['github.com', NOW - 1000]]);
    expect(matches({ held: true }, stale)).toEqual([]);
  });

  it('matches never-used bundles under --unused, not just old ones', () => {
    const fresh = bundle({ name: 'fresh', vars: {} }); // no last_used at all
    const cutoff = NOW - 90 * 86_400_000;
    expect(bundleMatchesFilter(fresh, { unusedBefore: cutoff }, ctx())).toBe(true);
    expect(bundleMatchesFilter(gh, { unusedBefore: cutoff }, ctx())).toBe(true);   // 200d ago
    expect(bundleMatchesFilter(fleet, { unusedBefore: cutoff }, ctx())).toBe(false); // 1d ago
  });

  it('ANDs --expired with --expiring, so together they mean "both", not "either"', () => {
    // Deliberate, and worth pinning because the EXPIRING *column* sums the two
    // (it shows expired + soon), so the column reads as OR while the flags AND.
    // gh has a lapsed key and nothing upcoming.
    expect(matches({ expired: true })).toEqual(['github.com']);
    expect(matches({ expired: true, expiringDays: 30 })).toEqual([]);
  });

  it('ANDs every axis — each added flag narrows further', () => {
    expect(matches({ policy: ['hold'], backend: ['file'] })).toEqual(['github.com']);
    // Same policy, a backend it isn't on — the intersection is empty.
    expect(matches({ policy: ['hold'], backend: ['vault'] })).toEqual([]);
  });
});

describe('sortBundles', () => {
  const a = bundle({ name: 'alpha', last_used: '2026-01-01T00:00:00Z', meta: { K: { expires: '2030-01-01' } } });
  const z = bundle({ name: 'zeta', last_used: '2026-06-01T00:00:00Z', meta: { K: { expires: '2027-01-01' } } });
  const n = bundle({ name: 'nada' }); // no timestamps, no expiry

  it('sorts by name by default', () => {
    expect(sortBundles([z, n, a], 'name').map((b) => b.name)).toEqual(['alpha', 'nada', 'zeta']);
  });

  it('sorts most-recently-used first, and never-used last', () => {
    expect(sortBundles([a, n, z], 'used').map((b) => b.name)).toEqual(['zeta', 'alpha', 'nada']);
  });

  it('sorts soonest-expiry first and puts never-expiring bundles last', () => {
    expect(sortBundles([a, n, z], 'expiry').map((b) => b.name)).toEqual(['zeta', 'alpha', 'nada']);
  });

  it('does not mutate the input', () => {
    const input = [z, a];
    sortBundles(input, 'name');
    expect(input.map((b) => b.name)).toEqual(['zeta', 'alpha']);
  });
});

describe('describeFilter', () => {
  it('names every active axis so an empty result explains itself', () => {
    const f = parseListFilters({ policy: 'never', expired: true }, 'gh');
    const text = describeFilter(f);
    expect(text).toContain('matching "gh"');
    expect(text).toContain('policy never');
    expect(text).toContain('with an expired key');
  });
});
