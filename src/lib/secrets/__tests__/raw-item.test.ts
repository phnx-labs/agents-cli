import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getKeychainToken,
  setKeychainToken,
  hasKeychainToken,
  deleteKeychainToken,
  setKeychainBackendForTest,
  type KeychainBackend,
} from '../index.js';
import { _resetForTest } from '../linux.js';

/**
 * The `agents secrets get/set <item>` raw-item path — the cross-platform
 * primitive the Linear SessionStart hook calls instead of hardcoding
 * `/usr/bin/security`. These items use BARE names (e.g. `linear-api-key`),
 * not the `agents-cli.` namespace, which is exactly what distinguishes the
 * no-biometry hook path from biometry-gated bundle items.
 */

// ---------------------------------------------------------------------------
// Platform-independent contract: bare item names round-trip through the
// public index.ts API. Uses the in-memory test backend so it runs on any OS
// (incl. macOS dev machines) without touching a real keychain/keyring.
// ---------------------------------------------------------------------------
describe('raw keychain item API contract', () => {
  let store: Map<string, string>;
  let prev: KeychainBackend | null;

  beforeEach(() => {
    store = new Map();
    const mem: KeychainBackend = {
      has: (i) => store.has(i),
      get: (i) => {
        if (!store.has(i)) throw new Error(`Keychain item '${i}' not found.`);
        return store.get(i)!;
      },
      set: (i, v) => { store.set(i, v); },
      delete: (i) => store.delete(i),
      list: (p) => [...store.keys()].filter((k) => k.startsWith(p)),
    };
    prev = setKeychainBackendForTest(mem);
  });

  afterEach(() => {
    setKeychainBackendForTest(prev);
  });

  it('round-trips a bare item name (the hook stores linear-api-key)', () => {
    expect(hasKeychainToken('linear-api-key')).toBe(false);
    setKeychainToken('linear-api-key', 'lin_api_xxx');
    expect(hasKeychainToken('linear-api-key')).toBe(true);
    expect(getKeychainToken('linear-api-key')).toBe('lin_api_xxx');
  });

  it('overwrites in place on repeated set (upsert)', () => {
    setKeychainToken('linear-team-id', 'team-old');
    setKeychainToken('linear-team-id', 'team-new');
    expect(getKeychainToken('linear-team-id')).toBe('team-new');
  });

  it('throws on a missing item so the hook can fall back quietly', () => {
    expect(() => getKeychainToken('never-stored')).toThrow(/not found/);
  });

  it('delete removes the item', () => {
    setKeychainToken('linear-api-key', 'v');
    expect(deleteKeychainToken('linear-api-key')).toBe(true);
    expect(hasKeychainToken('linear-api-key')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Linux real backend: force the encrypted-file fallback (so CI doesn't need an
// unlocked GNOME Keyring) and exercise the ACTUAL critical path index.ts takes
// on Linux — value gets encrypted to disk and decrypted back. This is the path
// the hook hits on this user's Linux box.
// ---------------------------------------------------------------------------
describe.skipIf(process.platform !== 'linux')('raw item via real Linux file fallback', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-rawitem-'));
    _resetForTest({ fileDir: dir, forceFileFallback: true, passphrase: 'test-pass' });
  });

  afterEach(() => {
    _resetForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('set then get a bare item round-trips through libsecret file fallback', () => {
    setKeychainToken('linear-api-key', 'lin_api_secret');
    expect(getKeychainToken('linear-api-key')).toBe('lin_api_secret');
    expect(hasKeychainToken('linear-api-key')).toBe(true);
    // Encrypted on disk under <item>.enc — never the plaintext value.
    const onDisk = fs.readFileSync(path.join(dir, 'linear-api-key.enc'), 'utf8');
    expect(onDisk).not.toContain('lin_api_secret');
    expect(JSON.parse(onDisk)).toHaveProperty('ciphertext');
  });

  it('missing item throws', () => {
    expect(() => getKeychainToken('absent-item')).toThrow();
    expect(hasKeychainToken('absent-item')).toBe(false);
  });
});
