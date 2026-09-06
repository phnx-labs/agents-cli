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
  bundleExists,
  bundleExistsSync,
  writeBundleWithItems,
  readAndResolveBundleEnv,
  readAndResolveBundleEnvSync,
  secretsRequest,
  SecretsClientError,
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

const REAL_BIN = process.env.AGENTS_TEST_SECRETS_BIN;

describe.skipIf(!REAL_BIN)('secrets protocol client against the real standalone', () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};

  const ENV_KEYS = ['SECRETS_BIN', 'HOME', 'SECRETS_HOME', 'SECRETS_EVENT_LOG', 'AGENTS_SECRETS_PASSPHRASE', 'AGENTS_SECRETS_NO_AGENT'];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-client-'));
    process.env.SECRETS_BIN = REAL_BIN;
    process.env.HOME = home; // the standalone file store lives under $HOME/.agents/.cache/secrets
    process.env.SECRETS_HOME = path.join(home, '.agents');
    process.env.AGENTS_SECRETS_PASSPHRASE = 'test-passphrase'; // file-backend encryption key
    process.env.AGENTS_SECRETS_NO_AGENT = '1'; // no broker in the test env
    // Point the standalone's append-only event log at a pre-created file. Its
    // emit() locks the log with proper-lockfile realpath:true BEFORE the file
    // exists, so a fresh store spins the full 30s lock-acquire budget (swallowed)
    // on the first write — a standalone-side latency bug (secrets-cli
    // feat/standalone-port), not this client. Pre-creating the log sidesteps it
    // so the test measures the client, not that stall.
    const eventLog = path.join(home, 'events.jsonl');
    fs.writeFileSync(eventLog, '');
    process.env.SECRETS_EVENT_LOG = eventLog;
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
});
