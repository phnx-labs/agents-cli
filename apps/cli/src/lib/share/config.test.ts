import { describe, expect, it, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { KeychainBackend } from '../secrets/index.js';
import type { SecretsBundle } from '../secrets/bundles.js';

class MemBackend implements KeychainBackend {
  store = new Map<string, string>();
  has(item: string) { return this.store.has(item); }
  get(item: string) {
    const v = this.store.get(item);
    if (v === undefined) throw new Error(`missing ${item}`);
    return v;
  }
  set(item: string, value: string) { this.store.set(item, value); }
  delete(item: string) { return this.store.delete(item); }
  list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-config-test-'));
const prevHome = process.env.HOME;
const prevEnvToken = process.env.SHARE_WRITE_TOKEN;
const prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
const prevNoUsage = process.env.AGENTS_NO_USAGE_TRACK;
const prevNoPrompt = process.env.AGENTS_SECRETS_NO_PROMPT;

process.env.HOME = HOME;
process.env.AGENTS_SECRETS_NO_AGENT = '1';
process.env.AGENTS_NO_USAGE_TRACK = '1';
// These tests install an in-memory keychain backend (no real Touch ID) and read
// it directly. On darwin-headless (the release-gated macOS CI matrix)
// isHeadlessSecretsContext() would otherwise be true, forcing the agentOnly
// no-prompt path to throw before the in-memory read. Pin NO_PROMPT=0 so reads go
// straight to the seeded backend, matching the direct-read intent on every OS.
process.env.AGENTS_SECRETS_NO_PROMPT = '0';

const {
  secretsKeychainItem,
  setKeychainBackendForTest,
  setKeychainServiceHashingForTest,
  setKeychainToken,
} = await import('../secrets/index.js');
const { readAndResolveBundleEnv, writeBundle } = await import('../secrets/bundles.js');
const {
  DEFAULT_CF_BUNDLE,
  generateWriteToken,
  readCloudflareCreds,
  readShareConfig,
  readWriteToken,
  SHARE_BUNDLE,
  SHARE_TOKEN_ENV_KEY,
  SHARE_TOKEN_KEY,
  shareRuntimeEnv,
  storeWriteToken,
  writeShareConfig,
} = await import('./config.js');

describe('share config', () => {
  let mem: MemBackend;
  let prevBackend: KeychainBackend | null;

  beforeEach(() => {
    mem = new MemBackend();
    prevBackend = setKeychainBackendForTest(mem);
    setKeychainServiceHashingForTest(randomBytes(16).toString('hex'));
    fs.rmSync(path.join(HOME, '.agents'), { recursive: true, force: true });
    delete process.env.SHARE_WRITE_TOKEN;
  });

  afterEach(() => {
    setKeychainServiceHashingForTest(null);
    setKeychainBackendForTest(prevBackend);
    if (prevEnvToken === undefined) delete process.env.SHARE_WRITE_TOKEN;
    else process.env.SHARE_WRITE_TOKEN = prevEnvToken;
  });

  it('mints a 32-byte hex write token', () => {
    expect(generateWriteToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('persists endpoint config under agents.yaml share and trims the base URL on read', () => {
    writeShareConfig({
      baseUrl: 'https://share.example.com/',
      accountId: 'acct_123',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.example.com',
    });

    expect(readShareConfig()).toEqual({
      baseUrl: 'https://share.example.com',
      accountId: 'acct_123',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.example.com',
    });
    expect(fs.readFileSync(path.join(HOME, '.agents', 'agents.yaml'), 'utf8')).toContain('share:');
  });

  it('stores the raw Worker write token in the share secrets bundle as WRITE_TOKEN', () => {
    storeWriteToken('write-token-1');

    expect(SHARE_TOKEN_KEY).toBe('WRITE_TOKEN');
    expect(readWriteToken()).toBe('write-token-1');
    expect(readAndResolveBundleEnv(SHARE_BUNDLE, { caller: 'test' }).env).toEqual({
      WRITE_TOKEN: 'write-token-1',
    });
    // The token must never reach agents.yaml — it belongs in the keychain bundle.
    // Reading state no longer creates that file (RUSH-1925), and a file that does
    // not exist trivially satisfies the requirement, so treat absent as empty
    // rather than crashing on ENOENT.
    const metaPath = path.join(HOME, '.agents', 'agents.yaml');
    const metaText = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf8') : '';
    expect(metaText).not.toContain('write-token-1');
  });

  it('prefers an injected SHARE_WRITE_TOKEN over the local bundle', () => {
    storeWriteToken('bundle-token');
    process.env.SHARE_WRITE_TOKEN = 'env-token';

    expect(SHARE_TOKEN_ENV_KEY).toBe('SHARE_WRITE_TOKEN');
    expect(readWriteToken()).toBe('env-token');
  });

  it('builds runtime env only when synced share config exists', () => {
    storeWriteToken('bundle-token');

    expect(shareRuntimeEnv()).toBeUndefined();

    writeShareConfig({
      baseUrl: 'https://share.example.com',
      accountId: 'acct',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });

    expect(shareRuntimeEnv()).toEqual({ SHARE_WRITE_TOKEN: 'bundle-token' });
  });

  it('uses the injected token for runtime env without touching the bundle', () => {
    writeShareConfig({
      baseUrl: 'https://share.example.com',
      accountId: 'acct',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });
    process.env.SHARE_WRITE_TOKEN = 'env-token';

    expect(shareRuntimeEnv({ agentOnly: true })).toEqual({ SHARE_WRITE_TOKEN: 'env-token' });
  });

  it('reads Cloudflare provisioning credentials from the cloudflare bundle by default', () => {
    const bundle: SecretsBundle = {
      name: DEFAULT_CF_BUNDLE,
      vars: {
        CLOUDFLARE_API_TOKEN: 'keychain:CLOUDFLARE_API_TOKEN',
        CLOUDFLARE_ACCOUNT_ID: 'keychain:CLOUDFLARE_ACCOUNT_ID',
      },
    };
    setKeychainToken(secretsKeychainItem(DEFAULT_CF_BUNDLE, 'CLOUDFLARE_API_TOKEN'), 'cf-token-1');
    setKeychainToken(secretsKeychainItem(DEFAULT_CF_BUNDLE, 'CLOUDFLARE_ACCOUNT_ID'), 'cf-account-1');
    writeBundle(bundle);

    expect(DEFAULT_CF_BUNDLE).toBe('cloudflare');
    expect(readCloudflareCreds()).toEqual({
      apiToken: 'cf-token-1',
      accountId: 'cf-account-1',
    });
  });

  it('fails if only the old cloudflare.com bundle exists', () => {
    const bundle: SecretsBundle = {
      name: 'cloudflare.com',
      vars: {
        CLOUDFLARE_API_TOKEN: 'keychain:CLOUDFLARE_API_TOKEN',
      },
    };
    setKeychainToken(secretsKeychainItem('cloudflare.com', 'CLOUDFLARE_API_TOKEN'), 'old-token');
    writeBundle(bundle);

    expect(() => readCloudflareCreds()).toThrow(/Secrets bundle 'cloudflare' not found/);
  });
});

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevEnvToken === undefined) delete process.env.SHARE_WRITE_TOKEN;
  else process.env.SHARE_WRITE_TOKEN = prevEnvToken;
  if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
  else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
  if (prevNoUsage === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
  else process.env.AGENTS_NO_USAGE_TRACK = prevNoUsage;
  if (prevNoPrompt === undefined) delete process.env.AGENTS_SECRETS_NO_PROMPT;
  else process.env.AGENTS_SECRETS_NO_PROMPT = prevNoPrompt;
});
