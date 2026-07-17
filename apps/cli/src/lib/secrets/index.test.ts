/**
 * Tests for the platform-gated secret-value guard.
 *
 * The newline rejection exists ONLY to protect the macOS `get-batch` read path,
 * which is newline-delimited (see getKeychainTokens). Windows Credential Manager
 * (base64 blob) and the encrypted-file fallback store raw bytes and MUST accept
 * multiline values (PEM / SSH keys), so the guard is darwin-only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  assertValueStorable,
  buildAddGenericPasswordArgs,
  computeRekeyPlan,
  deleteKeychainToken,
  getKeychainToken,
  getKeychainTokens,
  hasKeychainToken,
  hashedServiceName,
  HMAC_KEY_ITEM,
  keychainServiceAlias,
  listKeychainItems,
  parseOrphanMigrationOutput,
  rekeyServiceNames,
  setKeychainBackendForTest,
  setKeychainServiceHashingForTest,
  setKeychainToken,
  withRawKeychainServiceNames,
  type KeychainBackend,
} from './index.js';

describe('buildAddGenericPasswordArgs (RUSH-1764: value never in argv)', () => {
  it('omits the secret value from argv — it travels over stdin instead', () => {
    const secret = 'sk-super-secret-value-1234567890';
    const args = buildAddGenericPasswordArgs('alice', 'linear-api-key');
    // The whole point: the value must not appear anywhere in the command line.
    expect(args.some((a) => a.includes(secret))).toBe(false);
    expect(args).not.toContain(secret);
    // Still the right item write: upsert (-U), account (-a), service (-s), and a
    // BARE `-w` last so security prompts and reads the value from stdin -- the flag
    // carries no value, so the secret is still absent from argv.
    expect(args).toEqual(['add-generic-password', '-U', '-a', 'alice', '-s', 'linear-api-key', '-w']);
    expect(args[args.length - 1]).toBe('-w');
  });
});

describe('assertValueStorable', () => {
  const multiline = '-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----\n';

  it('rejects empty / whitespace-only values on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(() => assertValueStorable('', platform)).toThrow(/empty/i);
      expect(() => assertValueStorable('   ', platform)).toThrow(/empty/i);
    }
  });

  it('darwin still rejects embedded newlines (batch-read framing)', () => {
    expect(() => assertValueStorable(multiline, 'darwin')).toThrow(/newline/i);
    expect(() => assertValueStorable('a\rb', 'darwin')).toThrow(/newline/i);
  });

  it('darwin accepts single-line values', () => {
    expect(() => assertValueStorable('sk-single-line-token', 'darwin')).not.toThrow();
  });

  it('win32 accepts multiline values (CredMan / file store are newline-safe)', () => {
    expect(() => assertValueStorable(multiline, 'win32')).not.toThrow();
  });

  it('linux accepts multiline values (secret-tool / file store are newline-safe)', () => {
    expect(() => assertValueStorable(multiline, 'linux')).not.toThrow();
  });
});

describe('parseOrphanMigrationOutput', () => {
  it('parses OK / WARN / FAIL records and ignores blanks + unknown lines', () => {
    const out = [
      'OK agents-cli.secrets.hetzner.com.HCLOUD_TOKEN',
      '',
      'WARN agents-cli.secrets.ssh-keys.ED25519_PRIVKEY_B64 orphan-delete=-25300 (pinned copy in place)',
      'FAIL agents-cli.secrets.attio.com.EMAIL add=-34018',
      '   ', // whitespace-only
      'garbage line with no tag',
    ].join('\n');
    const results = parseOrphanMigrationOutput(out);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ item: 'agents-cli.secrets.hetzner.com.HCLOUD_TOKEN', status: 'ok' });
    // WARN/FAIL keep only the service in `item`, full text in `detail`.
    expect(results[1].item).toBe('agents-cli.secrets.ssh-keys.ED25519_PRIVKEY_B64');
    expect(results[1].status).toBe('warn');
    expect(results[1].detail).toContain('orphan-delete=-25300');
    expect(results[2]).toMatchObject({ item: 'agents-cli.secrets.attio.com.EMAIL', status: 'fail' });
    expect(results[2].detail).toContain('add=-34018');
  });

  it('returns [] for empty output', () => {
    expect(parseOrphanMigrationOutput('')).toEqual([]);
    expect(parseOrphanMigrationOutput('\n\n')).toEqual([]);
  });
});

// ─── Hashed service names + one-time re-key (GitHub #316) ───────────────────
//
// These run the real primitives against the in-memory backend with hashing
// forced via the test seam — the exact transform production applies on macOS,
// minus the signed helper (whose get/set/delete/list treat service names as
// opaque strings and needed no change).

class MemBackend implements KeychainBackend {
  store = new Map<string, string>();
  /** Item name whose `set` should throw (injects a mid-re-key write failure). */
  failOnSet: string | null = null;
  /** Items written through the no-ACL path (setKeychainToken `opts.noAcl`). */
  noAclWrites = new Set<string>();
  has(item: string) { return this.store.has(item); }
  get(item: string) {
    const v = this.store.get(item);
    if (v === undefined) throw new Error(`missing ${item}`);
    return v;
  }
  set(item: string, value: string, opts?: { noAcl?: boolean }) {
    if (this.failOnSet !== null && item === this.failOnSet) throw new Error(`injected write failure for '${item}'`);
    if (opts?.noAcl) this.noAclWrites.add(item);
    this.store.set(item, value);
  }
  delete(item: string) { return this.store.delete(item); }
  list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
}

