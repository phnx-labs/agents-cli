/**
 * Regression: `secrets list` on a headless Linux box listed every bundle twice.
 *
 * When the Secret Service collection is locked, the Linux backend transparently
 * routes to the encrypted-file store (linux.ts). `listBundles()` enumerates the
 * keychain store AND the file store — but under that fallback BOTH enumerations
 * read the same file store, so `listKeychainItems()` returned the file items
 * (mislabeled `keychain`) and the direct file enumeration returned the same
 * items again (labeled `[file]`). Every file-backed bundle appeared twice.
 *
 * The fix: `listBundles()` skips the keychain enumeration when the keychain
 * backend is in the file fallback (keychainUsesFileFallback()), because the file
 * enumeration already covers every bundle exactly once.
 *
 * Linux-only: the double-count is specific to the Linux `secret-tool` fallback.
 * On macOS/Windows the platform branch isn't taken, so the scenario can't occur;
 * CI runs this suite on Linux.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listBundles, writeBundle, type SecretsBundle } from '../bundles.js';
import { _resetForTest as resetLinux } from '../linux.js';
import { keychainUsesFileFallback, setKeychainBackendForTest } from '../index.js';

const PASS = 'fallback-passphrase';
let tmpDir: string;

const linuxOnly = process.platform === 'linux' ? describe : describe.skip;

linuxOnly('listBundles under the Linux file fallback', () => {
  beforeEach(() => {
    // No injected keychain backend: keychainUsesFileFallback() must consult the
    // real Linux path, not be short-circuited by a test backend.
    setKeychainBackendForTest(null);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-linux-fallback-'));
    process.env.AGENTS_SECRETS_PASSPHRASE = PASS;
    // Force the locked-collection fallback and point the file store at tmp.
    resetLinux({ fileDir: tmpDir, forceFileFallback: true, passphrase: PASS });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    resetLinux();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports that the keychain backend is routing to the file store', () => {
    expect(keychainUsesFileFallback()).toBe(true);
  });

  it('lists each file-backed bundle exactly once (no keychain/[file] double)', () => {
    const names = ['alpha', 'bravo', 'charlie'];
    for (const name of names) {
      const b: SecretsBundle = { name, backend: 'file', vars: { A: 'x' } };
      writeBundle(b);
    }

    const listed = listBundles();
    const listedNames = listed.map((b) => b.name).sort();

    // Exactly one row per bundle — the pre-fix bug produced two rows each.
    expect(listedNames).toEqual([...names].sort());
    expect(listed).toHaveLength(names.length);

    // Every row is correctly attributed to the file store, not mislabeled
    // `keychain` (which would render without the `[file]` tag).
    for (const b of listed) {
      expect(b.backend).toBe('file');
    }
  });
});
