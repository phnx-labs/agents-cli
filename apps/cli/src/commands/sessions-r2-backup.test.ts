/**
 * Direct coverage for the R2 backup COMMAND layer (RUSH-2437) — the functions
 * `agents sessions export --to-r2` / `import --from-r2` actually call, not just
 * the low-level R2Client (that is `lib/session/sync/r2.test.ts`). Two tiers:
 *
 *  - Pure, always-run: the fail-loud gates (`r2ExportGateError`,
 *    `r2ImportGateError`), the object-key selection (`r2KeyForRecord`), and the
 *    backup-key resolution (`resolveR2BackupKey`) against a real in-memory
 *    keychain (the same seam config.test.ts uses — no mocking of the resolver).
 *  - MinIO-gated round-trip: `uploadToR2` → `pullFromR2` against a real
 *    S3-compatible endpoint, so the ACTUAL command functions (not a hand-copied
 *    wire format) are exercised end-to-end. SKIPS when AGENTS_TEST_R2_ENDPOINT is
 *    unset — see r2.test.ts for the MinIO one-liner.
 *
 * No HTTP mocking anywhere (repo "real services only" rule). Precedent for
 * importing + unit-testing a command helper directly: sessions-export-resolve.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  r2ExportGateError,
  r2KeyForRecord,
  resolveR2BackupKey,
  uploadToR2,
} from './sessions-export.js';
import { r2ImportGateError, pullFromR2 } from './sessions-import.js';
import { buildRecord, makeHeader, type BundleRecord } from '../lib/session/bundle.js';
import { clearR2ConfigCache, SYNC_BUNDLE } from '../lib/session/sync/config.js';
import { R2Client } from '../lib/session/sync/r2.js';
import { decryptTranscriptBody, generateSyncEncKey } from '../lib/session/sync/transcript-crypto.js';
import { setKeychainBackendForTest, type KeychainBackend } from '../lib/secrets/index.js';
import { writeBundle, type SecretsBundle } from '../lib/secrets/bundles.js';

// ── in-memory keychain seam (mirrors config.test.ts) ──────────────────────────
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
  list(prefix: string) { return [...this.store.keys()].filter(k => k.startsWith(prefix)); }
}

let prevBackend: KeychainBackend | null = null;

function writeR2Bundle(vars: Record<string, string>): void {
  const b: SecretsBundle = { name: SYNC_BUNDLE, policy: 'never', vars };
  writeBundle(b);
}

// ── pure gate + key helpers (always run) ──────────────────────────────────────

describe('R2 backup gates (pure)', () => {
  it('r2ExportGateError: no error when --to-r2 is absent', () => {
    expect(r2ExportGateError({}, false)).toBeNull();
    expect(r2ExportGateError({ toR2: false, host: ['boxB'] }, false)).toBeNull();
  });

  it('r2ExportGateError: --to-r2 + --device is rejected before anything runs', () => {
    const err = r2ExportGateError({ toR2: true, host: ['boxB'] }, true);
    expect(err).toBeTruthy();
    expect(err).toContain('cannot be combined with --device');
  });

  it('r2ExportGateError: --to-r2 with an unconfigured bundle fails loud', () => {
    const err = r2ExportGateError({ toR2: true }, false);
    expect(err).toBeTruthy();
    expect(err).toContain('not configured');
    expect(err).toContain('agents secrets add r2.backups');
  });

  it('r2ExportGateError: --to-r2 configured, no host → proceed (null)', () => {
    expect(r2ExportGateError({ toR2: true }, true)).toBeNull();
  });

  it('r2ImportGateError: only fails loud when --from-r2 and unconfigured', () => {
    expect(r2ImportGateError(false, false)).toBeNull();
    expect(r2ImportGateError(true, true)).toBeNull();
    const err = r2ImportGateError(true, false);
    expect(err).toContain('not configured');
    expect(err).toContain('agents secrets add r2.backups');
  });
});

describe('r2KeyForRecord (object-key selection)', () => {
  const base = { size: 0, hash: 'h', encrypted: false, body: '' };

  it('file-shaped agent keys by session, ignoring relKey', () => {
    const rec: BundleRecord = { ...base, agent: 'claude', machine: 'm1', sessionId: 'sid', relKey: 'projects/p/sid.jsonl' };
    expect(r2KeyForRecord(rec)).toBe('sessions/m1/claude/sid.jsonl');
  });

  it('dir-shaped agent (kimi) keys by relKey under the session dir', () => {
    const rec: BundleRecord = { ...base, agent: 'kimi', machine: 'm1', sessionId: 'session_x', relKey: 'session_x/state.json' };
    expect(r2KeyForRecord(rec)).toBe('sessions/m1/kimi/session_x/session_x/state.json');
  });
});

describe('resolveR2BackupKey (real keychain seam)', () => {
  beforeEach(() => {
    prevBackend = setKeychainBackendForTest(new MemBackend());
    process.env.AGENTS_SECRETS_NO_AGENT = '1';
    clearR2ConfigCache();
  });
  afterEach(() => {
    setKeychainBackendForTest(prevBackend);
    delete process.env.AGENTS_SECRETS_NO_AGENT;
    clearR2ConfigCache();
  });

  it('returns the shared 32-byte key when R2_SYNC_ENC_KEY is present', () => {
    const enc = generateSyncEncKey();
    writeR2Bundle({
      R2_ACCOUNT_ID: 'acct', R2_BUCKET_NAME: 'b', R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk',
      R2_SYNC_ENC_KEY: enc,
    });
    const key = resolveR2BackupKey();
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
    expect(key!.toString('base64')).toBe(enc);
  });

  it('returns null (unencrypted, warned) when the bundle carries no enc key', () => {
    writeR2Bundle({ R2_ACCOUNT_ID: 'acct', R2_BUCKET_NAME: 'b', R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk' });
    expect(resolveR2BackupKey()).toBeNull();
  });
});

// ── MinIO-gated round-trip through the real command functions ──────────────────

const ENDPOINT = process.env.AGENTS_TEST_R2_ENDPOINT ?? '';
const BUCKET = process.env.AGENTS_TEST_R2_BUCKET ?? '';
const ACCESS = process.env.AGENTS_TEST_R2_ACCESS_KEY_ID ?? '';
const SECRET = process.env.AGENTS_TEST_R2_SECRET_ACCESS_KEY ?? '';
const ACCOUNT = process.env.AGENTS_TEST_R2_ACCOUNT_ID ?? 'test-account';
const CONFIGURED = Boolean((ENDPOINT || ACCOUNT !== 'test-account') && BUCKET && ACCESS && SECRET);
const suite = CONFIGURED ? describe : describe.skip;

// Unique machine per run so this test's objects are isolated from r2.test.ts's,
// which also targets the same bucket in parallel.
const RUN = `r2cmd-${process.pid}-${Math.floor(Number(process.hrtime.bigint() % 1_000_000n))}`;

suite('uploadToR2 → pullFromR2 round-trip (AGENTS_TEST_R2_ENDPOINT)', () => {
  const rawClient = new R2Client({
    accountId: ACCOUNT, bucket: BUCKET, accessKeyId: ACCESS, secretAccessKey: SECRET,
    endpoint: ENDPOINT || `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  });

  beforeEach(() => {
    prevBackend = setKeychainBackendForTest(new MemBackend());
    process.env.AGENTS_SECRETS_NO_AGENT = '1';
    clearR2ConfigCache();
    // A real r2.backups bundle pointing at the test endpoint, so the command
    // functions' own loadR2Config() resolves it — no injection, real path.
    writeR2Bundle({
      R2_ACCOUNT_ID: ACCOUNT, R2_BUCKET_NAME: BUCKET, R2_ACCESS_KEY_ID: ACCESS,
      R2_SECRET_ACCESS_KEY: SECRET, R2_ENDPOINT: ENDPOINT || '',
      R2_SYNC_ENC_KEY: generateSyncEncKey(),
    });
  });
  afterEach(() => {
    setKeychainBackendForTest(prevBackend);
    delete process.env.AGENTS_SECRETS_NO_AGENT;
    clearR2ConfigCache();
  });

  afterAll(async () => {
    for (const key of await rawClient.list(`sessions/${RUN}/`)) {
      try { await rawClient.delete(key); } catch { /* already gone */ }
    }
  });

  it('backs up an encrypted + a plaintext session, skips a non-bundle object, restores both', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r2cmd-'));
    const encAbs = path.join(tmp, 'enc.jsonl');
    const plainAbs = path.join(tmp, 'plain.jsonl');
    const encPlain = '{"role":"user","content":"secret token sk-XYZ"}\n';
    const plainPlain = '{"role":"user","content":"no secret here"}\n';
    fs.writeFileSync(encAbs, encPlain, 'utf-8');
    fs.writeFileSync(plainAbs, plainPlain, 'utf-8');

    // Encrypted record via the command's OWN key resolution.
    const key = resolveR2BackupKey();
    expect(key).not.toBeNull();
    const encRec = buildRecord(
      { agent: 'claude', machine: RUN, sessionId: 'enc-1', relKey: 'projects/p/enc-1.jsonl', absPath: encAbs },
      { redact: true, encryptKey: key },
    );
    const plainRec = buildRecord(
      { agent: 'codex', machine: RUN, sessionId: 'plain-1', relKey: 'plain-1.jsonl', absPath: plainAbs },
      { redact: true, encryptKey: null },
    );
    expect(encRec.encrypted).toBe(true);
    expect(plainRec.encrypted).toBe(false);

    // Upload through the REAL command function.
    const header = makeHeader({
      origin: RUN, exportedAt: new Date().toISOString(),
      encrypted: true, redacted: true, records: [encRec, plainRec],
    });
    await uploadToR2(header, [encRec, plainRec]);

    // Objects landed at the shared key layout.
    const listed = await rawClient.list(`sessions/${RUN}/`);
    expect(listed).toContain('sessions/' + RUN + '/claude/enc-1.jsonl');
    expect(listed).toContain('sessions/' + RUN + '/codex/plain-1.jsonl');

    // A non-bundle object under the same prefix must be skipped, not fatal.
    const junkKey = `sessions/${RUN}/claude/junk-not-a-bundle.jsonl`;
    await rawClient.put(junkKey, 'this is not json at all', 'text/plain');

    // Restore through the REAL command function.
    const restored = await pullFromR2();
    const mine = restored.records.filter(r => r.machine === RUN);
    const enc = mine.find(r => r.sessionId === 'enc-1');
    const plain = mine.find(r => r.sessionId === 'plain-1');
    expect(enc).toBeTruthy();
    expect(plain).toBeTruthy();
    // Header reflects that at least one record is encrypted.
    expect(restored.header.encrypted).toBe(true);
    // The junk object was skipped — no restored record carries its body.
    expect(mine.some(r => r.body.includes('not json at all'))).toBe(false);
    // The encrypted body decrypts back to the original with the shared key.
    expect(enc!.encrypted).toBe(true);
    expect(enc!.body).not.toContain('sk-XYZ');
    expect(decryptTranscriptBody(enc!.body, key)).toBe(encPlain);
    // The plaintext body round-trips verbatim.
    expect(plain!.body).toBe(plainPlain);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