const HASHED_META = /^agents-cli\.h\.[0-9a-f]{32}\.m$/;
const HASHED_VALUE = /^agents-cli\.h\.[0-9a-f]{32}\.k\.[0-9a-f]{32}$/;
const HASHED_OTHER = /^agents-cli\.h\.o\.[0-9a-f]{32}$/;

describe('hashedServiceName (#316 transform)', () => {
  const key = randomBytes(32);

  it('maps the three cleartext shapes to their opaque forms', () => {
    expect(hashedServiceName('agents-cli.bundles.prod', key)).toMatch(HASHED_META);
    expect(hashedServiceName('agents-cli.secrets.prod.API_KEY', key)).toMatch(HASHED_VALUE);
    expect(hashedServiceName('agents-cli.anthropic.token', key)).toMatch(HASHED_OTHER);
  });

  it("keeps a bundle's metadata and values under one hashed namespace (single-prompt batch reads)", () => {
    const ns = (s: string) => s.split('.')[2]; // agents-cli | h | <ns> | ...
    const meta = hashedServiceName('agents-cli.bundles.prod', key);
    const v1 = hashedServiceName('agents-cli.secrets.prod.API_KEY', key);
    const v2 = hashedServiceName('agents-cli.secrets.prod.DB_URL', key);
    const other = hashedServiceName('agents-cli.bundles.staging', key);
    expect(ns(meta)).toBe(ns(v1));
    expect(ns(v1)).toBe(ns(v2));
    expect(ns(other)).not.toBe(ns(meta));
    expect(v1).not.toBe(v2);
  });

  it('splits bundle/key at the LAST dot (bundle names may contain dots; keys never do)', () => {
    const ns = (s: string) => s.split('.')[2];
    const meta = hashedServiceName('agents-cli.bundles.hetzner.com', key);
    const value = hashedServiceName('agents-cli.secrets.hetzner.com.HCLOUD_TOKEN', key);
    expect(ns(meta)).toBe(ns(value));
  });

  it('is keyed: a different HMAC key yields entirely different names', () => {
    const other = randomBytes(32);
    expect(hashedServiceName('agents-cli.bundles.prod', key))
      .not.toBe(hashedServiceName('agents-cli.bundles.prod', other));
  });
});

