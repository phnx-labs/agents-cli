/**
 * Tests for the passphrase policy of the shared encrypted-file store.
 *
 * The crypto round-trip and basic file-store ops are covered by
 * __tests__/linux.test.ts (which exercises the same module via the Linux
 * backend re-exports). This file pins the policy: the file store silently
 * auto-provisions a machine-local key on EVERY platform (no passphrase to set,
 * type, or remember, no prompt, no Touch ID), and an explicit
 * AGENTS_SECRETS_PASSPHRASE takes precedence and provisions no on-disk key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import lockfile from 'proper-lockfile';
import { sleepSync } from '../fs-atomic.js';
import {
  fileStore, getPassphrase, _resetFileStoreForTest,
  rotatePassphrase, machinePassphraseSourcePath, encryptForFallback, decryptForFallback,
  _setFileStoreLockTimeoutForTest, _setFileStoreLockStaleMsForTest, _fileStoreLockPathForTest,
  type EncFile,
} from './filestore.js';

describe('filestore passphrase policy (silent auto-provision)', () => {
  let tmpRoot: string;
  let storeDir: string;
  let keyDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-filestore-'));
    storeDir = path.join(tmpRoot, 'store');
    keyDir = path.join(tmpRoot, 'key');
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    _resetFileStoreForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('with no passphrase, getPassphrase silently auto-provisions instead of throwing', () => {
    // The whole point of this change: the file store must work with no
    // AGENTS_SECRETS_PASSPHRASE and no prompt, on every platform.
    expect(() => getPassphrase()).not.toThrow();
    expect(fs.existsSync(path.join(keyDir, 'passphrase'))).toBe(true);
  });

  it('an explicit AGENTS_SECRETS_PASSPHRASE takes precedence and provisions no machine key', () => {
    process.env.AGENTS_SECRETS_PASSPHRASE = 'per-run-key';
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    fileStore.set('agents-cli.secrets.b.K', 'sealed');
    expect(fileStore.get('agents-cli.secrets.b.K')).toBe('sealed');
    // Encrypted on disk; the machine key was never provisioned.
    expect(fs.existsSync(path.join(keyDir, 'passphrase'))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, '.passphrase'))).toBe(false);
    const enc = fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.b.K.enc'), 'utf8');
    expect(enc).not.toContain('sealed');
  });

  it('with the wrong passphrase, get fails the auth tag with a clear message', () => {
    process.env.AGENTS_SECRETS_PASSPHRASE = 'right';
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    fileStore.set('agents-cli.secrets.b.K', 'sealed');
    process.env.AGENTS_SECRETS_PASSPHRASE = 'wrong';
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    expect(() => fileStore.get('agents-cli.secrets.b.K'))
      .toThrow(/decrypt|passphrase/i);
  });

  it('batch reads omit missing items but fail on ciphertext that cannot decrypt', () => {
    process.env.AGENTS_SECRETS_PASSPHRASE = 'right';
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    fileStore.set('agents-cli.secrets.b.K', 'sealed');
    expect(fileStore.getBatch(['missing'])).toEqual(new Map());

    process.env.AGENTS_SECRETS_PASSPHRASE = 'wrong';
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    expect(() => fileStore.getBatch(['agents-cli.secrets.b.K']))
      .toThrow("Failed to decrypt 'agents-cli.secrets.b.K'");
  });

  it('auto-provisions the passphrase outside the encrypted store dir (#479)', () => {
    fileStore.set('agents-cli.secrets.b.K', 'sealed');
    const storeEntries = fs.readdirSync(storeDir);
    expect(storeEntries).toContain('agents-cli.secrets.b.K.enc');
    expect(storeEntries).not.toContain('.passphrase');
    expect(storeEntries).not.toContain('passphrase');
    expect(fs.existsSync(path.join(keyDir, 'passphrase'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(keyDir, 'passphrase')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(keyDir).mode & 0o777).toBe(0o700);
    }
  });
});
// RUSH-1975: rotate the file store's machine-local master passphrase. The
// catastrophic failure this guards is a half-re-keyed store (every secret lost),
// so these pin the atomic contract: verify before swap, a crash leaves the old
// store readable, a bad round-trip aborts, and dry-run writes nothing.
describe('rotatePassphrase (RUSH-1975)', () => {
  let tmpRoot: string;
  let storeDir: string;
  let keyDir: string;
  let keyFile: string;
  const OLD_KEY = 'old-machine-key-value';
  let prevTty: boolean | undefined;

  /** Seed a keychain-named item into the file store under the current key. */
  function seed(bundle: string, key: string, value: string): string {
    const item = `agents-cli.secrets.${bundle}.${key}`;
    fileStore.set(item, value);
    return `${item}.enc`;
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-rotate-'));
    storeDir = path.join(tmpRoot, 'store');
    keyDir = path.join(tmpRoot, 'key');
    keyFile = path.join(keyDir, 'passphrase');
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    prevTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    // Provision a known machine-local key so the store is encrypted under a value
    // the test controls (rather than an auto-generated one).
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile, OLD_KEY, { mode: 0o600 });
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevTty, configurable: true });
    _resetFileStoreForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('happy path: re-encrypts every item under a new key and rewrites the 0600 key file', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    seed('daily', 'C', 'value-c');

    const rep = rotatePassphrase({ newPassphrase: 'brand-new-key' });
    expect(rep.committed).toBe(true);
    expect(rep.dryRun).toBe(false);
    expect(rep.bundleCount).toBe(3);
    expect(rep.roundTripOk).toBe(true);
    expect(rep.skipped).toEqual([]);

    // Key file rewritten in place with the new value, still 0600.
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('brand-new-key');
    if (process.platform !== 'win32') {
      expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    }

    // Every item now decrypts under the NEW key and NOT the old one.
    for (const [item, want] of [
      ['agents-cli.secrets.prod.A', 'value-a'],
      ['agents-cli.secrets.prod.B', 'value-b'],
      ['agents-cli.secrets.daily.C', 'value-c'],
    ] as const) {
      const enc = JSON.parse(fs.readFileSync(path.join(storeDir, `${item}.enc`), 'utf8')) as EncFile;
      expect(decryptForFallback(enc, 'brand-new-key')).toBe(want);
      expect(() => decryptForFallback(enc, OLD_KEY)).toThrow();
    }
    // The live resolver reads the rotated values transparently.
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');

    // No staging/backup dirs or key temp files left behind.
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
    expect(fs.readdirSync(keyDir)).toEqual(['passphrase']);
  });

  it('dry-run reports the count and round-trip but writes nothing', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    const beforeStore = fs.readdirSync(storeDir).sort().map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')]);
    const beforeKey = fs.readFileSync(keyFile, 'utf8');

    const rep = rotatePassphrase({ dryRun: true, newPassphrase: 'unused' });
    expect(rep.dryRun).toBe(true);
    expect(rep.committed).toBe(false);
    expect(rep.bundleCount).toBe(2);
    expect(rep.roundTripOk).toBe(true);

    // Byte-for-byte unchanged: no ciphertext rewritten, key file untouched.
    expect(fs.readdirSync(storeDir).sort().map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')])).toEqual(beforeStore);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(beforeKey);
  });

  it('a crash mid-run (after staging, before the swap) leaves the old store readable under the old key', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    const beforeStore = fs.readdirSync(storeDir).sort().map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')]);

    expect(() => rotatePassphrase({
      newPassphrase: 'never-lands',
      onStagedBeforeCommit: () => { throw new Error('simulated crash'); },
    })).toThrow(/simulated crash/);

    // The live store and key file are exactly as they were — old key still works.
    expect(fs.readdirSync(storeDir).sort().map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')])).toEqual(beforeStore);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(OLD_KEY);
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
    const enc = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(() => decryptForFallback(enc, 'never-lands')).toThrow();

    // A subsequent rotation recovers past the abandoned staging dir and succeeds.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir, passphrase: OLD_KEY });
    const rep = rotatePassphrase({ newPassphrase: 'clean-key' });
    expect(rep.committed).toBe(true);
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
    expect(fileStore.get('agents-cli.secrets.prod.B')).toBe('value-b');
  });

  it('Window A: crash after the store swap, before the key swap — next run recovers a readable store instead of sweeping the artifacts', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');

    // Crash in Window A: the NEW-key store is live, the OLD key file is still in
    // place, and both recovery artifacts (`.rotate-new` = new key, `.rotate-old-*`
    // = old store) are on disk. The presence-based recovery would see store+key
    // both present and sweep both artifacts, orphaning every secret permanently.
    expect(() => rotatePassphrase({
      newPassphrase: 'winA-key',
      onStoreSwappedBeforeKeySwap: () => { throw new Error('crash in Window A'); },
    })).toThrow(/Window A/);

    // Prove the dangerous on-disk state the crash left: store is NEW-key, key file
    // is still OLD (a mismatch), and neither artifact has been swept.
    const encCrash = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encCrash, 'winA-key')).toBe('value-a');
    expect(() => decryptForFallback(encCrash, OLD_KEY)).toThrow();
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(OLD_KEY);
    expect(fs.existsSync(`${keyFile}.rotate-new`)).toBe(true);
    expect(fs.readdirSync(tmpRoot).some((e) => e.startsWith('store.rotate-old-'))).toBe(true);

    // Next run recovers. Under the old presence-based code this second rotation
    // would abort ("No item decrypted under the current machine-local key") with
    // every secret unreadable; content-aware recovery installs the new key first.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    const rep = rotatePassphrase({ newPassphrase: 'winA-final' });
    expect(rep.committed).toBe(true);

    // Store and key are paired again (no mismatch), every value survived, and the
    // artifacts are gone only now that a forward decrypt was proven.
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
    expect(fileStore.get('agents-cli.secrets.prod.B')).toBe('value-b');
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('winA-final');
    const encAfter = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encAfter, 'winA-final')).toBe('value-a');
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
    expect(fs.readdirSync(keyDir).sort()).toEqual(['passphrase']);
  });

  it('--dry-run heals an interrupted rotation but never re-keys — and says so', () => {
    seed('prod', 'A', 'value-a');

    // Crash in Window A: the store is live under the NEW key while the key file is
    // still OLD, with both recovery artifacts on disk.
    expect(() => rotatePassphrase({
      newPassphrase: 'winA-key',
      onStoreSwappedBeforeKeySwap: () => { throw new Error('crash in Window A'); },
    })).toThrow(/Window A/);
    expect(fs.readdirSync(tmpRoot).some((e) => e.includes('.rotate-'))).toBe(true);

    // Recovery is deliberately NOT gated on --commit: healing is how a crashed
    // store becomes readable again without re-keying it. So a dry run DOES write —
    // it sweeps the artifacts and leaves one coherent store — and reports that.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    const dry = rotatePassphrase({ dryRun: true, newPassphrase: 'must-not-be-applied' });

    expect(dry.dryRun).toBe(true);
    expect(dry.committed).toBe(false);
    expect(dry.recoveredInterruptedRotation).toBe(true);
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);

    // The crucial half: healing happened, re-keying did NOT. The probe passphrase
    // must never reach the store or the key file.
    const key = fs.readFileSync(keyFile, 'utf8');
    expect(key).not.toBe('must-not-be-applied');
    const encA = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(() => decryptForFallback(encA, 'must-not-be-applied')).toThrow();
    expect(decryptForFallback(encA, key)).toBe('value-a');
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
  });

  it('Window B: crash after the old key is moved aside, before the new key lands — next run recovers forward, not onto the wrong key', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');

    // Crash in Window B: the NEW-key store is live, the key file is ABSENT (moved to
    // `.rotate-oldkey`), and `.rotate-new` holds the new key. The presence-based code
    // restores the OLD key from `.rotate-oldkey` onto the NEW store (wrong key), then
    // sweeps `.rotate-new` + the old-store backup, orphaning every secret.
    expect(() => rotatePassphrase({
      newPassphrase: 'winB-key',
      onKeyBackedUpBeforeNewKey: () => { throw new Error('crash in Window B'); },
    })).toThrow(/Window B/);

    // Prove the on-disk state the crash left.
    const encCrash = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encCrash, 'winB-key')).toBe('value-a');
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(fs.readFileSync(`${keyFile}.rotate-oldkey`, 'utf8')).toBe(OLD_KEY);
    expect(fs.readFileSync(`${keyFile}.rotate-new`, 'utf8')).toBe('winB-key');
    expect(fs.readdirSync(tmpRoot).some((e) => e.startsWith('store.rotate-old-'))).toBe(true);

    // Next run must finish the rotation forward — install the NEW key from
    // `.rotate-new` — not restore the OLD key onto the NEW store.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    const rep = rotatePassphrase({ newPassphrase: 'winB-final' });
    expect(rep.committed).toBe(true);

    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
    expect(fileStore.get('agents-cli.secrets.prod.B')).toBe('value-b');
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('winB-final');
    const encAfter = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encAfter, 'winB-final')).toBe('value-a');
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
    expect(fs.readdirSync(keyDir).sort()).toEqual(['passphrase']);
  });

  it('aborts (writing nothing) when a re-encrypted item fails to round-trip under the new key', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    const beforeStore = fs.readdirSync(storeDir).sort().map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')]);

    expect(() => rotatePassphrase({ newPassphrase: 'nk', tamperStaged: true }))
      .toThrow(/verify|round-trip/i);

    // Verify-before-swap: nothing was written, key file untouched.
    expect(fs.readdirSync(storeDir).sort().map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')])).toEqual(beforeStore);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(OLD_KEY);
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
  });

  it('re-keys valid items and copies through an orphan encrypted under a different key', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    // An orphan: valid EncFile JSON, but sealed under a key the store does not use.
    const orphanEnc = encryptForFallback('orphan-secret', 'some-other-key');
    const orphanName = 'agents-cli.secrets.orphan.X.enc';
    fs.writeFileSync(path.join(storeDir, orphanName), JSON.stringify(orphanEnc), { mode: 0o600});
    const orphanBefore = fs.readFileSync(path.join(storeDir, orphanName), 'utf8');

    const rep = rotatePassphrase({ newPassphrase: 'nk' });
    expect(rep.committed).toBe(true);
    expect(rep.bundleCount).toBe(2);
    expect(rep.skipped.length).toBe(1);
    expect(rep.skipped[0]).toContain('orphan.X');

    // The orphan is carried through byte-identical (never re-keyed, never dropped).
    expect(fs.readFileSync(path.join(storeDir, orphanName), 'utf8')).toBe(orphanBefore);
    // The real items are re-keyed.
    const encA = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encA, 'nk')).toBe('value-a');
  });

  it('MIXED store (Window A crash + an interstitial write) is REFUSED, not swept — no silent loss', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');

    // Crash in Window A: the NEW-key store is live, the OLD key file is still in
    // place, `.rotate-new` (= new key) and the old-store backup are on disk.
    expect(() => rotatePassphrase({
      newPassphrase: 'winA-newkey',
      onStoreSwappedBeforeKeySwap: () => { throw new Error('crash in Window A'); },
    })).toThrow(/Window A/);

    // An ordinary `secrets set` now seals ONE item under the stale on-disk (OLD)
    // key, INTO the already-NEW-key store dir. The store is now MIXED: A and B under
    // the new key, C under the old key. This is exactly the reviewer's repro.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    fileStore.set('agents-cli.secrets.prod.C', 'value-c');

    // The next rotate must NOT read "one item opens under the live key" as
    // "consistent, sweep". It must detect the mixed store and refuse, preserving
    // BOTH the only copy of the new key (`.rotate-new`) and the old-ciphertext
    // backup — nothing reports success, no secret is destroyed.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    expect(() => rotatePassphrase({ newPassphrase: 'winA-again' })).toThrow(/MIXED/i);

    // Every recovery artifact survived.
    expect(fs.readFileSync(`${keyFile}.rotate-new`, 'utf8')).toBe('winA-newkey');
    expect(fs.readdirSync(tmpRoot).some((e) => e.startsWith('store.rotate-old-'))).toBe(true);

    // And every pre-rotation secret is still recoverable off disk: A and B under the
    // preserved new key, C under the live old key. Under the old "any item opens"
    // sweep, A and B were unreadable under every key left on disk.
    const encA = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    const encB = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.B.enc'), 'utf8')) as EncFile;
    const encC = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.C.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encA, 'winA-newkey')).toBe('value-a');
    expect(decryptForFallback(encB, 'winA-newkey')).toBe('value-b');
    expect(decryptForFallback(encC, OLD_KEY)).toBe('value-c');
  });

  it('MIXED store (Window B crash + an interstitial write under a fresh key) is REFUSED, not swept', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');

    // Crash in Window B: the NEW-key store is live, the key file is ABSENT (moved to
    // `.rotate-oldkey`), `.rotate-new` holds the new key.
    expect(() => rotatePassphrase({
      newPassphrase: 'winB-newkey',
      onKeyBackedUpBeforeNewKey: () => { throw new Error('crash in Window B'); },
    })).toThrow(/Window B/);
    expect(fs.existsSync(keyFile)).toBe(false);

    // With the key file gone, an ordinary `secrets set` auto-provisions a THIRD key
    // and seals C under it — while A and B are still under the new key. Mixed store.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    fileStore.set('agents-cli.secrets.prod.C', 'value-c');
    const thirdKey = fs.readFileSync(keyFile, 'utf8'); // the freshly provisioned key

    // Recovery must refuse the mixed store rather than sweep the new key.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    expect(() => rotatePassphrase({ newPassphrase: 'winB-again' })).toThrow(/MIXED/i);

    expect(fs.readFileSync(`${keyFile}.rotate-new`, 'utf8')).toBe('winB-newkey');
    expect(fs.readFileSync(`${keyFile}.rotate-oldkey`, 'utf8')).toBe(OLD_KEY);
    expect(fs.readdirSync(tmpRoot).some((e) => e.startsWith('store.rotate-old-'))).toBe(true);

    const encA = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    const encC = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.C.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encA, 'winB-newkey')).toBe('value-a');
    expect(decryptForFallback(encC, thirdKey)).toBe('value-c');
  });

  it('a store where no item opens under any candidate key is left intact (no sweep)', () => {
    // Seed a store that decrypts under NO key on disk: one .enc sealed under a key
    // that is neither the live key nor any rotation artifact.
    const strayEnc = encryptForFallback('stray-secret', 'a-key-nobody-has');
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(storeDir, 'agents-cli.secrets.gone.X.enc'), JSON.stringify(strayEnc), { mode: 0o600 });
    // A dangling `.rotate-new` artifact (under yet another key) makes recovery run,
    // but there is no backup dir, so neither forward nor rollback is provable.
    fs.writeFileSync(`${keyFile}.rotate-new`, 'another-unrelated-key', { mode: 0o600 });
    const encBefore = fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.gone.X.enc'), 'utf8');

    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    // The rotation itself has nothing it can decrypt, so it aborts — but recovery
    // must NOT have swept the artifacts on the way in.
    expect(() => rotatePassphrase({ newPassphrase: 'nk' })).toThrow(/No item decrypted/i);

    expect(fs.existsSync(`${keyFile}.rotate-new`)).toBe(true);
    expect(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.gone.X.enc'), 'utf8')).toBe(encBefore);
  });

  it('the store lock serializes a concurrent write and a second rotation against a rotation in progress', () => {
    seed('prod', 'A', 'value-a');
    _setFileStoreLockTimeoutForTest(150); // fail fast instead of the 30s budget

    let setError: unknown;
    let rotError: unknown;
    // The rotation holds the store lock for its whole run. Fire a competing write
    // and a competing rotation from inside the mid-swap window: both must find the
    // lock held and fail to acquire (rather than interleave into a mixed store).
    const rep = rotatePassphrase({
      newPassphrase: 'nk',
      onStoreSwappedBeforeKeySwap: () => {
        try { fileStore.set('agents-cli.secrets.prod.C', 'racer'); }
        catch (e) { setError = e; }
        try { rotatePassphrase({ newPassphrase: 'nk2' }); }
        catch (e) { rotError = e; }
      },
    });

    expect(rep.committed).toBe(true); // the holder finished; the challengers were blocked
    expect((setError as Error)?.message).toMatch(/Could not acquire lock/);
    expect((rotError as Error)?.message).toMatch(/Could not acquire lock/);
    // The blocked write never landed — no stray item forged a mixed store.
    expect(fs.existsSync(path.join(storeDir, 'agents-cli.secrets.prod.C.enc'))).toBe(false);

    // With the lock free, a write and a rotation both succeed normally.
    fileStore.set('agents-cli.secrets.prod.C', 'value-c');
    expect(fileStore.get('agents-cli.secrets.prod.C')).toBe('value-c');
    const rep2 = rotatePassphrase({ newPassphrase: 'nk3' });
    expect(rep2.committed).toBe(true);
  });

  it('throws when there is no machine-local passphrase to rotate', () => {
    seed('prod', 'A', 'value-a');
    fs.rmSync(keyFile);
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    expect(machinePassphraseSourcePath()).toBeNull();
    expect(() => rotatePassphrase()).toThrow(/machine-local passphrase/i);
  });

  it('Window M (non-co-located): crash after the store dir is moved aside, before the staged store lands — next run restores the backup and the OLD key opens the whole store', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    const beforeEnc = fs.readdirSync(storeDir).filter((f) => f.endsWith('.enc')).sort();

    // Crash at `onStoreMovedAsideBeforeSwap` on the canonical layout: the live store
    // dir has just been renamed to `store.rotate-old-*` (so `storeDir` is ABSENT) and
    // the staged NEW-key store has NOT yet landed. Unlike the co-located single-rename
    // window, the key file lives in its OWN dir, so it is NOT carried into the backup:
    // it stays untouched at OLD_KEY. This is the exact window `filestore.test.ts:506`
    // (the co-located test) exercises, now for the layout every non-legacy machine
    // (incl. yosemite-s0/s1) actually runs.
    expect(() => rotatePassphrase({
      newPassphrase: 'winM-crash',
      onStoreMovedAsideBeforeSwap: () => { throw new Error('crash before staged store lands'); },
    })).toThrow(/before staged store lands/);

    // Crashed on-disk state: store dir ABSENT, `store.rotate-old-*` backup PRESENT,
    // key file UNTOUCHED (still OLD_KEY, in its own dir — never swept into the backup).
    expect(fs.existsSync(storeDir)).toBe(false);
    const bakName = fs.readdirSync(tmpRoot).find((e) => e.startsWith('store.rotate-old-'));
    expect(bakName).toBeTruthy();
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(OLD_KEY);
    // The old ciphertext rode into the backup intact, still under the OLD key.
    const encABak = JSON.parse(fs.readFileSync(path.join(tmpRoot, bakName!, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encABak, OLD_KEY)).toBe('value-a');

    // A dry-run rotation triggers recovery WITHOUT re-keying: it must restore the
    // backup over the absent store dir, and the OLD key must then open the WHOLE
    // restored store. Every `.rotate-*` artifact is swept only once that is proven.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    const dry = rotatePassphrase({ dryRun: true, newPassphrase: 'winM-probe' });
    expect(dry.committed).toBe(false);
    expect(fs.existsSync(storeDir)).toBe(true);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(OLD_KEY);
    for (const [item, want] of [
      ['agents-cli.secrets.prod.A', 'value-a'],
      ['agents-cli.secrets.prod.B', 'value-b'],
    ] as const) {
      const enc = JSON.parse(fs.readFileSync(path.join(storeDir, `${item}.enc`), 'utf8')) as EncFile;
      expect(decryptForFallback(enc, OLD_KEY)).toBe(want);
    }
    // No `.rotate-*` artifact left behind once recovery completes.
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);

    // Every seeded value reads back through the live resolver under the restored key.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir, passphrase: OLD_KEY });
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
    expect(fileStore.get('agents-cli.secrets.prod.B')).toBe('value-b');

    // A real rotation now completes cleanly to a fresh key, values intact.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    const rep = rotatePassphrase({ newPassphrase: 'winM-final' });
    expect(rep.committed).toBe(true);
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
    expect(fileStore.get('agents-cli.secrets.prod.B')).toBe('value-b');
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('winM-final');
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
    // Same item set before the crash and after recovery + retry — nothing dropped.
    expect(fs.readdirSync(storeDir).filter((f) => f.endsWith('.enc')).sort()).toEqual(beforeEnc);
  });

  it('MIXED/split store (Window M crash + an interstitial write) is REFUSED, not swept — no silent loss', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');

    // Crash in the move-aside window: the store dir is renamed to `store.rotate-old-*`
    // (so `storeDir` is ABSENT) and the staged store has not landed. The OLD key file
    // and `.rotate-new` (the incoming key) are on disk; A and B live ONLY in the backup.
    expect(() => rotatePassphrase({
      newPassphrase: 'winM-newkey',
      onStoreMovedAsideBeforeSwap: () => { throw new Error('crash before staged store lands'); },
    })).toThrow(/before staged store lands/);
    expect(fs.existsSync(storeDir)).toBe(false);

    // With the store dir gone but the OLD key file intact, an ordinary `secrets set`
    // recreates the dir and seals C under the OLD key. The live dir now holds ONLY C —
    // A and B survive solely in the `store.rotate-old-*` backup. A presence/"any item
    // opens" recovery would see "the live key opens the whole (C-only) store", call it
    // consistent, and sweep the backup — permanently orphaning A and B (silent loss).
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    fileStore.set('agents-cli.secrets.prod.C', 'value-c');

    // Recovery must detect that the backup holds items absent from the live dir and
    // REFUSE, preserving every artifact — never report success over a store it would
    // be corrupting.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    expect(() => rotatePassphrase({ newPassphrase: 'winM-again' })).toThrow(/MIXED/i);

    // Every recovery artifact survived: the new-key temp and the old-store backup.
    expect(fs.readFileSync(`${keyFile}.rotate-new`, 'utf8')).toBe('winM-newkey');
    const bakName = fs.readdirSync(tmpRoot).find((e) => e.startsWith('store.rotate-old-'));
    expect(bakName).toBeTruthy();

    // And every pre-rotation secret is still recoverable off disk: A and B under the
    // OLD key in the preserved backup, C under the OLD key in the live dir. Under the
    // old "any item opens" sweep, A and B were unreadable under every key left on disk.
    const encABak = JSON.parse(fs.readFileSync(path.join(tmpRoot, bakName!, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    const encBBak = JSON.parse(fs.readFileSync(path.join(tmpRoot, bakName!, 'agents-cli.secrets.prod.B.enc'), 'utf8')) as EncFile;
    const encC = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.C.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encABak, OLD_KEY)).toBe('value-a');
    expect(decryptForFallback(encBBak, OLD_KEY)).toBe('value-b');
    expect(decryptForFallback(encC, OLD_KEY)).toBe('value-c');
  });

  it('rotation heartbeats the store lock so a long synchronous hold is not stolen as stale', () => {
    seed('prod', 'A', 'value-a');
    // Shrink the 5s stale window so the assertion runs in ms. A real rotation is
    // scrypt-bound and outlives the production window; here we simulate a hold that
    // outlives the (tiny) window while the rotation keeps the lock fresh.
    _setFileStoreLockStaleMsForTest(60);

    let stole = false;
    let blocked = false;
    const rep = rotatePassphrase({
      newPassphrase: 'hb-key',
      // Fires mid-swap with the store lock held. Hold ~150ms — well past the 60ms
      // stale window — calling the rotation's own heartbeat every 30ms. A peer's
      // lock attempt must still find the lock HELD (fresh), not stale-and-stealable.
      // Without the heartbeat the lock would age out and this steal would succeed.
      onStoreSwappedBeforeKeySwap: (heartbeat) => {
        for (let i = 0; i < 5; i++) { heartbeat(); sleepSync(30); }
        try {
          const release = lockfile.lockSync(_fileStoreLockPathForTest(), { stale: 60 });
          release();
          stole = true;
        } catch {
          blocked = true;
        }
      },
    });

    expect(rep.committed).toBe(true);
    expect(stole).toBe(false);
    expect(blocked).toBe(true);
    // The rotation still committed cleanly with the value intact.
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('hb-key');
  });
});

