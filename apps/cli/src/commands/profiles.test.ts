import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from '../lib/state.js';
import { addProfile, applyFromSecrets } from './profiles.js';
import { readProfile } from '../lib/profiles.js';
import { setKeychainBackendForTest, secretsKeychainItem, getKeychainToken, type KeychainBackend } from '../lib/secrets/index.js';
import { keychainItemName } from '../lib/secrets/profiles.js';
import { writeBundleWithItems, keychainRef } from '../lib/secrets/bundles.js';
import { findAccount } from '../lib/account-registry.js';

let TEST_ROOT: string;
let USER_DIR: string;

class MemoryKeychain implements KeychainBackend {
  store = new Map<string, string>();
  has(item: string) { return this.store.has(item); }
  get(item: string): string {
    const v = this.store.get(item);
    if (v === undefined) throw new Error(`Keychain item not found: ${item}`);
    return v;
  }
  set(item: string, value: string) { this.store.set(item, value); }
  delete(item: string) { return this.store.delete(item); }
  list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
}

let prevBackend: ReturnType<typeof setKeychainBackendForTest>;

beforeEach(() => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-cmd-test-'));
  USER_DIR = path.join(TEST_ROOT, '.agents');
  fs.mkdirSync(path.join(USER_DIR, 'profiles'), { recursive: true });
  vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(USER_DIR);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  prevBackend = setKeychainBackendForTest(new MemoryKeychain());
  writeBundleWithItems(
    { name: 'prod', vars: { OPENROUTER_KEY: keychainRef('OPENROUTER_KEY') } },
    new Map([[secretsKeychainItem('prod', 'OPENROUTER_KEY'), 'sk-test-secret']]),
  );
});

afterEach(() => {
  setKeychainBackendForTest(prevBackend);
  vi.restoreAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('addProfile — --from-secrets threading (host + model path)', () => {
  it('migrates the copied bundle value into a durable account reference', async () => {
    await addProfile('corp', { host: 'claude', model: 'gpt-x', authProvider: 'corp', fromSecrets: 'prod' }, 'Harness');
    const p = readProfile('corp');
    expect(p.auth).toBeUndefined();
    const account = findAccount(p.account!);
    expect(account?.provider).toBe('proxy');
    expect(getKeychainToken(account!.secretRef)).toBe('sk-test-secret');
  });

  it('does not clobber the host\'s own keychain item when --from-secrets is given without --auth-provider', async () => {
    // profileFromHostModel defaults profile.provider to the *host* id ('claude')
    // even though no auth is attached yet — applyFromSecrets must not trust
    // that default, or it would overwrite the host's own keychain slot instead
    // of falling through to the bundle name.
    const preExisting = 'pre-existing-claude-host-token';
    const kc = new MemoryKeychain();
    kc.set(keychainItemName('claude'), preExisting);
    setKeychainBackendForTest(kc);
    writeBundleWithItems(
      { name: 'prod', vars: { OPENROUTER_KEY: keychainRef('OPENROUTER_KEY') } },
      new Map([[secretsKeychainItem('prod', 'OPENROUTER_KEY'), 'sk-test-secret']]),
    );

    await addProfile('corp', { host: 'claude', model: 'gpt-x', fromSecrets: 'prod' }, 'Harness');

    // The host's pre-existing token is untouched...
    expect(getKeychainToken(keychainItemName('claude'))).toBe(preExisting);
    // ...and the harness's own auth was attached under the bundle's name instead.
    const p = readProfile('corp');
    expect(p.provider).toBe('prod');
    const account = findAccount(p.account!);
    expect(account?.provider).toBe('proxy');
    expect(getKeychainToken(account!.secretRef)).toBe('sk-test-secret');
  });
});

describe('addProfile — --from-secrets threading (preset path)', () => {
  it('skips the interactive key prompt entirely — a preset that normally requires auth still succeeds non-interactively', async () => {
    // 'kimi' is not authOptional, so without --from-secrets this would call
    // ensureProviderToken -> promptForSecret, which throws outside a TTY. A
    // clean resolve here proves the prompt was skipped, not just that no error
    // surfaced for an unrelated reason.
    await expect(
      addProfile('kimi', { preset: 'kimi', fromSecrets: 'prod' }, 'Harness'),
    ).resolves.toBeUndefined();
    const p = readProfile('kimi');
    const account = findAccount(p.account!);
    expect(account?.provider).toBe('openrouter');
    expect(getKeychainToken(account!.secretRef)).toBe('sk-test-secret');
  });
});

describe('applyFromSecrets — provider precedence and error paths', () => {
  it('prefers an explicit auth-provider over the profile\'s existing one', async () => {
    const profile = {
      name: 'x',
      host: { agent: 'claude' as const },
      env: {},
      provider: 'old-provider',
      auth: { envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: 'agents-cli.old-provider.token' },
    };
    await applyFromSecrets(profile, 'prod', 'new-provider');
    expect(getKeychainToken(keychainItemName('new-provider'))).toBe('sk-test-secret');
  });

  it('throws a clear error for a bundle that does not exist', async () => {
    const profile = { name: 'x', host: { agent: 'claude' as const }, env: {} };
    await expect(applyFromSecrets(profile, 'no-such-bundle', 'x')).rejects.toThrow(/not found/i);
  });

  it('allowInheritedAuth: false rejects reusing an inherited auth binding (the fork-clobber gap)', async () => {
    // Simulates forkProfile's behavior: `auth`/`provider` copied by reference
    // from the fork's SOURCE harness, not established for this profile.
    const sourceToken = 'REAL-OPENROUTER-KEY-FOR-SOURCE-HARNESS';
    const kc = new MemoryKeychain();
    kc.set(keychainItemName('openrouter'), sourceToken);
    setKeychainBackendForTest(kc);
    writeBundleWithItems(
      { name: 'prod', vars: { OPENROUTER_KEY: keychainRef('OPENROUTER_KEY') } },
      new Map([[secretsKeychainItem('prod', 'OPENROUTER_KEY'), 'sk-test-secret']]),
    );

    const forked = {
      name: 'forked-harness',
      host: { agent: 'claude' as const },
      env: {},
      provider: 'openrouter', // inherited from the source, not this profile's own
      auth: { envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: keychainItemName('openrouter') },
    };

    await expect(
      applyFromSecrets(forked, 'prod', undefined, { allowInheritedAuth: false }),
    ).rejects.toThrow(/inherited its auth binding/i);

    // The source harness's real credential must survive the rejected attempt.
    expect(getKeychainToken(keychainItemName('openrouter'))).toBe(sourceToken);
  });

  it('allowInheritedAuth: false still allows an explicit --auth-provider to rotate a fork\'s own credential', async () => {
    const forked = {
      name: 'forked-harness',
      host: { agent: 'claude' as const },
      env: {},
      provider: 'openrouter',
      auth: { envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: keychainItemName('openrouter') },
    };
    await applyFromSecrets(forked, 'prod', 'openrouter', { allowInheritedAuth: false });
    expect(getKeychainToken(keychainItemName('openrouter'))).toBe('sk-test-secret');
  });
});