describe('service-name hashing through the primitives', () => {
  let mem: MemBackend;
  let prev: KeychainBackend | null = null;
  const key = randomBytes(32);

  beforeEach(() => {
    mem = new MemBackend();
    prev = setKeychainBackendForTest(mem);
    setKeychainServiceHashingForTest(key);
  });
  afterEach(() => {
    setKeychainServiceHashingForTest(null);
    setKeychainBackendForTest(prev);
  });

  it('stores under hashed names but round-trips by cleartext name', () => {
    setKeychainToken('agents-cli.secrets.prod.API_KEY', 'sk-123');
    expect(getKeychainToken('agents-cli.secrets.prod.API_KEY')).toBe('sk-123');
    expect(hasKeychainToken('agents-cli.secrets.prod.API_KEY')).toBe(true);
    // The storage layer holds ONLY the opaque name — the leak this closes.
    expect([...mem.store.keys()]).toEqual([hashedServiceName('agents-cli.secrets.prod.API_KEY', key)]);
    expect(deleteKeychainToken('agents-cli.secrets.prod.API_KEY')).toBe(true);
    expect(mem.store.size).toBe(0);
  });

  it('getKeychainTokens keys its result by the names the caller passed (cleartext or hashed)', () => {
    setKeychainToken('agents-cli.secrets.prod.A', 'va');
    setKeychainToken('agents-cli.secrets.prod.B', 'vb');
    const hashedB = hashedServiceName('agents-cli.secrets.prod.B', key);
    const fetched = getKeychainTokens(['agents-cli.secrets.prod.A', hashedB, 'agents-cli.secrets.prod.MISSING']);
    expect(fetched.get('agents-cli.secrets.prod.A')).toBe('va');
    expect(fetched.get(hashedB)).toBe('vb');
    expect(fetched.size).toBe(2);
  });

  it('maps the bundle-metadata list prefix and filters to hashed meta items', () => {
    setKeychainToken('agents-cli.bundles.prod', '{}');
    setKeychainToken('agents-cli.secrets.prod.A', 'va');
    setKeychainToken('agents-cli.anthropic.token', 'tok');
    const metas = listKeychainItems('agents-cli.bundles.');
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatch(HASHED_META);
  });

  it("maps a bundle's value-item list prefix to its hashed namespace only", () => {
    setKeychainToken('agents-cli.secrets.prod.A', 'va');
    setKeychainToken('agents-cli.secrets.prod.B', 'vb');
    setKeychainToken('agents-cli.secrets.staging.C', 'vc');
    setKeychainToken('agents-cli.bundles.prod', '{}');
    const items = listKeychainItems('agents-cli.secrets.prod.');
    expect(items).toHaveLength(2);
    for (const s of items) expect(s).toMatch(HASHED_VALUE);
    expect(items).toContain(hashedServiceName('agents-cli.secrets.prod.A', key));
    expect(items).not.toContain(hashedServiceName('agents-cli.secrets.staging.C', key));
  });

  it('leaves foreign items and the HMAC key item untransformed', () => {
    setKeychainToken('linear-api-key', 'lk');
    setKeychainToken(HMAC_KEY_ITEM, '{"v":1}');
    expect(mem.store.has('linear-api-key')).toBe(true);
    expect(mem.store.has(HMAC_KEY_ITEM)).toBe(true);
  });

  it('withRawKeychainServiceNames suspends the transform for migration flows', () => {
    withRawKeychainServiceNames(() => setKeychainToken('agents-cli.secrets.prod.RAW', 'old'));
    expect(mem.store.has('agents-cli.secrets.prod.RAW')).toBe(true);
    // Hashed-mode read misses the cleartext leftover; the raw read hits it.
    expect(() => getKeychainToken('agents-cli.secrets.prod.RAW')).toThrow();
    expect(withRawKeychainServiceNames(() => getKeychainToken('agents-cli.secrets.prod.RAW'))).toBe('old');
  });

  it('keychainServiceAlias exposes the storage name for mixed-lookup callers', () => {
    expect(keychainServiceAlias('agents-cli.secrets.prod.A')).toBe(hashedServiceName('agents-cli.secrets.prod.A', key));
    expect(keychainServiceAlias('linear-api-key')).toBe('linear-api-key');
    setKeychainServiceHashingForTest(null);
    // Hashing off (backend installed, no force) → identity.
    expect(keychainServiceAlias('agents-cli.secrets.prod.A')).toBe('agents-cli.secrets.prod.A');
  });
});