/**
 * Co-located legacy key layout (pre-#479): the machine-local key lives INSIDE the
 * store dir as `.passphrase`, so `keyColocated` is true and the swap is a single
 * directory rename that carries both ciphertext and key. Every fixture in the
 * block above puts the key in a separate `keyDir`, so that path had zero coverage.
 */
describe('rotatePassphrase — co-located legacy key layout (RUSH-1975)', () => {
  let tmpRoot: string;
  let storeDir: string;
  let emptyKeyDir: string;
  let keyFile: string; // storeDir/.passphrase — the co-located legacy key
  const OLD_KEY = 'old-colocated-key-value';
  let prevTty: boolean | undefined;

  function seed(bundle: string, key: string, value: string): string {
    const item = `agents-cli.secrets.${bundle}.${key}`;
    fileStore.set(item, value);
    return `${item}.enc`;
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-rotate-colo-'));
    storeDir = path.join(tmpRoot, 'store');
    emptyKeyDir = path.join(tmpRoot, 'key'); // canonical passphrase dir, kept empty
    keyFile = path.join(storeDir, '.passphrase');
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    prevTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    // Provision the key at the legacy co-located path (inside the store dir) and
    // point the canonical passphrase dir at an empty dir, so the source resolves the
    // key to storeDir/.passphrase and `dirname(keyPath) === fileDir()` (colocated).
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(emptyKeyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile, OLD_KEY, { mode: 0o600 });
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: emptyKeyDir });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevTty, configurable: true });
    _resetFileStoreForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('re-keys through a single directory rename and rewrites the co-located key in place', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    // Prove the fixture actually exercises the colocated path (dirname === storeDir).
    expect(machinePassphraseSourcePath()).toBe(keyFile);
    expect(path.dirname(keyFile)).toBe(storeDir);

    const rep = rotatePassphrase({ newPassphrase: 'colo-new' });
    expect(rep.committed).toBe(true);
    expect(rep.bundleCount).toBe(2);
    expect(rep.roundTripOk).toBe(true);

    // The key file INSIDE the swapped store dir now holds the NEW passphrase, 0600.
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('colo-new');
    if (process.platform !== 'win32') {
      expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    }
    // Values still resolve after the rotation, under the new key and not the old.
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
    expect(fileStore.get('agents-cli.secrets.prod.B')).toBe('value-b');
    const encA = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encA, 'colo-new')).toBe('value-a');
    expect(() => decryptForFallback(encA, OLD_KEY)).toThrow();

    // No stray rotate artifacts, and the key stayed co-located (never leaked to keyDir).
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
    expect(fs.readdirSync(emptyKeyDir)).toEqual([]);
  });

  it('crash in the single-rename window (store dir absent) recovers to the old store+key, then a retry rotates cleanly', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    const beforeStore = fs.readdirSync(storeDir).sort()
      .map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')]);

    // Crash after the live store is moved aside but before the staged store lands —
    // the store dir is absent, the old store+key sit in `store.rotate-old-*`, the new
    // store+key sit in the staging dir. This is the ONLY crash window for a colocated
    // key: one rename carries both, so there is no NEW-store/OLD-key mismatch to leave.
    expect(() => rotatePassphrase({
      newPassphrase: 'colo-crash',
      onStoreMovedAsideBeforeSwap: () => { throw new Error('crash in single-rename window'); },
    })).toThrow(/single-rename window/);

    // Prove the crashed on-disk state: store dir gone, backup present, key file gone
    // (it travelled into the backup with the store), no partial NEW/OLD split.
    expect(fs.existsSync(storeDir)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
    const bakName = fs.readdirSync(tmpRoot).find((e) => e.startsWith('store.rotate-old-'));
    expect(bakName).toBeTruthy();
    expect(fs.readFileSync(path.join(tmpRoot, bakName!, '.passphrase'), 'utf8')).toBe(OLD_KEY);

    // Next run recovers: the backup (old store + old key) is restored intact, so the
    // store is readable under the OLD key again — strictly safer than the four-rename
    // non-colocated path, which can strand a NEW-key store beside an OLD key file.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: emptyKeyDir });
    const rep = rotatePassphrase({ newPassphrase: 'colo-final' });
    expect(rep.committed).toBe(true);

    // Old ciphertext survived the round trip byte-for-byte through the backup, and the
    // retry re-keyed cleanly to the final key.
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
    expect(fileStore.get('agents-cli.secrets.prod.B')).toBe('value-b');
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('colo-final');
    const encAfter = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encAfter, 'colo-final')).toBe('value-a');
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
    // The store held the same item set before the crash and after recovery+retry.
    expect(fs.readdirSync(storeDir).filter((f) => f.endsWith('.enc')).sort())
      .toEqual(beforeStore.map(([f]) => f).filter((f) => f.endsWith('.enc')).sort());
  });

  it('copies a non-UTF-8 file through the rotation byte-for-byte (no U+FFFD corruption)', () => {
    seed('prod', 'A', 'value-a');
    // A raw binary blob with byte sequences that are not valid UTF-8 (0xff/0xfe are
    // never legal UTF-8 lead bytes; the lone 0x80 continuation is invalid too). A
    // decode/re-encode round-trip would replace each with U+FFFD and corrupt it.
    const rawName = 'not-utf8.bin';
    const rawBytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0xc3, 0x28, 0x99]);
    fs.writeFileSync(path.join(storeDir, rawName), rawBytes, { mode: 0o600 });

    const rep = rotatePassphrase({ newPassphrase: 'colo-bin' });
    expect(rep.committed).toBe(true);

    // The blob survived the whole-store rewrite byte-for-byte.
    const after = fs.readFileSync(path.join(storeDir, rawName));
    expect(Buffer.compare(after, rawBytes)).toBe(0);
    // And the real item was still re-keyed.
    const encA = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encA, 'colo-bin')).toBe('value-a');
  });
});
