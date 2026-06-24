/**
 * Contract test for the `SyncBackend` transport seam (#364).
 *
 * Proves the secrets push/pull path is decoupled from any specific backend:
 * an in-memory `SyncBackend` (a Map, no network, no Rush) is installed via
 * `setSyncBackend`, and a real bundle (literal var + keychain-backed secret)
 * round-trips through encrypt -> putEnvelope -> getEnvelope -> decrypt ->
 * restore. The backend only ever sees ciphertext.
 *
 * Mocking note (same rationale as bundles-storage.test.ts): `os.homedir` is
 * redirected to a temp dir so writes don't touch the real ~/.agents, and the
 * keychain goes through an in-memory `KeychainBackend`. The contract under
 * test is the transport seam, not Keychain or the filesystem.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface OsMockState { homedir: string }
const osMockState: OsMockState = ((globalThis as Record<string, unknown>)
  .__agents_cli_os_mock__ as OsMockState | undefined)
  ?? (((globalThis as Record<string, unknown>).__agents_cli_os_mock__ = { homedir: '' }) as OsMockState);

vi.mock('os', () => {
  const actual = require('node:os') as typeof import('os');
  return {
    ...actual,
    default: actual,
    homedir: () => {
      const state = (globalThis as Record<string, unknown>)
        .__agents_cli_os_mock__ as OsMockState | undefined;
      return state?.homedir || actual.homedir();
    },
  };
});

import {
  pushBundle,
  pullBundle,
  deleteRemoteBundle,
  listRemoteBundles,
  setSyncBackend,
} from '../sync.js';
import type { SyncBackend, SyncEnvelope } from '../sync-backend.js';
import { writeBundle, bundleExists, deleteBundle } from '../bundles.js';
import {
  setKeychainBackendForTest,
  getKeychainToken,
  setKeychainToken,
  secretsKeychainItem,
  type KeychainBackend,
} from '../index.js';

const PASS = 'correct-horse-battery-staple';

function makeMemoryKeychain(): { backend: KeychainBackend; store: Map<string, string> } {
  const store = new Map<string, string>();
  const backend: KeychainBackend = {
    has: (i) => store.has(i),
    get: (i) => {
      if (!store.has(i)) throw new Error(`Keychain item '${i}' not found.`);
      return store.get(i)!;
    },
    set: (i, v) => { store.set(i, v); },
    delete: (i) => store.delete(i),
    list: (p) => [...store.keys()].filter((k) => k.startsWith(p)),
  };
  return { backend, store };
}

/** In-memory SyncBackend — the test double the contract is asserted against. */
function makeMemorySyncBackend(): { backend: SyncBackend; store: Map<string, SyncEnvelope> } {
  const store = new Map<string, SyncEnvelope>();
  const backend: SyncBackend = {
    async putEnvelope(name, payload) { store.set(name, payload); },
    async getEnvelope(name) { return store.get(name) ?? null; },
    async deleteEnvelope(name) { return store.delete(name); },
    async listEnvelopes() {
      return [...store.entries()].map(([name, p]) => ({ name, updated_at: p.updated_at }));
    },
  };
  return { backend, store };
}

let tmpDir: string;
let restoreKeychain: KeychainBackend | null = null;
let restoreBackend: SyncBackend;
let remote: Map<string, SyncEnvelope>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-syncbackend-'));
  osMockState.homedir = tmpDir;
  restoreKeychain = setKeychainBackendForTest(makeMemoryKeychain().backend);
  const mem = makeMemorySyncBackend();
  remote = mem.store;
  restoreBackend = setSyncBackend(mem.backend);
});

afterEach(() => {
  setKeychainBackendForTest(restoreKeychain);
  setSyncBackend(restoreBackend);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SyncBackend seam: push/pull round-trip through an in-memory driver', () => {
  it('round-trips a bundle (literal var + keychain secret) and stores only ciphertext', async () => {
    // Arrange: a bundle with a literal var and a keychain-backed secret value.
    writeBundle({
      name: 'work',
      description: 'contract test bundle',
      vars: { REGION: 'us-east', API_KEY: 'keychain:apikey' },
    });
    setKeychainToken(secretsKeychainItem('work', 'apikey'), 'sk-live-SECRET-123');

    // Act: push -> the in-memory backend receives one envelope.
    const { updated_at } = await pushBundle('work', { passphrase: PASS });
    expect(remote.has('work')).toBe(true);
    const stored = remote.get('work')!;
    expect(stored.updated_at).toBe(updated_at);

    // The stored blob is ciphertext — neither the secret value nor metadata leaks.
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('sk-live-SECRET-123');
    expect(serialized).not.toContain('us-east');
    expect(stored.envelope.kdf).toBe('pbkdf2-sha256');

    // Wipe local state to simulate a different machine.
    deleteBundle('work');
    setKeychainBackendForTest(makeMemoryKeychain().backend); // empty keychain
    expect(bundleExists('work')).toBe(false);

    // Act: pull -> decrypts and restores bundle + secret.
    const restored = await pullBundle('work', { passphrase: PASS, force: true });
    expect(restored.name).toBe('work');
    expect(restored.vars.REGION).toBe('us-east');
    expect(bundleExists('work')).toBe(true);
    expect(getKeychainToken(secretsKeychainItem('work', 'apikey'))).toBe('sk-live-SECRET-123');
  });

  it('pull throws a backend-agnostic error when the remote has no such bundle', async () => {
    await expect(pullBundle('absent', { passphrase: PASS })).rejects.toThrow(/not found/i);
  });

  it('wrong passphrase fails to decrypt on pull', async () => {
    writeBundle({ name: 'secure', vars: { A: 'plain' } });
    await pushBundle('secure', { passphrase: PASS });
    deleteBundle('secure');
    await expect(
      pullBundle('secure', { passphrase: 'a-different-passphrase', force: true }),
    ).rejects.toThrow(/wrong passphrase|decrypt/i);
  });

  it('list and delete go through the backend', async () => {
    writeBundle({ name: 'one', vars: { A: '1' } });
    writeBundle({ name: 'two', vars: { B: '2' } });
    await pushBundle('one', { passphrase: PASS });
    await pushBundle('two', { passphrase: PASS });

    const listed = (await listRemoteBundles()).map((b) => b.name).sort();
    expect(listed).toEqual(['one', 'two']);

    expect(await deleteRemoteBundle('one')).toBe(true);
    expect(await deleteRemoteBundle('one')).toBe(false); // already gone
    expect((await listRemoteBundles()).map((b) => b.name)).toEqual(['two']);
  });
});