describe('computeRekeyPlan', () => {
  const key = randomBytes(32);

  it('preserves the no-ACL tier for never-policy bundles and injects the name into metadata', () => {
    const services = [
      'agents-cli.bundles.autobot',
      'agents-cli.secrets.autobot.CRON_TOKEN',
      'agents-cli.bundles.prod',
      'agents-cli.secrets.prod.API_KEY',
      'agents-cli.anthropic.token',
    ];
    const values = new Map([
      ['agents-cli.bundles.autobot', JSON.stringify({ tier: 'none', vars: { CRON_TOKEN: 'keychain:CRON_TOKEN' } })],
      ['agents-cli.secrets.autobot.CRON_TOKEN', 'ct'],
      ['agents-cli.bundles.prod', JSON.stringify({ tier: 'session', vars: {} })],
      ['agents-cli.secrets.prod.API_KEY', 'sk'],
      ['agents-cli.anthropic.token', 'tok'],
    ]);
    const { items, unreadable } = computeRekeyPlan(services, values, key);
    expect(unreadable).toEqual([]);
    const byOld = Object.fromEntries(items.map((i) => [i.oldService, i]));
    expect(byOld['agents-cli.bundles.autobot'].noAcl).toBe(true);
    expect(byOld['agents-cli.secrets.autobot.CRON_TOKEN'].noAcl).toBe(true);
    expect(byOld['agents-cli.bundles.prod'].noAcl).toBe(false);
    expect(byOld['agents-cli.secrets.prod.API_KEY'].noAcl).toBe(false);
    expect(byOld['agents-cli.anthropic.token'].noAcl).toBe(false);
    expect(JSON.parse(byOld['agents-cli.bundles.prod'].payload!).name).toBe('prod');
    expect(byOld['agents-cli.anthropic.token'].newService).toMatch(HASHED_OTHER);
  });

  it("resolves a value item's tier from a metadata payload outside the batch (cleartext or hashed name)", () => {
    // A --prefix run scopes only the value items; rekeyServiceNames supplies
    // the bundle-metadata reads. The plan must find the tier whether the
    // metadata still sits at its cleartext name or was already moved to its
    // hashed name by an earlier partial run.
    const meta = JSON.stringify({ tier: 'never', vars: { T: 'keychain:T' } });
    const viaCleartext = computeRekeyPlan(
      ['agents-cli.secrets.autobot.T'],
      new Map([
        ['agents-cli.secrets.autobot.T', 'silent'],
        ['agents-cli.bundles.autobot', meta],
      ]),
      key,
    );
    expect(viaCleartext.items).toHaveLength(1);
    expect(viaCleartext.items[0].noAcl).toBe(true);

    const viaHashed = computeRekeyPlan(
      ['agents-cli.secrets.autobot.T'],
      new Map([
        ['agents-cli.secrets.autobot.T', 'silent'],
        [hashedServiceName('agents-cli.bundles.autobot', key), meta],
      ]),
      key,
    );
    expect(viaHashed.items).toHaveLength(1);
    expect(viaHashed.items[0].noAcl).toBe(true);

    // No metadata anywhere (standalone item, no backing bundle) → ACL'd.
    const standalone = computeRekeyPlan(
      ['agents-cli.secrets.wallet.3f2a9c1d4e5b'],
      new Map([['agents-cli.secrets.wallet.3f2a9c1d4e5b', 'cvv']]),
      key,
    );
    expect(standalone.items[0].noAcl).toBe(false);
  });

  it('reports unreadable services instead of dropping them', () => {
    const { items, unreadable } = computeRekeyPlan(['agents-cli.bundles.gone'], new Map(), key);
    expect(items).toEqual([]);
    expect(unreadable).toEqual(['agents-cli.bundles.gone']);
  });
});

