import { describe, expect, it, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { KeychainBackend } from '../secrets/index.js';
import type { SecretsBundle } from '../secrets/bundles.js';

/**
 * SEC-13 for the browser-profile launch read: injecting a profile secrets bundle
 * on `launchBrowser` is a BACKGROUND read (the agent spawns the browser), so it
 * is `agentOnly` and MUST NEVER pop Touch ID. resolveProfileSecretsEnv is the
 * exported seam that carries that contract without spawning a real browser: a
 * `never`/no-ACL bundle resolves silently; a locked `hold`/`always` bundle
 * resolves to an EMPTY map (launch proceeds without those secrets), never a throw
 * and never a prompt.
 *
 * Uses the in-memory keychain backend (no real Touch ID) so the real
 * readAndResolveBundleEnv path runs. This file is separate from chrome.test.ts
 * because that file mocks `fs` at module scope, which the real bundle store needs
 * unmocked to write/read metadata.
 */
class MemBackend implements KeychainBackend {
  store = new Map<string, string>();
  gets = 0;
  has(item: string) { return this.store.has(item); }
  get(item: string) {
    this.gets++;
    const v = this.store.get(item);
    if (v === undefined) throw new Error(`missing ${item}`);
    return v;
  }
  set(item: string, value: string) { this.store.set(item, value); }
  delete(item: string) { return this.store.delete(item); }
  list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-chrome-secrets-test-'));
const prevHome = process.env.HOME;
const prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
const prevNoUsage = process.env.AGENTS_NO_USAGE_TRACK;

process.env.HOME = HOME;
process.env.AGENTS_SECRETS_NO_AGENT = '1'; // force keychain path, skip secrets-agent
process.env.AGENTS_NO_USAGE_TRACK = '1';

const {
  secretsKeychainItem,
  setKeychainBackendForTest,
  setKeychainServiceHashingForTest,
  setKeychainToken,
} = await import('../secrets/index.js');
const { writeBundle } = await import('../secrets/bundles.js');
const { resolveProfileSecretsEnv } = await import('./chrome.js');

const BUNDLE = 'browser-profile-x';
const KEY = 'PROFILE_TOKEN';

describe('resolveProfileSecretsEnv (browser launch, agentOnly SEC-13)', () => {
  let mem: MemBackend;
  let prevBackend: KeychainBackend | null;

  beforeEach(() => {
    mem = new MemBackend();
    prevBackend = setKeychainBackendForTest(mem);
    setKeychainServiceHashingForTest(randomBytes(16).toString('hex'));
    fs.rmSync(path.join(HOME, '.agents'), { recursive: true, force: true });
  });

  afterEach(() => {
    setKeychainServiceHashingForTest(null);
    setKeychainBackendForTest(prevBackend);
  });

  it('returns an empty map when no bundle is named', () => {
    expect(resolveProfileSecretsEnv(undefined)).toEqual({});
  });

  it('returns an empty map when the named bundle does not exist', () => {
    expect(resolveProfileSecretsEnv('does-not-exist')).toEqual({});
  });

  it('resolves a never/no-ACL bundle silently and injects its env', () => {
    setKeychainToken(secretsKeychainItem(BUNDLE, KEY), 'profile-tok');
    writeBundle({
      name: BUNDLE,
      policy: 'never',
      vars: { [KEY]: `keychain:${KEY}` },
    } as SecretsBundle);

    expect(resolveProfileSecretsEnv(BUNDLE)).toEqual({ [KEY]: 'profile-tok' });
  });

  it('a LOCKED hold bundle resolves to an empty map — launch proceeds, NO prompt, NO gated read', () => {
    setKeychainToken(secretsKeychainItem(BUNDLE, KEY), 'gated-tok');
    writeBundle({
      name: BUNDLE,
      policy: 'hold',
      vars: { [KEY]: `keychain:${KEY}` },
    } as SecretsBundle);

    // agentOnly: the policy guard throws for a locked hold bundle BEFORE the
    // biometry-gated batch read, and resolveProfileSecretsEnv swallows it → {}
    // (no secrets, no prompt). The empty result is what lets launchBrowser
    // continue. `PROFILE_TOKEN` is never returned — the gated read never ran.
    const env = resolveProfileSecretsEnv(BUNDLE);
    expect(env).toEqual({});
    expect(env[KEY]).toBeUndefined();
  });

  it('the LOCKED read stops before the gated batch — strictly fewer reads than a silent one', () => {
    // The only prompting read is the batch getKeychainTokens. A silent `never`
    // bundle reads meta + the gated batch; a locked bundle stops at the guard's
    // single no-ACL meta read. Comparing counts proves the locked path never
    // reached the gated read (so it could never prompt), without a brittle
    // absolute count.
    setKeychainToken(secretsKeychainItem(BUNDLE, KEY), 'tok');
    writeBundle({ name: BUNDLE, policy: 'never', vars: { [KEY]: `keychain:${KEY}` } } as SecretsBundle);
    const silentGets = mem.gets;
    resolveProfileSecretsEnv(BUNDLE);
    const silentDelta = mem.gets - silentGets;

    setKeychainToken(secretsKeychainItem(BUNDLE, KEY), 'tok');
    writeBundle({ name: BUNDLE, policy: 'hold', vars: { [KEY]: `keychain:${KEY}` } } as SecretsBundle);
    const lockedStart = mem.gets;
    resolveProfileSecretsEnv(BUNDLE);
    const lockedDelta = mem.gets - lockedStart;

    expect(lockedDelta).toBeLessThan(silentDelta);
  });

  it('an always-policy (prompt-every-time) bundle also resolves to an empty map, never prompts', () => {
    setKeychainToken(secretsKeychainItem(BUNDLE, KEY), 'gated-tok');
    writeBundle({
      name: BUNDLE,
      policy: 'always',
      vars: { [KEY]: `keychain:${KEY}` },
    } as SecretsBundle);

    expect(resolveProfileSecretsEnv(BUNDLE)).toEqual({});
  });
});

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
  else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
  if (prevNoUsage === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
  else process.env.AGENTS_NO_USAGE_TRACK = prevNoUsage;
});
