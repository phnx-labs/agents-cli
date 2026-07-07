import { describe, expect, it } from 'vitest';
import { isMenubarStale, menubarPlistNeedsRepoint } from './install-menubar.js';

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

// Regression guard for the DUAL-INSTALL skew: the plist was baked by one install
// (e.g. nvm) but the user's `agents` now resolves to another (e.g. bun), so the
// helper kept shelling a stale copy for menu data + the quick-issue dispatch. A
// version bump can't catch this (the copies can even be the same version), so
// the re-point keys off the plist's baked interpreter/entry vs the active one.
describe('menubarPlistNeedsRepoint', () => {
  const nvm = '/Users/me/.nvm/versions/node/v24/lib/node_modules/@phnx-labs/agents-cli/dist/index.js';
  const bun = '/Users/me/.bun/install/global/node_modules/@phnx-labs/agents-cli/dist/index.js';
  const nvmNode = '/Users/me/.nvm/versions/node/v24/bin/node';
  const bunNode = '/Users/me/.bun/bin/node';

  it('re-points when the plist entry differs from the active install', () => {
    expect(menubarPlistNeedsRepoint({ plistEntry: nvm, plistNode: nvmNode, activeEntry: bun, activeNode: bunNode })).toBe(true);
  });

  it('re-points when only the node interpreter drifted (same entry path)', () => {
    expect(menubarPlistNeedsRepoint({ plistEntry: bun, plistNode: nvmNode, activeEntry: bun, activeNode: bunNode })).toBe(true);
  });

  it('does NOT re-point when the plist already matches the active install', () => {
    expect(menubarPlistNeedsRepoint({ plistEntry: bun, plistNode: bunNode, activeEntry: bun, activeNode: bunNode })).toBe(false);
  });

  it('does NOT re-point (churn) when the active entry cannot be resolved (dev/tsx run)', () => {
    expect(menubarPlistNeedsRepoint({ plistEntry: bun, plistNode: bunNode, activeEntry: null, activeNode: null })).toBe(false);
  });

  it('re-points a plist that has no baked entry yet (older install)', () => {
    expect(menubarPlistNeedsRepoint({ plistEntry: null, plistNode: null, activeEntry: bun, activeNode: bunNode })).toBe(true);
  });
});