describe('rekeyServiceNames (one-time migration)', () => {
  let mem: MemBackend;
  let prev: KeychainBackend | null = null;

  const seedCleartext = () => {
    mem.store.set('agents-cli.anthropic.token', 'tok-1');
    mem.store.set('agents-cli.bundles.prod', JSON.stringify({ tier: 'session', vars: { API_KEY: 'keychain:API_KEY' } }));
    mem.store.set('agents-cli.secrets.prod.API_KEY', 'sk-prod');
    mem.store.set('agents-cli.bundles.autobot', JSON.stringify({ tier: 'none', vars: { T: 'keychain:T' } }));
    mem.store.set('agents-cli.secrets.autobot.T', 'silent');
    mem.store.set('agents-cli.secrets.wallet.3f2a9c1d4e5b', 'card-cvv');
  };

  beforeEach(() => {
    mem = new MemBackend();
    prev = setKeychainBackendForTest(mem);
  });
  afterEach(() => {
    setKeychainServiceHashingForTest(null);
    setKeychainBackendForTest(prev);
  });

  const storedRecord = () => JSON.parse(mem.store.get(HMAC_KEY_ITEM)!) as { k: string; migrated: boolean; pendingDeletes?: string[] };

  it('moves every cleartext item to a hashed name, injects bundle names, and activates', () => {
    seedCleartext();
    const report = rekeyServiceNames();
    expect(report.activated).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.migrated).toHaveLength(6);

    const rec = storedRecord();
    expect(rec.migrated).toBe(true);
    expect(rec.pendingDeletes).toBeUndefined();

    // No cleartext-named item remains (only the hmackey record itself).
    const leftovers = [...mem.store.keys()].filter((k) => !k.startsWith('agents-cli.h.') && k !== HMAC_KEY_ITEM);
    expect(leftovers).toEqual([]);

    // Every value round-trips under its hashed name, computed from the stored key.
    const key = Buffer.from(rec.k, 'hex');
    expect(mem.store.get(hashedServiceName('agents-cli.anthropic.token', key))).toBe('tok-1');
    expect(mem.store.get(hashedServiceName('agents-cli.secrets.prod.API_KEY', key))).toBe('sk-prod');
    expect(mem.store.get(hashedServiceName('agents-cli.secrets.wallet.3f2a9c1d4e5b', key))).toBe('card-cvv');
    const meta = JSON.parse(mem.store.get(hashedServiceName('agents-cli.bundles.prod', key))!);
    expect(meta.name).toBe('prod');
    expect(meta.tier).toBe('session');

    // With hashing active under the stored key, normal reads resolve by cleartext name.
    setKeychainServiceHashingForTest(key);
    expect(getKeychainToken('agents-cli.anthropic.token')).toBe('tok-1');
    expect(getKeychainToken('agents-cli.secrets.autobot.T')).toBe('silent');
  });

  it('is idempotent: a second run is a no-op', () => {
    seedCleartext();
    expect(rekeyServiceNames().activated).toBe(true);
    const snapshot = new Map(mem.store);
    const second = rekeyServiceNames();
    expect(second.nothingToDo).toBe(true);
    expect(second.activated).toBe(true);
    expect(mem.store).toEqual(snapshot);
  });

  it('activates immediately on a machine with nothing to move', () => {
    const report = rekeyServiceNames();
    expect(report.nothingToDo).toBe(true);
    expect(report.activated).toBe(true);
    expect(storedRecord().migrated).toBe(true);
  });

  it('on any per-item failure: deletes NOTHING, does not activate, and a re-run converges', () => {
    seedCleartext();
    // Fail the hashed write of one specific item. The target name depends on
    // the run's key, so trap it via a first probe: run once with a key we
    // control by pre-creating the record.
    const key = randomBytes(32);
    mem.store.set(HMAC_KEY_ITEM, JSON.stringify({ v: 1, k: key.toString('hex'), migrated: false }));
    mem.failOnSet = hashedServiceName('agents-cli.secrets.prod.API_KEY', key);

    const report = rekeyServiceNames();
    expect(report.activated).toBe(false);
    expect(report.migrated).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].item).toBe('agents-cli.secrets.prod.API_KEY');

    // All-or-nothing: every old item is still present and readable.
    for (const old of [
      'agents-cli.anthropic.token',
      'agents-cli.bundles.prod',
      'agents-cli.secrets.prod.API_KEY',
      'agents-cli.secrets.autobot.T',
    ]) {
      expect(mem.store.has(old)).toBe(true);
    }
    expect(storedRecord().migrated).toBe(false);

    // Heal the store; the re-run finishes the job.
    mem.failOnSet = null;
    const second = rekeyServiceNames();
    expect(second.activated).toBe(true);
    expect(second.failed).toEqual([]);
    expect(mem.store.has('agents-cli.secrets.prod.API_KEY')).toBe(false);
    expect(mem.store.get(hashedServiceName('agents-cli.secrets.prod.API_KEY', key))).toBe('sk-prod');
  });

  it('resumes a crash-interrupted delete phase from pendingDeletes', () => {
    // Simulate a crash after activation but before the old-name deletes: both
    // copies exist, the record lists the pending deletes.
    const key = randomBytes(32);
    mem.store.set('agents-cli.secrets.prod.API_KEY', 'sk-prod');
    mem.store.set(hashedServiceName('agents-cli.secrets.prod.API_KEY', key), 'sk-prod');
    mem.store.set(
      HMAC_KEY_ITEM,
      JSON.stringify({ v: 1, k: key.toString('hex'), migrated: true, pendingDeletes: ['agents-cli.secrets.prod.API_KEY'] }),
    );
    const report = rekeyServiceNames();
    expect(report.nothingToDo).toBe(true);
    expect(report.activated).toBe(true);
    expect(mem.store.has('agents-cli.secrets.prod.API_KEY')).toBe(false);
    expect(mem.store.get(hashedServiceName('agents-cli.secrets.prod.API_KEY', key))).toBe('sk-prod');
    expect(storedRecord().pendingDeletes).toBeUndefined();
  });

  it('refuses to decide anything on a degraded enumeration (locked keybag)', () => {
    // Live-observed hazard on macOS 26: with the DP keybag locked (screen
    // lock), the helper's `list` silently returns NOTHING while no-ACL writes
    // and reads still work. An unguarded re-key would see "zero cleartext
    // items" and wrongly activate hashing over invisible cleartext items.
    seedCleartext();
    const realList = mem.list.bind(mem);
    mem.list = () => []; // enumeration lies: nothing visible
    expect(() => rekeyServiceNames()).toThrow(/enumeration is unavailable/i);
    // Not activated; nothing moved or deleted.
    expect(storedRecord().migrated).toBe(false);
    mem.list = realList;
    const leftovers = [...mem.store.keys()].filter((k) => !k.startsWith('agents-cli.h.') && k !== HMAC_KEY_ITEM);
    expect(leftovers).toHaveLength(6);
  });

  it('a --prefix-restricted run moves only matching items and never activates', () => {
    seedCleartext();
    const report = rekeyServiceNames({ prefixes: ['agents-cli.secrets.wallet.'] });
    expect(report.migrated).toEqual(['agents-cli.secrets.wallet.3f2a9c1d4e5b']);
    expect(report.activated).toBe(false);
    expect(storedRecord().migrated).toBe(false);
    // Unmatched items untouched.
    expect(mem.store.has('agents-cli.secrets.prod.API_KEY')).toBe(true);
    expect(mem.store.has('agents-cli.secrets.wallet.3f2a9c1d4e5b')).toBe(false);
  });

  it("a --prefix run scoping only a never-bundle's value items preserves the no-ACL tier (metadata resolved from the keychain, not the batch)", () => {
    // Regression (PR #900 review): scoping `agents-cli.secrets.autobot.`
    // WITHOUT `agents-cli.bundles.autobot` used to re-write the never-policy
    // bundle's values WITH a biometry ACL — silently breaking headless reads,
    // one-way, because the cleartext originals were already deleted.
    seedCleartext();
    const report = rekeyServiceNames({ prefixes: ['agents-cli.secrets.autobot.'] });
    expect(report.migrated).toEqual(['agents-cli.secrets.autobot.T']);
    expect(report.activated).toBe(false);

    const key = Buffer.from(storedRecord().k, 'hex');
    const hashedValue = hashedServiceName('agents-cli.secrets.autobot.T', key);
    expect(mem.store.get(hashedValue)).toBe('silent');
    expect(mem.store.has('agents-cli.secrets.autobot.T')).toBe(false);
    // The tier survived: the hashed copy went through the no-ACL write path.
    expect(mem.noAclWrites.has(hashedValue)).toBe(true);
    // The metadata item was only READ for its tier — this run never moved it.
    expect(mem.store.has('agents-cli.bundles.autobot')).toBe(true);
    // Contrast: the session-tier bundle's value keeps its ACL on a later scope.
    rekeyServiceNames({ prefixes: ['agents-cli.secrets.prod.'] });
    expect(mem.noAclWrites.has(hashedServiceName('agents-cli.secrets.prod.API_KEY', key))).toBe(false);
  });

  it('a --prefix run finds the tier even when the metadata item was moved by an earlier partial run', () => {
    seedCleartext();
    // First partial run moves ONLY the metadata item to its hashed name.
    rekeyServiceNames({ prefixes: ['agents-cli.bundles.autobot'] });
    expect(mem.store.has('agents-cli.bundles.autobot')).toBe(false);
    // Second partial run scopes only the value items — the tier must come
    // from the already-hashed metadata copy.
    const report = rekeyServiceNames({ prefixes: ['agents-cli.secrets.autobot.'] });
    expect(report.migrated).toEqual(['agents-cli.secrets.autobot.T']);
    const key = Buffer.from(storedRecord().k, 'hex');
    expect(mem.noAclWrites.has(hashedServiceName('agents-cli.secrets.autobot.T', key))).toBe(true);
  });
});
