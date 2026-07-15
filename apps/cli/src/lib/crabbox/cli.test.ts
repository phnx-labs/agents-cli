import { describe, it, expect } from 'vitest';
import { isReapSafe, reapSafeOrphans, REAP_MIN_IDLE_SECS, type CrabboxBox } from './cli.js';

const NOW = 1_800_000_000; // fixed "now" in unix seconds

function box(over: Partial<CrabboxBox> = {}): CrabboxBox {
  return {
    name: 'crabbox-x',
    status: 'running',
    slug: 'x',
    lease: 'cbx_x',
    state: 'ready',
    ready: true,
    keep: true,
    createdAt: NOW - 10_000,
    expiresAt: NOW - 8_000, // expired by default
    lastTouchedAt: NOW - REAP_MIN_IDLE_SECS - 100, // stale by default
    idleTimeoutSecs: 1800,
    ...over,
  };
}

describe('isReapSafe', () => {
  it('reaps a genuine orphan: expired lease AND stale touch', () => {
    expect(isReapSafe(box(), NOW)).toBe(true);
  });

  it('never reaps a box touched within the safety window (TOCTOU guard)', () => {
    // Expired lease, but touched 1 minute ago → a concurrent run may be using it.
    expect(isReapSafe(box({ lastTouchedAt: NOW - 60 }), NOW)).toBe(false);
  });

  it('never reaps a box whose lease has not expired', () => {
    expect(isReapSafe(box({ expiresAt: NOW + 1_000 }), NOW)).toBe(false);
  });

  it('honors max(2×idleTimeout, 1h): a long idle-timeout widens the window', () => {
    // idleTimeout 40m → window = 80m. Touched 70m ago is still inside it.
    const b = box({ idleTimeoutSecs: 2400, lastTouchedAt: NOW - 70 * 60 });
    expect(isReapSafe(b, NOW)).toBe(false);
    // Touched 90m ago is outside the 80m window.
    expect(isReapSafe(box({ idleTimeoutSecs: 2400, lastTouchedAt: NOW - 90 * 60 }), NOW)).toBe(true);
  });

  it('never reaps a box with unknown age (null expiresAt or lastTouchedAt)', () => {
    expect(isReapSafe(box({ expiresAt: null }), NOW)).toBe(false);
    expect(isReapSafe(box({ lastTouchedAt: null }), NOW)).toBe(false);
  });
});

describe('reapSafeOrphans', () => {
  it('filters to orphans and sorts most-stale first', () => {
    const fresh = box({ slug: 'fresh', lastTouchedAt: NOW - 30 });          // in use
    const active = box({ slug: 'active', expiresAt: NOW + 500 });           // lease live
    const oldOrphan = box({ slug: 'old', lastTouchedAt: NOW - 100_000 });
    const newOrphan = box({ slug: 'new', lastTouchedAt: NOW - REAP_MIN_IDLE_SECS - 10 });
    const out = reapSafeOrphans([fresh, active, newOrphan, oldOrphan], NOW);
    expect(out.map((b) => b.slug)).toEqual(['old', 'new']); // oldest touch first, in-use/active excluded
  });

  it('returns empty when nothing is reap-safe', () => {
    expect(reapSafeOrphans([box({ expiresAt: NOW + 1 })], NOW)).toEqual([]);
  });
});
