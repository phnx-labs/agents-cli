/**
 * The no-ACL bundle-metadata name index — the thing that stops `listBundles`
 * from doing a broad `agents-cli.` keychain scan on every launch (which matched
 * ACL'd secret VALUE items and popped a generic Touch ID sheet). These tests pin
 * the index's load-bearing invariants; the darwin `listBundles` wiring that reads
 * it is verified end-to-end on a real machine (the scan is macOS-keychain only).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __metaIndexForTest, BUNDLE_META_PREFIX } from './bundles.js';
import { keychainServiceAlias, setKeychainServiceHashingForTest } from './index.js';

describe('bundle-metadata name index', () => {
  let tmpDir: string;
  let prevEnv: string | undefined;
  const key = randomBytes(32);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-index-'));
    prevEnv = process.env.AGENTS_SECRETS_META_INDEX_FILE;
    process.env.AGENTS_SECRETS_META_INDEX_FILE = path.join(tmpDir, 'idx.json');
    // Force hashing on so keychainServiceAlias yields the opaque storage names,
    // exactly as it does on a re-keyed macOS machine (#316).
    setKeychainServiceHashingForTest(key);
  });
  afterEach(() => {
    setKeychainServiceHashingForTest(null);
    if (prevEnv === undefined) delete process.env.AGENTS_SECRETS_META_INDEX_FILE;
    else process.env.AGENTS_SECRETS_META_INDEX_FILE = prevEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('add() is a no-op until the index is built — never a partial index that hides other bundles', () => {
    // The critical safety property: on a machine whose index has not been built
    // yet, adding one bundle must NOT create a one-entry index (which listBundles
    // would then trust and show ONLY that bundle). It must stay absent so the
    // next listBundles rebuilds the COMPLETE index from a full scan.
    expect(__metaIndexForTest.read()).toBeNull();
    __metaIndexForTest.add('prod');
    expect(__metaIndexForTest.read()).toBeNull();
    __metaIndexForTest.remove('prod');
    expect(__metaIndexForTest.read()).toBeNull();
  });

  it('once built, add/remove keep the opaque storage names current and idempotent', () => {
    __metaIndexForTest.write([]); // listBundles built it (empty machine)
    const svc = keychainServiceAlias(BUNDLE_META_PREFIX + 'prod');

    __metaIndexForTest.add('prod');
    expect(__metaIndexForTest.read()).toEqual([svc]);
    __metaIndexForTest.add('prod'); // idempotent — no duplicate, no churn
    expect(__metaIndexForTest.read()).toEqual([svc]);

    __metaIndexForTest.remove('prod');
    expect(__metaIndexForTest.read()).toEqual([]);
    __metaIndexForTest.remove('prod'); // removing an absent entry is a no-op
    expect(__metaIndexForTest.read()).toEqual([]);
  });

  it('stores ONLY opaque hashes — never a cleartext bundle name (#316 privacy preserved)', () => {
    __metaIndexForTest.write([]);
    __metaIndexForTest.add('personal-identity');
    const stored = __metaIndexForTest.read();
    expect(stored).not.toBeNull();
    expect(stored![0]).toMatch(/^agents-cli\.h\.[0-9a-f]{32}\.m$/);
    expect(stored!.join('\n')).not.toContain('personal-identity');
  });

  it('write() round-trips, dedupes, and rejects a corrupt file as absent (self-heals via rebuild)', () => {
    const a = keychainServiceAlias(BUNDLE_META_PREFIX + 'a');
    const b = keychainServiceAlias(BUNDLE_META_PREFIX + 'b');
    __metaIndexForTest.write([b, a, a]); // unsorted + duplicate
    expect(__metaIndexForTest.read()).toEqual([a, b].sort());

    // A truncated/garbage index reads as "absent" so listBundles rebuilds it
    // rather than trusting junk.
    fs.writeFileSync(process.env.AGENTS_SECRETS_META_INDEX_FILE!, '{not json', 'utf8');
    expect(__metaIndexForTest.read()).toBeNull();
  });

  it('an index built under a different hashing key reads as absent (re-key safety)', () => {
    __metaIndexForTest.write([keychainServiceAlias(BUNDLE_META_PREFIX + 'prod')]);
    expect(__metaIndexForTest.read()).toHaveLength(1); // valid under the current key

    // Simulate the #316 re-key: the hashing key rotates. The old index now holds
    // names hashed under the old key — trusting it would make bundles vanish, so
    // it must read as absent and force a rebuild.
    setKeychainServiceHashingForTest(randomBytes(32));
    expect(__metaIndexForTest.read()).toBeNull();
  });
});
