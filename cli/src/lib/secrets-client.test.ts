/**
 * Tests for the standalone-secrets process client (secrets-client.ts).
 *
 * The integration block drives the REAL standalone `secrets __serve` server (no
 * mocks — repo rule): it spawns the actual executable and exchanges real wire
 * messages over the fd 3 / fd 4 pipes. It is gated on AGENTS_TEST_SECRETS_BIN
 * pointing at a built standalone entrypoint (e.g. `dist/index.js` from a
 * `secrets-cli` checkout after `bash scripts/build.sh`); with the var unset it
 * skips cleanly, so CI — which has no standalone checkout — stays green. This is
 * the same env-gated real-dependency pattern as the Windows `--device` e2e
 * suites (AGENTS_TEST_WIN_HOST). Point it at the binary to exercise it:
 *
 *   AGENTS_TEST_SECRETS_BIN=/path/to/secrets-cli/dist/index.js \
 *     bun run test src/lib/secrets-client.test.ts
 *
 * Every op runs against a throwaway HOME/SECRETS_HOME so the real user store is
 * never touched (the standalone's file store is keyed off HOME).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveSecretsBin,
  buildServeEnv,
  bundleBackend,
  bundleBackendSync,
  bundleExists,
  bundleExistsSync,
  deleteBundleSync,
  deleteKeychainTokenSync,
  hasKeychainTokenSync,
  getKeychainTokenSync,
  keychainRef,
  keychainUsesFileFallback,
  listBundlesSync,
  parseBundleValue,
  profileKeychainItem,
  readBundleSync,
  renameBundle,
  rotateBundleSecretSync,
  secretsKeychainItem,
  setKeychainTokenSync,
  writeBundleWithItems,
  writeBundleWithItemsSync,
  readAndResolveBundleEnv,
  readAndResolveBundleEnvSync,
  secretsRequest,
  SecretsClientError,
  isSecretsClientError,
  _resetSecretsClientForTest,
  PROTOCOL_VERSION,
} from './secrets-client.js';
import { getUserAgentsDir } from './state.js';
import type { SecretsBundle } from './secrets/bundles.js';

describe('resolveSecretsBin', () => {
  const savedBin = process.env.SECRETS_BIN;
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.SECRETS_BIN = savedBin;
    process.env.PATH = savedPath;
    if (savedBin === undefined) delete process.env.SECRETS_BIN;
    _resetSecretsClientForTest();
  });

  it('honours an explicit $SECRETS_BIN', () => {
    process.env.SECRETS_BIN = '/opt/custom/secrets';
    _resetSecretsClientForTest();
    expect(resolveSecretsBin()).toBe('/opt/custom/secrets');
  });

  it('fails loud with install guidance and no engine fallback when absent', () => {
    delete process.env.SECRETS_BIN;
    process.env.PATH = ''; // nothing to resolve `secrets` from
    _resetSecretsClientForTest();
    try {
      resolveSecretsBin();
      throw new Error('expected resolveSecretsBin to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsClientError);
      expect((error as SecretsClientError).code).toBe('SECRETS_BIN_MISSING');
      expect((error as SecretsClientError).message).toContain('npm i -g @phnx-labs/secrets-cli');
    }
  });
});

describe('buildServeEnv', () => {
  it('defaults SECRETS_HOME to the user agents dir, letting an explicit value win', () => {
    expect(buildServeEnv({}).SECRETS_HOME).toBe(getUserAgentsDir());
    expect(buildServeEnv({ SECRETS_HOME: '/somewhere/else' }).SECRETS_HOME).toBe('/somewhere/else');
  });

  it('bridges the old AGENTS_SECRETS_PASSPHRASE onto the standalone SECRETS_PASSPHRASE', () => {
    // The standalone renamed AGENTS_SECRETS_* -> SECRETS_*; without this bridge
    // it never sees the passphrase agents-cli's own file store was written under
    // and would provision a fresh machine-local key it can't decrypt with.
    expect(buildServeEnv({ AGENTS_SECRETS_PASSPHRASE: 'p1' }).SECRETS_PASSPHRASE).toBe('p1');
  });

  it('never overrides an explicit SECRETS_PASSPHRASE', () => {
    expect(
      buildServeEnv({ SECRETS_PASSPHRASE: 'new', AGENTS_SECRETS_PASSPHRASE: 'old' }).SECRETS_PASSPHRASE,
    ).toBe('new');
  });

  it('leaves SECRETS_PASSPHRASE unset when neither name is present', () => {
    expect(buildServeEnv({}).SECRETS_PASSPHRASE).toBeUndefined();
  });
});

describe('item naming (the seam\'s shared identifier scheme)', () => {
  it('derives raw item names and refs the standalone stores under', () => {
    expect(secretsKeychainItem('work', 'API_KEY')).toBe('agents-cli.secrets.work.API_KEY');
    expect(profileKeychainItem('openrouter')).toBe('agents-cli.openrouter.token');
    expect(keychainRef('API_KEY')).toBe('keychain:API_KEY');
  });

  it('parses literals, escaped literals, and typed refs', () => {
    expect(parseBundleValue('plain')).toEqual({ literal: 'plain' });
    expect(parseBundleValue({ value: 'env:not-a-ref' })).toEqual({ literal: 'env:not-a-ref' });
    expect(parseBundleValue('keychain:API_KEY')).toEqual({ ref: { provider: 'keychain', value: 'API_KEY' } });
    expect(parseBundleValue('exec:op read x')).toEqual({ ref: { provider: 'exec', value: 'op read x' } });
    expect(() => parseBundleValue(42 as unknown as string)).toThrow(/Invalid bundle value/);
  });

  it('isSecretsClientError narrows on class and optional code', () => {
    const err = new SecretsClientError('NOT_FOUND', 'x');
    expect(isSecretsClientError(err)).toBe(true);
    expect(isSecretsClientError(err, 'NOT_FOUND')).toBe(true);
    expect(isSecretsClientError(err, 'LOCKED')).toBe(false);
    expect(isSecretsClientError(new Error('x'))).toBe(false);
  });
});

const REAL_BIN = process.env.AGENTS_TEST_SECRETS_BIN;

describe.skipIf(!REAL_BIN)('secrets protocol client against the real standalone', () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};

  const ENV_KEYS = ['SECRETS_BIN', 'HOME', 'SECRETS_HOME', 'AGENTS_SECRETS_PASSPHRASE', 'SECRETS_NO_AGENT'];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-client-'));
    process.env.SECRETS_BIN = REAL_BIN;
    process.env.HOME = home; // the standalone file store lives under $HOME/.agents/.cache/secrets
    process.env.SECRETS_HOME = path.join(home, '.agents');
    // Set the OLD name on purpose: the client's buildServeEnv must bridge it onto
    // the standalone's renamed SECRETS_PASSPHRASE, so this exercises that bridge
    // end-to-end against the real store (a fresh key would still round-trip, so
    // the bridge is pinned deterministically by the buildServeEnv unit tests too).
    process.env.AGENTS_SECRETS_PASSPHRASE = 'test-passphrase'; // file-backend encryption key
    process.env.SECRETS_NO_AGENT = '1'; // no broker in the test env
    _resetSecretsClientForTest();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    _resetSecretsClientForTest();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function fileBundle(name: string): { bundle: SecretsBundle; items: Map<string, string>; value: string } {
    const value = `s3cr3t-${name}`;
    const bundle: SecretsBundle = { name, backend: 'file', vars: { MY_KEY: 'keychain:MY_KEY' } };
    const items = new Map([[`agents-cli.secrets.${name}.MY_KEY`, value]]);
    return { bundle, items, value };
  }

  it('handshakes and reports protocol version 1', async () => {
    const result = await secretsRequest<{ protocol: number; operations: Record<string, string[]> }>('handshake');
    expect(result.protocol).toBe(PROTOCOL_VERSION);
    expect(result.operations.bundles).toContain('readAndResolveBundleEnv');
  });

  it('reports bundleExists=false on a fresh home', async () => {
    expect(await bundleExists('absent-bundle')).toBe(false);
    expect(bundleExistsSync('absent-bundle')).toBe(false); // sync FIFO transport
  });

  it('round-trips writeBundleWithItems -> readAndResolveBundleEnv on a file bundle', async () => {
    const { bundle, items, value } = fileBundle('round-trip');
    await writeBundleWithItems(bundle, items);
    expect(await bundleExists('round-trip')).toBe(true);

    const resolved = await readAndResolveBundleEnv('round-trip');
    expect(resolved.bundle.name).toBe('round-trip');
    expect(resolved.bundle.backend).toBe('file');
    expect(resolved.env).toEqual({ MY_KEY: value });

    // The same read on the synchronous FIFO path returns the same env.
    const sync = readAndResolveBundleEnvSync('round-trip');
    expect(sync.env).toEqual({ MY_KEY: value });
  });

  it('a large-but-fits synchronous request completes instead of deadlocking', () => {
    // ~50 KiB rides a stock Linux pipe (64 KiB) in one shot. Before the
    // non-blocking fill, a request larger than the pipe buffer hung the calling
    // process FOREVER (the write precedes the child that would drain it, so
    // spawnSync's timeout never armed). It must now always return a response —
    // the server answers even when it rejects the oversized name.
    const bigName = 'x'.repeat(50_000);
    let answered = false;
    try {
      expect(typeof bundleExistsSync(bigName)).toBe('boolean');
      answered = true;
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsClientError);
      answered = true; // a coded error is still a completed round-trip, not a hang
    }
    expect(answered).toBe(true);
  });

  it('a synchronous request over the pipe-buffer bound fails loud, never hangs', () => {
    // > SYNC_REQUEST_MAX_BYTES: rejected up front and pointed at the async path,
    // rather than filling the pipe until it blocks.
    try {
      bundleExistsSync('x'.repeat(70_000));
      throw new Error('expected bundleExistsSync to throw REQUEST_TOO_LARGE');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsClientError);
      expect((error as SecretsClientError).code).toBe('REQUEST_TOO_LARGE');
    }
  });

  it('denies access when context.allowedBundles excludes the bundle', async () => {
    const { bundle, items } = fileBundle('scoped');
    await writeBundleWithItems(bundle, items);

    // In scope: allowed.
    expect(await bundleExists('scoped', { allowedBundles: ['scoped'], scope: 'claude' })).toBe(true);

    // Out of scope: the server fails closed with ACCESS_DENIED.
    await expect(bundleExists('scoped', { allowedBundles: ['other'], scope: 'claude' })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
  });

  it('reports the backend a bundle lives on and lists it', async () => {
    const { bundle, items } = fileBundle('where');
    writeBundleWithItemsSync(bundle, items); // sync writer
    expect(await bundleBackend('where')).toBe('file');
    expect(bundleBackendSync('where')).toBe('file');
    expect(listBundlesSync().map((b) => b.name)).toEqual(['where']);
    expect(readBundleSync('where').vars).toEqual({ MY_KEY: 'keychain:MY_KEY' });
    expect(deleteBundleSync('where')).toBe(true);
    expect(listBundlesSync()).toEqual([]);
  });

  it('renames a bundle with its raw items and rotates a key in place', async () => {
    const { bundle, items, value } = fileBundle('before');
    await writeBundleWithItems(bundle, items);

    await renameBundle('before', 'after');
    expect(await bundleExists('before')).toBe(false);
    expect(hasKeychainTokenSync(secretsKeychainItem('before', 'MY_KEY'))).toBe(false);
    expect(readAndResolveBundleEnvSync('after').env).toEqual({ MY_KEY: value });

    rotateBundleSecretSync(readBundleSync('after'), 'MY_KEY', { newValue: 'rotated', meta: { type: 'token' } });
    const rotated = readAndResolveBundleEnvSync('after');
    expect(rotated.env).toEqual({ MY_KEY: 'rotated' });
    expect(rotated.bundle.meta?.MY_KEY?.type).toBe('token');
  });

  it('writes, reads and deletes a raw keychain item synchronously', () => {
    const item = profileKeychainItem('openrouter');
    expect(hasKeychainTokenSync(item)).toBe(false);
    setKeychainTokenSync(item, 'tok-1');
    expect(hasKeychainTokenSync(item)).toBe(true);
    expect(getKeychainTokenSync(item)).toBe('tok-1');
    expect(deleteKeychainTokenSync(item)).toBe(true);
    expect(hasKeychainTokenSync(item)).toBe(false);
  });

  it('surfaces a missing bundle as the NOT_FOUND code on both transports', async () => {
    await expect(renameBundle('nope', 'still-nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    try {
      readBundleSync('nope');
      throw new Error('expected readBundleSync to throw');
    } catch (error) {
      expect(isSecretsClientError(error, 'NOT_FOUND')).toBe(true);
    }
  });

  it('reports whether keychain items fall back to the file store on this host', async () => {
    expect(typeof (await keychainUsesFileFallback())).toBe('boolean');
  });
});
