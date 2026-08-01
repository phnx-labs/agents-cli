/**
 * Regression for the lost-passphrase dead end.
 *
 * A file-backed bundle whose passphrase is gone cannot be decrypted — expected.
 * The bug was that EVERY verb touching that name first called `readBundle()`:
 * `view` (bundles.ts), `add`, `delete`, and both `import --from icloud` and
 * `import --from 1password` (via `resolveImportBundle`). So the bundle could not
 * be viewed, replaced, recovered from a valid iCloud/1Password copy, OR deleted
 * — the name was permanently bricked, and the CLI's own error text pointed at
 * `import --from icloud`, which failed the same way.
 *
 * Deletion needs no plaintext, so it is the way out. This pins that
 * `readBundleIfDecryptable` reports the unreadable state instead of throwing,
 * and that `deleteBundle` clears the name with the passphrase still lost.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  bundleExists,
  deleteBundle,
  readBundle,
  readBundleIfDecryptable,
  writeBundle,
} from './bundles.js';
import { _resetFileStoreForTest } from './filestore.js';
import { setKeychainBackendForTest } from './index.js';

const NAME = 'unreadable-fixture.test';
let dir: string;
let prevBackend: ReturnType<typeof setKeychainBackendForTest>;
let prevPassphrase: string | undefined;

/**
 * Point the store at `phrase`. On macOS `assertFileBackendUsable` gates on the
 * env var, and the key is derived from it — so setting it here is what makes a
 * later change a genuine key loss rather than a cache miss.
 */
function usePassphrase(phrase: string): void {
  process.env.AGENTS_SECRETS_PASSPHRASE = phrase;
  _resetFileStoreForTest({ fileDir: dir, passphrase: null });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-unreadable-'));
  prevPassphrase = process.env.AGENTS_SECRETS_PASSPHRASE;
  // No OS keychain: force the encrypted file store, the backend that can lose
  // its passphrase.
  prevBackend = setKeychainBackendForTest(null);
  usePassphrase('the-original-passphrase');
});

afterEach(() => {
  setKeychainBackendForTest(prevBackend);
  if (prevPassphrase === undefined) delete process.env.AGENTS_SECRETS_PASSPHRASE;
  else process.env.AGENTS_SECRETS_PASSPHRASE = prevPassphrase;
  _resetFileStoreForTest({});
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('a file-backed bundle whose passphrase is lost', () => {
  it('is still deletable — the only way out of the dead end', () => {
    writeBundle({ name: NAME, backend: 'file', vars: { NPM_TOKEN: 'literal:shhh' } });
    expect(readBundle(NAME).vars.NPM_TOKEN).toBe('literal:shhh');

    // The passphrase is lost: same ciphertext on disk, a different key.
    usePassphrase('a-different-passphrase');

    // Present on disk, but no longer readable.
    expect(bundleExists(NAME)).toBe(true);
    expect(() => readBundle(NAME)).toThrow(/failed to decrypt/i);

    // The new seam reports that state instead of throwing...
    expect(readBundleIfDecryptable(NAME)).toBeNull();

    // ...so deletion can proceed and free the name.
    expect(deleteBundle(NAME)).toBe(true);
    expect(bundleExists(NAME)).toBe(false);
  });

  it('can be recreated under the same name once deleted', () => {
    writeBundle({ name: NAME, backend: 'file', vars: { NPM_TOKEN: 'literal:old' } });
    usePassphrase('a-different-passphrase');
    deleteBundle(NAME);

    writeBundle({ name: NAME, backend: 'file', vars: { NPM_TOKEN: 'literal:recovered' } });
    expect(readBundle(NAME).vars.NPM_TOKEN).toBe('literal:recovered');
  });
});

describe('readBundleIfDecryptable', () => {
  it('returns the bundle when it decrypts', () => {
    writeBundle({ name: NAME, backend: 'file', vars: { A: 'literal:1' } });
    expect(readBundleIfDecryptable(NAME)?.vars.A).toBe('literal:1');
  });

  it('still throws for a genuinely missing bundle — not-found must not read as unreadable', () => {
    expect(() => readBundleIfDecryptable('no-such-bundle.test')).toThrow(/not found/i);
  });
});
