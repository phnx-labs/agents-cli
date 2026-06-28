import { describe, expect, it } from 'vitest';
import { isMenubarStale } from './install-menubar.js';

// Regression guard for the upgrade self-heal: before this, the helper was only
// (re)installed when no service existed, so `npm update` left the menu bar
// running the previous release's binary. isMenubarStale is the decision that
// must flag an upgraded/missing install for reinstall.
describe('isMenubarStale', () => {
  it('is stale when the helper binary is gone (App Support cleared)', () => {
    expect(isMenubarStale({ installedVersion: '1.20.24', currentVersion: '1.20.24', execExists: false })).toBe(true);
  });

  it('is stale after an upgrade (installed version != current)', () => {
    expect(isMenubarStale({ installedVersion: '1.20.24', currentVersion: '1.20.25', execExists: true })).toBe(true);
  });

  it('is stale on a pre-stamp install (no version marker yet)', () => {
    expect(isMenubarStale({ installedVersion: null, currentVersion: '1.20.25', execExists: true })).toBe(true);
  });

  it('is NOT stale when version matches and the binary is present', () => {
    expect(isMenubarStale({ installedVersion: '1.20.25', currentVersion: '1.20.25', execExists: true })).toBe(false);
  });
});
