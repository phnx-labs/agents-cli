import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { getCliVersion, installLayoutFromBin } from './version.js';

describe('version', () => {
  it('getCliVersion returns a non-empty version string', () => {
    const v = getCliVersion();
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  // getCliVersionFresh's contract — "re-reads package.json, unlike the memoized
  // getCliVersion" — has NO honest unit test today, so this file ships none.
  //
  // The first two attempts both claimed to test it and could not:
  //   expect(getCliVersionFresh()).toBe(getCliVersion())   // two functions agreeing
  //   expect(getCliVersionFresh()).toBe(<independent read>) // same thing, one hop
  // Both hold for `getCliVersionFresh = () => getCliVersion()`, the exact
  // regression the contract exists to prevent, because version.ts:109 and :133
  // read the IDENTICAL hardcoded path — so with the file unchanged mid-test,
  // cached and fresh are equal by construction. Priming the memo does not help.
  //
  // A real test has to swap package.json under a running process. That needs an
  // injectable base path: the path is hardcoded, and the file is shared by every
  // parallel vitest fork, so mutating it here would corrupt other tests. Tracked
  // as RUSH-2862. A test that cannot fail is worse than an absent one — it
  // reports the contract as guarded when it is not.
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
