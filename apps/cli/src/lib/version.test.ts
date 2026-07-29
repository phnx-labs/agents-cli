import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { getCliVersion, getCliVersionFresh, installLayoutFromBin } from './version.js';

describe('version', () => {
  it('getCliVersion returns a non-empty version string', () => {
    const v = getCliVersion();
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  it('getCliVersionFresh re-reads package.json and matches getCliVersion when unchanged', () => {
    // Both read the same on-disk package.json; with no in-place swap mid-test
    // they must agree. (In production they diverge only after `npm i -g` swaps
    // the file under a running process — the signal the broker/daemon heal on.)
    expect(getCliVersionFresh()).toBe(getCliVersion());
  });

  it('getCliVersionFresh is not the memoized cache (callable repeatedly, stable)', () => {
    const a = getCliVersionFresh();
    const b = getCliVersionFresh();
    expect(a).toBe(b);
    expect(a).not.toBe('');
  });
});

// Regression guard for the Bun single-file binary: `import.meta.url` is a virtual
// `/$bunfs/` path there, so version + menu-bar-bundle resolution must fall back to
// the on-disk install found via the `agents` launcher symlink. This locks the
// dirname chain (`<pkg>/dist/bin/agents` -> `<pkg>/dist`) that the fallback rides.
describe('installLayoutFromBin', () => {
  it('derives dist/, entry, and package.json from an nvm launcher path', () => {
    const bin =
      '/Users/me/.nvm/versions/node/v24.15.0/lib/node_modules/@phnx-labs/agents-cli/dist/bin/agents';
    const pkg = '/Users/me/.nvm/versions/node/v24.15.0/lib/node_modules/@phnx-labs/agents-cli';
    // distDir rides path.dirname, which preserves the input's separators, but
    // entry/pkgJson ride path.join, which emits native ones — so derive the
    // expectations the same way rather than hardcoding POSIX.
    expect(installLayoutFromBin(bin)).toEqual({
      distDir: `${pkg}/dist`,
      entryPath: path.join(`${pkg}/dist`, 'index.js'),
      pkgJsonPath: path.join(`${pkg}/dist`, '..', 'package.json'),
    });
  });

  it('derives the layout from a bun-global launcher path', () => {
    const bin = '/Users/me/.bun/install/global/node_modules/@phnx-labs/agents-cli/dist/bin/agents';
    const pkg = '/Users/me/.bun/install/global/node_modules/@phnx-labs/agents-cli';
    expect(installLayoutFromBin(bin)).toEqual({
      distDir: `${pkg}/dist`,
      entryPath: path.join(`${pkg}/dist`, 'index.js'),
      pkgJsonPath: path.join(`${pkg}/dist`, '..', 'package.json'),
    });
  });
});
