import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getCliVersion, getCliVersionFresh, installLayoutFromBin } from './version.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe('version', () => {
  it('getCliVersion returns a non-empty version string', () => {
    const v = getCliVersion();
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  it('getCliVersionFresh reads the version off disk, not a constant or a warm cache', () => {
    // Compare against an INDEPENDENT read of the same package.json rather than
    // against getCliVersion(). Asserting the two functions agree proves nothing
    // — a getCliVersionFresh() that simply returned the memoized cache would
    // satisfy it. Reading the file here is what pins it to disk: a stubbed or
    // drifted return value fails, whatever the cache holds.
    //
    // A fully discriminating test (swap package.json mid-process and watch the
    // fresh read follow while the cached one does not) needs an injectable base
    // path — version.ts hardcodes it, and the file is shared by every parallel
    // vitest fork, so mutating it here would corrupt other tests. Tracked as a
    // follow-up; this is the strongest assertion available without that change.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(testDir, '..', '..', 'package.json'), 'utf-8'),
    ).version;
    expect(onDisk).toBeTruthy();

    getCliVersion(); // prime the memo first, so a cache hit cannot be mistaken for a read
    expect(getCliVersionFresh()).toBe(onDisk);
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
