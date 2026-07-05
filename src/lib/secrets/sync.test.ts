import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setKeychainBackendForTest,
  secretsKeychainItem,
  type KeychainBackend,
} from './index.js';
import { readBundle, type SecretsBundle } from './bundles.js';
import {
  encryptBlob,
  pullBundle,
  setSyncBackend,
  type BundleSnapshot,
} from './sync.js';
import type { SyncBackend, SyncEnvelope, RemoteBundleSummary } from './sync-backend.js';

/**
 * In-memory keychain backend that can be told to throw on a specific item's
 * write, so we can inject a mid-restore failure and assert the rollback leaves
 * the store exactly as it was. This swaps the STORAGE layer only — the code
 * under test (restoreSnapshot, reached through pullBundle) runs for real.
 */
class FailingKeychain implements KeychainBackend {
  readonly store = new Map<string, string>();
  /** Item name whose `set` should throw; null = never fail. */
  failOnSet: string | null = null;

  has(item: string): boolean {
    return this.store.has(item);
  }
  get(item: string): string {
    if (!this.store.has(item)) throw new Error(`Keychain item '${item}' not found.`);
    return this.store.get(item)!;
  }
  set(item: string, value: string): void {
    if (this.failOnSet !== null && item === this.failOnSet) {
      throw new Error(`injected write failure for '${item}'`);
    }
    this.store.set(item, value);
  }
  delete(item: string): boolean {
    return this.store.delete(item);
  }
  list(prefix: string): string[] {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

/** A sync backend that hands back a single fixed envelope for getEnvelope. */
function fixedBackend(envelope: SyncEnvelope): SyncBackend {
  return {
    async putEnvelope(): Promise<void> {},
    async getEnvelope(): Promise<SyncEnvelope | null> {
      return envelope;
    },
    async deleteEnvelope(): Promise<boolean> {
      return true;
    },
    async listEnvelopes(): Promise<RemoteBundleSummary[]> {
      return [];
    },
  };
}

const PASSPHRASE = 'correct-horse-battery-staple';
const NAME = 'demo';

// Order matters: AKEY (pre-existing) is overwritten, CKEY (new) is created,
// then the write of BKEY fails — so rollback must both restore AKEY to its
// original value AND delete the freshly-created CKEY, and leave metadata
// untouched.
function makeSnapshot(): BundleSnapshot {
  const bundle: SecretsBundle = {
    name: NAME,
    vars: {
      AKEY: 'keychain:AKEY',
      CKEY: 'keychain:CKEY',
      BKEY: 'keychain:BKEY',
    },
  };
  const secrets: Record<string, string> = {
    AKEY: 'new-a',
    CKEY: 'new-c',
    BKEY: 'new-b',
  };
  return { bundle, secrets };
}

function envelopeFor(snap: BundleSnapshot): SyncEnvelope {
  return {
    envelope: encryptBlob(JSON.stringify(snap), PASSPHRASE),
    updated_at: '2026-07-05T00:00:00.000Z',
  };
}

let kc: FailingKeychain;
let prevKc: KeychainBackend | null;
let prevBackend: SyncBackend;
const prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
const prevNoUsage = process.env.AGENTS_NO_USAGE_TRACK;

beforeEach(() => {
  kc = new FailingKeychain();
  prevKc = setKeychainBackendForTest(kc);
  // Keep the restore path hermetic — no secrets-agent socket, no last_used write.
  process.env.AGENTS_SECRETS_NO_AGENT = '1';
  process.env.AGENTS_NO_USAGE_TRACK = '1';
});

afterEach(() => {
  setKeychainBackendForTest(prevKc);
  if (prevBackend) setSyncBackend(prevBackend);
  if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
  else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
  if (prevNoUsage === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
  else process.env.AGENTS_NO_USAGE_TRACK = prevNoUsage;
});

describe('pullBundle restore atomicity', () => {
  it('rolls back completely when a keychain write fails mid-restore', async () => {
    const aItem = secretsKeychainItem(NAME, 'AKEY');
    const bItem = secretsKeychainItem(NAME, 'BKEY');
    const cItem = secretsKeychainItem(NAME, 'CKEY');
    const metaItem = `agents-cli.bundles.${NAME}`;

    // Pre-existing store: AKEY + BKEY carry original values; metadata is a
    // sentinel we can check stayed untouched. CKEY does not exist yet.
    kc.store.set(aItem, 'old-a');
    kc.store.set(bItem, 'old-b');
    kc.store.set(metaItem, JSON.stringify({ vars: { AKEY: 'keychain:AKEY', BKEY: 'keychain:BKEY' }, sentinel: true }));

    // Make the write of BKEY (the 3rd write) throw, after AKEY was overwritten
    // and CKEY was freshly created.
    kc.failOnSet = bItem;

    prevBackend = setSyncBackend(fixedBackend(envelopeFor(makeSnapshot())));

    await expect(pullBundle(NAME, { passphrase: PASSPHRASE, force: true })).rejects.toThrow(
      /rolled back to the pre-restore state/,
    );

    // Pre-existing items restored to their ORIGINAL values.
    expect(kc.store.get(aItem)).toBe('old-a');
    expect(kc.store.get(bItem)).toBe('old-b');
    // The item that did not exist before must not linger.
    expect(kc.store.has(cItem)).toBe(false);
    // Metadata never advanced — writeBundle is only reached on full success.
    expect(JSON.parse(kc.store.get(metaItem)!).sentinel).toBe(true);
  });

  it('commits all secrets and metadata on a fully successful restore', async () => {
    const aItem = secretsKeychainItem(NAME, 'AKEY');
    const bItem = secretsKeychainItem(NAME, 'BKEY');
    const cItem = secretsKeychainItem(NAME, 'CKEY');

    // AKEY pre-exists (to prove overwrite), BKEY/CKEY are new.
    kc.store.set(aItem, 'old-a');

    kc.failOnSet = null;
    prevBackend = setSyncBackend(fixedBackend(envelopeFor(makeSnapshot())));

    const bundle = await pullBundle(NAME, { passphrase: PASSPHRASE, force: true });
    expect(bundle.name).toBe(NAME);

    // Every secret committed to its pulled value.
    expect(kc.store.get(aItem)).toBe('new-a');
    expect(kc.store.get(bItem)).toBe('new-b');
    expect(kc.store.get(cItem)).toBe('new-c');

    // Metadata written and readable, with all three vars.
    const persisted = readBundle(NAME);
    expect(Object.keys(persisted.vars).sort()).toEqual(['AKEY', 'BKEY', 'CKEY']);
  });
});
