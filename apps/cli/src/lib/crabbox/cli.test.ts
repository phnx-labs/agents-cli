import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as bundles from '../secrets/bundles.js';
import { writeBundle } from '../secrets/bundles.js';
import { setKeychainBackendForTest, type KeychainBackend } from '../secrets/index.js';
import * as stateModule from '../state.js';
import {
  isReapSafe,
  reapSafeOrphans,
  REAP_MIN_IDLE_SECS,
  pickLeaseBundleFromList,
  pickTailscaleBundleFromList,
  crabboxEnv,
  crabboxList,
  crabboxWarmup,
  parseCrabboxSshArgv,
  resetCrabboxSecretsMemosForTest,
  type CrabboxBox,
} from './cli.js';
import type { SecretsBundle } from '../secrets/bundles.js';

/**
 * In-memory keychain backend so the REAL readAndResolveBundleEnv path runs
 * without a real keychain (mirrors config.test.ts / chrome.secrets.test.ts).
 * `gets` counts backend value reads — the seam that proves the process-lifetime
 * lease-env memo (one keychain read across the many crabboxEnv calls a poll loop
 * makes), WITHOUT mocking the function under test's dependency.
 */
class CountingKeychainBackend implements KeychainBackend {
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

// Suites that stand up a fake `crabbox` on PATH are POSIX-only: the fake is a
// `#!/bin/sh` script with no .cmd/.exe extension, which Windows can neither
// resolve nor execute, so findCrabbox (cli.ts:74) throws "crabbox is not
// installed or not on PATH" before the behavior under test runs. The
// pure-function suites in this file still run everywhere.
const describePosix = describe.skipIf(process.platform === 'win32');
// Same POSIX-only guard for a single test that stands up a fake `crabbox` on PATH.
const itPosix = it.skipIf(process.platform === 'win32');

/**
 * Hermetic lease-bundle resolution for suites that call crabboxList / crabboxWarmup
 * / crabboxEnv but do not care about secrets. Without this, crabboxEnv auto-detects
 * the DEVELOPER's real provider-token bundle (e.g. a locked `hetzner.com`), and the
 * agentOnly read throws "not unlocked" (SEC-13) — a dev-machine-only failure that
 * has nothing to do with the box parsing / warmup argv under test. Pinning readMeta
 * → {} and listBundles → [] makes resolveLeaseBundle find nothing, so crabboxEnv
 * injects no lease token; resetting the memos keeps it isolated per test.
 */
function installHermeticLease(): void {
  beforeEach(() => {
    resetCrabboxSecretsMemosForTest();
    vi.spyOn(stateModule, 'readMeta').mockReturnValue({} as ReturnType<typeof stateModule.readMeta>);
    vi.spyOn(bundles, 'listBundles').mockReturnValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetCrabboxSecretsMemosForTest();
  });
}

describe('pickLeaseBundleFromList', () => {
  const bundle = (name: string, keys: string[]): SecretsBundle =>
    ({ name, vars: Object.fromEntries(keys.map((k) => [k, 'x'])) }) as SecretsBundle;

  it('picks the first bundle that declares a provider token key', () => {
    const bundles = [bundle('misc', ['OPENAI_API_KEY']), bundle('hetzner.com', ['HCLOUD_TOKEN'])];
    expect(pickLeaseBundleFromList(bundles)).toBe('hetzner.com');
  });

  it('matches AWS and DigitalOcean token keys too', () => {
    expect(pickLeaseBundleFromList([bundle('aws', ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'])])).toBe('aws');
    expect(pickLeaseBundleFromList([bundle('do', ['DIGITALOCEAN_TOKEN'])])).toBe('do');
  });

  it('ignores bundles with no provider token key', () => {
    expect(pickLeaseBundleFromList([bundle('misc', ['OPENAI_API_KEY', 'FOO'])])).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(pickLeaseBundleFromList([])).toBeUndefined();
  });

  it('returns the first match in list order (deterministic)', () => {
    const bundles = [bundle('a', ['HCLOUD_TOKEN']), bundle('b', ['HCLOUD_TOKEN'])];
    expect(pickLeaseBundleFromList(bundles)).toBe('a');
  });
});

describe('pickTailscaleBundleFromList', () => {
  const bundle = (name: string, keys: string[]): SecretsBundle =>
    ({ name, vars: Object.fromEntries(keys.map((k) => [k, 'x'])) }) as SecretsBundle;

  it('picks the first bundle + key that declares a tailscale auth key', () => {
    const bundles = [bundle('misc', ['OPENAI_API_KEY']), bundle('tailnet', ['CRABBOX_TAILSCALE_AUTH_KEY'])];
    expect(pickTailscaleBundleFromList(bundles)).toEqual({ name: 'tailnet', key: 'CRABBOX_TAILSCALE_AUTH_KEY' });
  });

  it('accepts the common alternate key names', () => {
    expect(pickTailscaleBundleFromList([bundle('a', ['TS_AUTHKEY'])])).toEqual({ name: 'a', key: 'TS_AUTHKEY' });
    expect(pickTailscaleBundleFromList([bundle('b', ['TAILSCALE_AUTH_KEY'])])).toEqual({
      name: 'b',
      key: 'TAILSCALE_AUTH_KEY',
    });
  });

  it('returns undefined when no bundle declares one', () => {
    expect(pickTailscaleBundleFromList([bundle('misc', ['HCLOUD_TOKEN'])])).toBeUndefined();
    expect(pickTailscaleBundleFromList([])).toBeUndefined();
  });
});

describe('crabboxEnv tailscale value memo', () => {
  // crabboxEnv runs several times per lease (list/wait/spawn/stop). The
  // tailscale read is a single-key subset, which canCacheResolvedEnv rejects
  // for broker auto-cache — so without the process-lifetime value memo every
  // call re-read the keychain (and, for a non-broker-held bundle, could
  // re-prompt). One read per process, then the memo serves.
  const tailscaleBundle = { name: 'tailnet', vars: { TS_AUTHKEY: 'keychain:ts' } } as SecretsBundle;
  const ENV_KEYS = ['AGENTS_LEASE_SECRETS_BUNDLE', 'CRABBOX_TAILSCALE_AUTH_KEY'] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    resetCrabboxSecretsMemosForTest();
    // Hermetic lease-bundle resolution: no configured lease.secretsBundle from
    // the developer's real agents.yaml, and no auto-detectable provider token.
    vi.spyOn(stateModule, 'readMeta').mockReturnValue({} as ReturnType<typeof stateModule.readMeta>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetCrabboxSecretsMemosForTest();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('reads the tailscale keychain value at most once across repeated crabboxEnv calls', () => {
    vi.spyOn(bundles, 'listBundles').mockReturnValue([tailscaleBundle]);
    const readSpy = vi
      .spyOn(bundles, 'readAndResolveBundleEnv')
      .mockReturnValue({ bundle: tailscaleBundle, env: { TS_AUTHKEY: 'tskey-once' } });

    const env1 = crabboxEnv({});
    const env2 = crabboxEnv({});
    const env3 = crabboxEnv({});

    expect(env1.CRABBOX_TAILSCALE_AUTH_KEY).toBe('tskey-once');
    expect(env2.CRABBOX_TAILSCALE_AUTH_KEY).toBe('tskey-once');
    expect(env3.CRABBOX_TAILSCALE_AUTH_KEY).toBe('tskey-once');
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('a failed tailscale read memoizes as absent — the failure is not retried per call', () => {
    vi.spyOn(bundles, 'listBundles').mockReturnValue([tailscaleBundle]);
    const readSpy = vi
      .spyOn(bundles, 'readAndResolveBundleEnv')
      .mockImplementation(() => { throw new Error('bundle not unlocked'); });

    expect(crabboxEnv({}).CRABBOX_TAILSCALE_AUTH_KEY).toBeUndefined();
    expect(crabboxEnv({}).CRABBOX_TAILSCALE_AUTH_KEY).toBeUndefined();
    expect(readSpy).toHaveBeenCalledTimes(1);
  });
});

describe('crabboxEnv lease-token read: agentOnly, resolved ONCE, throws loud without looping', () => {
  // SEC-13: `--lease` is headless by contract, so the provider-token read is
  // agentOnly (never a Touch ID sheet). crabboxEnv runs on EVERY crabboxWaitReady
  // poll iteration (crabboxWaitReady → crabboxFind → crabboxList → crabboxEnv), so
  // the read is resolved ONCE up front and memoized (env or thrown error). A
  // locked bundle re-raises the memoized "unlock <name>" error on every call — so
  // the failure surfaces loud on the FIRST crabboxEnv (before any poll loop) and
  // the loop never re-issues the read (the per-poll storm this fix kills).
  //
  // Exercises the REAL readAndResolveBundleEnv path over an in-memory keychain
  // backend (no mocking of the function under test's dependency — repo rule
  // "Tests exercise the real path"). A `never`-policy bundle resolves silently
  // under agentOnly; a `hold`-policy bundle hits the real agentOnly guard
  // (bundles.ts:1345) and throws the "not unlocked" message. The backend `.get`
  // count is what proves the memo — the real read is issued once, then served.
  const BUNDLE = 'hetzner.com';
  const ENV_KEYS = ['AGENTS_LEASE_SECRETS_BUNDLE', 'CRABBOX_TAILSCALE_AUTH_KEY'] as const;
  const SIDE_ENV = ['AGENTS_SECRETS_NO_AGENT', 'AGENTS_NO_USAGE_TRACK'] as const;
  let savedEnv: Record<string, string | undefined>;
  let savedSide: Record<string, string | undefined>;
  let be: CountingKeychainBackend;
  let prevBackend: KeychainBackend | null;

  /** Seed a real bundle carrying HCLOUD_TOKEN under the given prompt policy. */
  function seedLeaseBundle(policy: SecretsBundle['policy']): void {
    writeBundle({ name: BUNDLE, policy, vars: { HCLOUD_TOKEN: 'tok-once' } });
  }

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    savedSide = Object.fromEntries(SIDE_ENV.map((k) => [k, process.env[k]]));
    process.env.AGENTS_SECRETS_NO_AGENT = '1'; // force keychain path, skip secrets-agent broker
    process.env.AGENTS_NO_USAGE_TRACK = '1';
    be = new CountingKeychainBackend();
    prevBackend = setKeychainBackendForTest(be);
    resetCrabboxSecretsMemosForTest();
    // Hermetic lease-bundle resolution: no configured lease.secretsBundle. The
    // tailscale path scans listBundles() over the SAME real backend — the seeded
    // hetzner bundle declares no tailscale key, so pickTailscaleBundleFromList
    // finds nothing and only the lease read is exercised.
    vi.spyOn(stateModule, 'readMeta').mockReturnValue({} as ReturnType<typeof stateModule.readMeta>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setKeychainBackendForTest(prevBackend);
    resetCrabboxSecretsMemosForTest();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    for (const k of SIDE_ENV) {
      if (savedSide[k] === undefined) delete process.env[k];
      else process.env[k] = savedSide[k];
    }
  });

  it('resolves the provider token once and injects it, re-reading the keychain at most once', () => {
    seedLeaseBundle('never'); // no biometry ACL — the agentOnly read resolves silently
    const seedReads = be.gets; // reads done by writeBundle setup, if any

    const env1 = crabboxEnv({ secretsBundle: BUNDLE });
    const afterFirst = be.gets; // the ONE resolving keychain read
    const env2 = crabboxEnv({ secretsBundle: BUNDLE });
    const env3 = crabboxEnv({ secretsBundle: BUNDLE });

    expect(env1.HCLOUD_TOKEN).toBe('tok-once');
    expect(env2.HCLOUD_TOKEN).toBe('tok-once');
    expect(env3.HCLOUD_TOKEN).toBe('tok-once');
    // The real keychain read ran (proves we exercised the genuine path, not a memo
    // hit that never touched the backend)...
    expect(afterFirst).toBeGreaterThan(seedReads);
    // ...and it ran ONCE: the loop-repeated crabboxEnv calls serve the memo, so the
    // backend read count does not climb across env2/env3.
    expect(be.gets).toBe(afterFirst);
  });

  it('a LOCKED bundle throws the real "not unlocked" hint on the FIRST call — read issued once, not per call', () => {
    seedLeaseBundle('hold'); // biometry-ACL'd — the real agentOnly guard throws
    const seedReads = be.gets;

    // First call: the REAL readAndResolveBundleEnv agentOnly guard (bundles.ts:1345)
    // throws, wrapped by resolveLeaseEnvMemo's "Could not load" message.
    expect(() => crabboxEnv({ secretsBundle: BUNDLE })).toThrow(/not unlocked in the secrets agent/);
    const afterFirst = be.gets;
    // The memoized error is re-raised on repeat calls WITHOUT re-reading, so a poll
    // loop cannot re-storm it.
    expect(() => crabboxEnv({ secretsBundle: BUNDLE })).toThrow(/agents secrets unlock hetzner\.com/);
    expect(() => crabboxEnv({ secretsBundle: BUNDLE })).toThrow(/Could not load secrets bundle "hetzner\.com" for crabbox/);
    // The guard's readBundle metadata read happened at most once — repeat calls do
    // not touch the backend again (the memoized error short-circuits).
    expect(be.gets).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThanOrEqual(seedReads);
  });

  itPosix('the throw propagates out of crabboxWaitReady before its poll loop runs (fails loud, never polls)', async () => {
    // crabboxWaitReady's first action is crabboxFind → crabboxList → crabboxEnv,
    // which throws synchronously for a locked bundle. A fake `crabbox` is put on
    // PATH so findCrabbox() passes and crabboxEnv is the thing that throws (via the
    // REAL agentOnly guard over a seeded `hold` bundle). The injected `sleep`
    // records any poll iteration; assert it is NEVER called — the wait loop is not
    // entered, so there is no per-second re-read storm.
    seedLeaseBundle('hold');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-lease-lock-'));
    fs.writeFileSync(
      path.join(dir, 'crabbox'),
      ['#!/bin/sh', 'case "$1" in', '  --help) exit 0 ;;', '  *) echo "[]" ; exit 0 ;;', 'esac'].join('\n'),
      'utf-8',
    );
    fs.chmodSync(path.join(dir, 'crabbox'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    const { crabboxWaitReady } = await import('./cli.js');
    let polls = 0;
    const sleep = async () => { polls++; };
    try {
      await expect(
        crabboxWaitReady('some-slug', { secretsBundle: BUNDLE, timeoutMs: 60_000, intervalMs: 5_000, sleep }),
      ).rejects.toThrow(/not unlocked in the secrets agent/);
      expect(polls).toBe(0); // never entered the poll/sleep loop
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const NOW = 1_800_000_000; // fixed "now" in unix seconds

function box(over: Partial<CrabboxBox> = {}): CrabboxBox {
  return {
    name: 'crabbox-x',
    status: 'running',
    slug: 'x',
    lease: 'cbx_x',
    state: 'ready',
    ready: true,
    keep: true,
    createdAt: NOW - 10_000,
    expiresAt: NOW - 8_000, // expired by default
    lastTouchedAt: NOW - REAP_MIN_IDLE_SECS - 100, // stale by default
    idleTimeoutSecs: 1800,
    ...over,
  };
}

describe('isReapSafe', () => {
  it('reaps a genuine orphan: expired lease AND stale touch', () => {
    expect(isReapSafe(box(), NOW)).toBe(true);
  });

  it('never reaps a box touched within the safety window (TOCTOU guard)', () => {
    // Expired lease, but touched 1 minute ago → a concurrent run may be using it.
    expect(isReapSafe(box({ lastTouchedAt: NOW - 60 }), NOW)).toBe(false);
  });

  it('never reaps a box whose lease has not expired', () => {
    expect(isReapSafe(box({ expiresAt: NOW + 1_000 }), NOW)).toBe(false);
  });

  it('honors max(2×idleTimeout, 1h): a long idle-timeout widens the window', () => {
    // idleTimeout 40m → window = 80m. Touched 70m ago is still inside it.
    const b = box({ idleTimeoutSecs: 2400, lastTouchedAt: NOW - 70 * 60 });
    expect(isReapSafe(b, NOW)).toBe(false);
    // Touched 90m ago is outside the 80m window.
    expect(isReapSafe(box({ idleTimeoutSecs: 2400, lastTouchedAt: NOW - 90 * 60 }), NOW)).toBe(true);
  });

  it('never reaps a box with unknown age (null expiresAt or lastTouchedAt)', () => {
    expect(isReapSafe(box({ expiresAt: null }), NOW)).toBe(false);
    expect(isReapSafe(box({ lastTouchedAt: null }), NOW)).toBe(false);
  });
});

describe('reapSafeOrphans', () => {
  it('filters to orphans and sorts most-stale first', () => {
    const fresh = box({ slug: 'fresh', lastTouchedAt: NOW - 30 });          // in use
    const active = box({ slug: 'active', expiresAt: NOW + 500 });           // lease live
    const oldOrphan = box({ slug: 'old', lastTouchedAt: NOW - 100_000 });
    const newOrphan = box({ slug: 'new', lastTouchedAt: NOW - REAP_MIN_IDLE_SECS - 10 });
    const out = reapSafeOrphans([fresh, active, newOrphan, oldOrphan], NOW);
    expect(out.map((b) => b.slug)).toEqual(['old', 'new']); // oldest touch first, in-use/active excluded
  });

  it('returns empty when nothing is reap-safe', () => {
    expect(reapSafeOrphans([box({ expiresAt: NOW + 1 })], NOW)).toEqual([]);
  });
});

describePosix('normalizeBox tailscale fields (via crabboxList)', () => {
  installHermeticLease();
  function withFakeCrabbox(listJson: unknown, fn: (dir: string) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-ts-'));
    const listPath = path.join(dir, 'boxes.json');
    fs.writeFileSync(listPath, JSON.stringify(listJson), 'utf-8');
    fs.writeFileSync(
      path.join(dir, 'crabbox'),
      ['#!/bin/sh', 'case "$1" in', '  --help) exit 0 ;;', '  list) cat "$CRABBOX_LIST"; exit 0 ;;', '  *) exit 1 ;;', 'esac'].join('\n'),
      'utf-8',
    );
    fs.chmodSync(path.join(dir, 'crabbox'), 0o755);
    const oldPath = process.env.PATH;
    const oldList = process.env.CRABBOX_LIST;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    process.env.CRABBOX_LIST = listPath;
    try {
      fn(dir);
    } finally {
      process.env.PATH = oldPath;
      if (oldList === undefined) delete process.env.CRABBOX_LIST;
      else process.env.CRABBOX_LIST = oldList;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('parses tailscale_ipv4 / tailscale_fqdn from the box labels', () => {
    withFakeCrabbox(
      [
        {
          name: 'crabbox-tailnet',
          status: 'running',
          labels: {
            slug: 'tailnet-one',
            lease: 'cbx_ts',
            state: 'ready',
            tailscale_ipv4: '100.101.102.103',
            tailscale_fqdn: 'tailnet-one.tail1234.ts.net',
          },
          public_net: { ipv4: { ip: '203.0.113.9' } },
        },
      ],
      () => {
        const boxes = crabboxList();
        expect(boxes).toHaveLength(1);
        expect(boxes[0].tailscaleIPv4).toBe('100.101.102.103');
        expect(boxes[0].tailscaleFQDN).toBe('tailnet-one.tail1234.ts.net');
        expect(boxes[0].ip).toBe('203.0.113.9');
      },
    );
  });

  it('leaves tailscale fields undefined for a public-network box', () => {
    withFakeCrabbox(
      [{ name: 'crabbox-pub', status: 'running', labels: { slug: 'pub', lease: 'cbx_p', state: 'ready' } }],
      () => {
        const [b] = crabboxList();
        expect(b.tailscaleIPv4).toBeUndefined();
        expect(b.tailscaleFQDN).toBeUndefined();
      },
    );
  });
});

describePosix('crabboxList timeout — a slow provider never hangs an ambient command', () => {
  installHermeticLease();
  it('throws (does not hang) when `crabbox list` exceeds timeoutMs', () => {
    // Fake crabbox: --help is instant (findCrabbox passes), `list` blocks 30s.
    // With timeoutMs=400 the spawn is killed and we throw a clear message fast —
    // this is what keeps `agents devices` / `agents ssh <typo>` from blocking on
    // a slow/unreachable provider API.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-slow-'));
    fs.writeFileSync(
      path.join(dir, 'crabbox'),
      ['#!/bin/sh', 'case "$1" in', '  --help) exit 0 ;;', '  list) sleep 30 ;;', '  *) exit 1 ;;', 'esac'].join('\n'),
      'utf-8',
    );
    fs.chmodSync(path.join(dir, 'crabbox'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    const startedAt = Date.now();
    try {
      expect(() => crabboxList({ timeoutMs: 400 })).toThrow(/timed out/);
      expect(Date.now() - startedAt).toBeLessThan(5000); // killed near the bound, not after 30s
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describePosix('crabboxWarmup netMode', () => {
  installHermeticLease();
  // A fake crabbox that records argv for `warmup` and returns a fresh box on `list`.
  function withRecordingCrabbox(fn: (log: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-warm-'));
    const log = path.join(dir, 'crabbox.log');
    const before = path.join(dir, 'before.json');
    const after = path.join(dir, 'after.json');
    fs.writeFileSync(before, JSON.stringify([]), 'utf-8');
    fs.writeFileSync(
      after,
      JSON.stringify([
        { name: 'crabbox-new', status: 'running', labels: { slug: 'new', lease: 'cbx_new', state: 'ready' } },
      ]),
      'utf-8',
    );
    // list returns `before` until warmup runs (which flips a marker file), then `after`.
    fs.writeFileSync(
      path.join(dir, 'crabbox'),
      [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$CRABBOX_LOG"',
        'case "$1" in',
        '  --help) exit 0 ;;',
        '  warmup) touch "$CRABBOX_DIR/warmed"; echo "leased cbx_new"; exit 0 ;;',
        '  list) if [ -f "$CRABBOX_DIR/warmed" ]; then cat "$CRABBOX_DIR/after.json"; else cat "$CRABBOX_DIR/before.json"; fi; exit 0 ;;',
        '  *) exit 1 ;;',
        'esac',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(path.join(dir, 'crabbox'), 0o755);
    const old = { PATH: process.env.PATH, CRABBOX_LOG: process.env.CRABBOX_LOG, CRABBOX_DIR: process.env.CRABBOX_DIR };
    process.env.PATH = `${dir}${path.delimiter}${old.PATH ?? ''}`;
    process.env.CRABBOX_LOG = log;
    process.env.CRABBOX_DIR = dir;
    return fn(log).finally(() => {
      for (const [k, v] of Object.entries(old)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it('adds --network tailscale and -tailscale-tags for a tailscale lease', async () => {
    await withRecordingCrabbox(async (log) => {
      const box = await crabboxWarmup({ netMode: 'tailscale' });
      expect(box.slug).toBe('new');
      const warmupLine = fs.readFileSync(log, 'utf-8').split('\n').find((l) => l.startsWith('warmup'));
      expect(warmupLine).toContain('--network tailscale');
      expect(warmupLine).toContain('-tailscale-tags tag:crabbox');
    });
  });

  it('omits tailscale flags for the default public lease', async () => {
    await withRecordingCrabbox(async (log) => {
      await crabboxWarmup({});
      const warmupLine = fs.readFileSync(log, 'utf-8').split('\n').find((l) => l.startsWith('warmup'));
      expect(warmupLine).not.toContain('tailscale');
    });
  });
});

describe('parseCrabboxSshArgv', () => {
  it('parses the shell-quoted ssh command crabbox emits (key + endpoint)', () => {
    const out = `lease cbx_x is claimed\n'ssh' '-i' '/home/u/.config/crabbox/testboxes/cbx_x/id_ed25519' '-o' 'IdentitiesOnly=yes' '-p' '2222' 'crabbox@157.90.242.199'\n`;
    const argv = parseCrabboxSshArgv(out);
    expect(argv?.[0]).toBe('ssh');
    expect(argv).toContain('/home/u/.config/crabbox/testboxes/cbx_x/id_ed25519');
    expect(argv?.[argv.length - 1]).toBe('crabbox@157.90.242.199');
  });

  it('returns null when no ssh command line is present', () => {
    expect(parseCrabboxSshArgv('lease not found\nsome error\n')).toBeNull();
  });
});
