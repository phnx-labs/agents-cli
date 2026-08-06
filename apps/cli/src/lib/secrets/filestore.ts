/**
 * Passphrase-encrypted file store for secrets — platform-neutral.
 *
 * An AES-256-GCM encrypted-file store under `~/.agents/.cache/secrets/`. The
 * encryption key is scrypt-derived from a passphrase read from
 * `AGENTS_SECRETS_PASSPHRASE` (preferred) or a machine-local key the store
 * auto-provisions on first use. One `<item>.enc` JSON file per item, mode 0600.
 *
 * Two callers, one policy: the store silently auto-provisions a stable
 * machine-local key (a 0600 file under `~/.agents/.secrets-key/`) on EVERY
 * platform, so it works out of the box with no passphrase to set or remember and
 * never pops a prompt or Touch ID sheet.
 *  - Linux (src/lib/secrets/linux.ts): the headless fallback when the default
 *    Secret Service collection is locked.
 *  - macOS/Windows file-backed bundles (src/lib/secrets/bundles.ts): an explicit,
 *    opt-in non-biometry backend for headless/remote runs.
 * Set AGENTS_SECRETS_PASSPHRASE to opt into a key held off disk instead (e.g. to
 * share one bundle's ciphertext across boxes under a common key).
 *
 * The item-name scheme is shared with the keychain backend so a file-backed
 * item and its keychain twin carry identical names:
 *   `agents-cli.bundles.<name>` and `agents-cli.secrets.<bundle>.<key>`.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { KeychainBackend } from './index.js';
import { withFileLock, ensureLockTarget } from '../fs-atomic.js';

// ---------- file store location ----------

let fileDirOverride: string | null = null;
let passphraseDirOverride: string | null = null;
let cachedPassphrase: string | null = null;
let warnedAutoPassphrase = false;

export function fileDir(): string {
  return fileDirOverride ?? path.join(os.homedir(), '.agents', '.cache', 'secrets');
}

function ensureFileDir(): void {
  fs.mkdirSync(fileDir(), { recursive: true, mode: 0o700 });
}

// ---------- cross-process store lock (RUSH-1975) ----------

// Every mutation of the store (a `secrets set`/`delete`) and every rotation runs
// under one exclusive lock, so a write can never land in the store dir between a
// rotation's store-swap and key-swap renames (which would forge a MIXED store —
// items sealed under two keys at once — with no crash involved) and two rotations
// can never run concurrently. The macOS-only broker-unlock guard (`agentStatus`)
// does nothing on the Linux headless targets this command exists for, so this is
// the real serialization. The lock target is a SIBLING of the store dir, never a
// file inside it — so it is never copied through a rotation nor swept as a
// `.rotate-*` artifact, and it stays put across a mid-swap store-dir rename.
//
// A rotation's critical section is fully synchronous and scrypt-bound, so on a real
// store it runs well past the lock's stale window. It calls `withFileLock`'s
// `heartbeat()` through the re-encrypt and staging loops to keep the lockfile mtime
// fresh — otherwise a peer would see the live holder as crashed, break the lock, and
// interleave a write into the swap (a live lock-steal, no crash needed).
let lockAcquireTimeoutMsOverride: number | null = null;
let lockStaleMsOverride: number | null = null;

function fileStoreLockPath(): string {
  return `${fileDir()}.lock`;
}

function withStoreLock<T>(fn: (heartbeat: () => void) => T): T {
  const lock = fileStoreLockPath();
  ensureLockTarget(lock);
  const opts: { acquireTimeoutMs?: number; staleMs?: number } = {};
  if (lockAcquireTimeoutMsOverride != null) opts.acquireTimeoutMs = lockAcquireTimeoutMsOverride;
  if (lockStaleMsOverride != null) opts.staleMs = lockStaleMsOverride;
  return withFileLock(lock, fn, opts);
}

// ---------- passphrase ----------


/**
 * Directory for the auto-provisioned machine-local passphrase. Kept outside
 * `fileDir()` so a scan of the encrypted store never co-locates key + ciphertext.
 */
function passphraseDir(): string {
  return passphraseDirOverride ?? path.join(os.homedir(), '.agents', '.secrets-key');
}

function ensurePassphraseDir(): void {
  fs.mkdirSync(passphraseDir(), { recursive: true, mode: 0o700 });
}

/** Path of the auto-provisioned machine-local passphrase (not an `.enc` item). */
function passphraseFilePath(): string {
  return path.join(passphraseDir(), 'passphrase');
}

/** Legacy co-located path — read-only for machines provisioned before #479. */
function legacyPassphraseFilePath(): string {
  return path.join(fileDir(), '.passphrase');
}

/** True if a machine-local passphrase has already been provisioned. */
export function machinePassphraseExists(): boolean {
  return readMachinePassphrase() !== null;
}

function readMachinePassphrase(): string | null {
  for (const fp of [passphraseFilePath(), legacyPassphraseFilePath()]) {
    try {
      const p = fs.readFileSync(fp, 'utf8').trim();
      if (p.length > 0) return p;
    } catch {
      // try next location
    }
  }
  return null;
}

/**
 * Provision (or read back) a stable machine-local passphrase for the encrypted
 * file store, so `agents secrets` works out of the box on a headless box where
 * the keyring is locked and no AGENTS_SECRETS_PASSPHRASE is set.
 *
 * Security model: this is encryption-at-rest with the key held in a 0600 file —
 * the same posture as an SSH private key. It is NOT equivalent to the common
 * "export AGENTS_SECRETS_PASSPHRASE=… in ~/.zshenv (chmod 600)" workaround, and
 * is strictly safer: this file is read by the one process that needs it, while
 * a shell-rc export is inherited by every process the login shell spawns and is
 * readable from /proc/<pid>/environ by any same-user process (RUSH-1968; see
 * rc-hygiene.ts). The keyring (key in a daemon's locked memory) is stronger
 * still but is unavailable without a graphical/unlocked session.
 */
function provisionMachinePassphrase(): string {
  const existing = readMachinePassphrase();
  if (existing) return existing;

  ensurePassphraseDir();
  const generated = randomBytes(32).toString('base64');
  const fp = passphraseFilePath();
  try {
    // wx: fail if a concurrent process created it first (then we read theirs).
    fs.writeFileSync(fp, generated, { mode: 0o600, flag: 'wx' });
  } catch {
    const raced = readMachinePassphrase();
    if (raced) return raced;
    throw new Error(`Failed to provision machine-local passphrase at ${fp}.`);
  }
  if (!warnedAutoPassphrase) {
    warnedAutoPassphrase = true;
    process.stderr.write(
      `[agents] keyring locked and no AGENTS_SECRETS_PASSPHRASE set; provisioned a ` +
      `machine-local passphrase at ${fp} (mode 0600). Set AGENTS_SECRETS_PASSPHRASE ` +
      `for a key held off disk.\n`
    );
  }
  return generated;
}

/**
 * Resolve the passphrase for the encrypted file store.
 *
 * Order: AGENTS_SECRETS_PASSPHRASE > previously-provisioned machine-local key >
 * legacy co-located key > a freshly auto-provisioned machine-local key. It NEVER
 * prompts, and never fails for WANT of a passphrase — the file store must work on
 * every platform (macOS included) without the user setting, typing, or
 * remembering one. (It can still throw if provisioning cannot write the key file
 * at all; that is a disk/permissions failure, not a missing passphrase.) Provisioning
 * writes a 0600 key file (encryption-at-rest, same posture as an SSH key); set
 * AGENTS_SECRETS_PASSPHRASE to opt into an off-disk key.
 */
export function getPassphrase(): string {
  if (cachedPassphrase !== null) return cachedPassphrase;
  const env = process.env.AGENTS_SECRETS_PASSPHRASE;
  if (env && env.length > 0) {
    cachedPassphrase = env;
    return env;
  }
  // A previously-provisioned machine-local passphrase is this machine's stable
  // file-store key — prefer it so interactive and headless runs always agree.
  const onDisk = readMachinePassphrase();
  if (onDisk) {
    cachedPassphrase = onDisk;
    return onDisk;
  }
  // No env passphrase and no machine-local key yet: silently provision a stable
  // machine-local key (a 0600 file) on EVERY platform, macOS included. This is
  // encryption-at-rest with an on-disk key — the same posture as an SSH private
  // key — so the file store "just works" without the user ever setting, typing,
  // or remembering a passphrase, and never pops a prompt or a Touch ID sheet.
  // Set AGENTS_SECRETS_PASSPHRASE to opt into an off-disk key instead.
  cachedPassphrase = provisionMachinePassphrase();
  return cachedPassphrase;
}

// ---------- AES-256-GCM ----------

/** Encrypted-file on-disk shape. Exported for tests. */
export interface EncFile {
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

/** Encrypt plaintext under a passphrase using AES-256-GCM with a random
 *  scrypt salt and a random 96-bit IV. Exported for tests. */
export function encryptForFallback(plaintext: string, passphrase: string): EncFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/** Decrypt an EncFile under a passphrase. Throws on wrong key or tampered
 *  ciphertext (auth-tag mismatch). Exported for tests. */
export function decryptForFallback(enc: EncFile, passphrase: string): string {
  const salt = Buffer.from(enc.salt, 'hex');
  const iv = Buffer.from(enc.iv, 'hex');
  const authTag = Buffer.from(enc.authTag, 'hex');
  const ciphertext = Buffer.from(enc.ciphertext, 'hex');
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// ---------- file backend ----------

function fileFor(item: string): string {
  return path.join(fileDir(), `${item}.enc`);
}

function fileHas(item: string): boolean {
  return fs.existsSync(fileFor(item));
}

function fileGet(item: string): string {
  const fp = fileFor(item);
  if (!fs.existsSync(fp)) {
    throw new Error(`Secret '${item}' not found in encrypted store.`);
  }
  const raw = fs.readFileSync(fp, 'utf8');
  let parsed: EncFile;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Encrypted secret file ${fp} is corrupt (not valid JSON).`);
  }
  try {
    return decryptForFallback(parsed, getPassphrase());
  } catch {
    throw new Error(
      `Failed to decrypt '${item}'. Wrong AGENTS_SECRETS_PASSPHRASE or tampered file.`
    );
  }
}

function fileGetBatch(items: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items) {
    // A missing file is an absent item. Any error reading an existing file,
    // especially an AES-GCM authentication failure, is a broken store and must
    // stop the caller rather than silently produce an incomplete environment.
    if (!fileHas(item)) continue;
    out.set(item, fileGet(item));
  }
  return out;
}

function fileSet(item: string, value: string): void {
  ensureFileDir();
  // Under the store lock: a write must not interleave with a rotation's swap.
  // `getPassphrase()` takes no options since the auto-provision requirement was
  // dropped (#1658) — provisioning is now unconditional.
  withStoreLock(() => {
    const enc = encryptForFallback(value, getPassphrase());
    fs.writeFileSync(fileFor(item), JSON.stringify(enc), { mode: 0o600 });
  });
}

function fileDelete(item: string): boolean {
  const fp = fileFor(item);
  if (!fs.existsSync(fp)) return true; // idempotent, matches secret-tool clear
  return withStoreLock(() => {
    // Re-check under the lock — a rotation may have swapped the dir since the
    // pre-lock existence probe above.
    if (!fs.existsSync(fp)) return true;
    fs.unlinkSync(fp);
    return true;
  });
}

function fileList(prefix: string): string[] {
  const dir = fileDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.enc'))
    .map((f) => f.slice(0, -'.enc'.length))
    .filter((name) => name.startsWith(prefix));
}

/** True if the fallback dir has any committed encrypted items. */
export function fileStoreHasItems(): boolean {
  try {
    return fs.readdirSync(fileDir()).some((e) => e.endsWith('.enc'));
  } catch {
    return false;
  }
}

/** Low-level file-store ops, exported so callers (linux fallback, macOS
 *  file-backed bundles) can opt into or out of passphrase auto-provision. */
export const fileStore = {
  has: fileHas,
  get: fileGet,
  getBatch: fileGetBatch,
  set: fileSet,
  delete: fileDelete,
  list: fileList,
};

/** File-only KeychainBackend (exported for tests; the Linux backend uses these
 *  ops with auto-provision allowed). */
export const fileBackend: KeychainBackend = {
  has: fileHas,
  get: (item: string) => fileGet(item),
  set: (item: string, value: string) => fileSet(item, value),
  delete: fileDelete,
  list: fileList,
};

/** Resolved passphrase directory (exported for integration tests). */
export function resolvePassphraseDir(): string {
  return passphraseDir();
}

// ---------- passphrase rotation (RUSH-1975) ----------

/**
 * Path of the machine-local passphrase file that currently holds the file-store
 * key, or null if none is provisioned. Prefers the canonical #479 location and
 * falls back to the legacy co-located path, mirroring `readMachinePassphrase`.
 */
export function machinePassphraseSourcePath(): string | null {
  for (const fp of [passphraseFilePath(), legacyPassphraseFilePath()]) {
    try {
      if (fs.readFileSync(fp, 'utf8').trim().length > 0) return fp;
    } catch {
      // try next location
    }
  }
  return null;
}

/**
 * Resolve the key path for a rotation that crashed mid-key-swap and left the live
 * key file absent (Window B: `keyPath` moved to `<key>.rotate-oldkey`, the new key
 * not yet landed). `machinePassphraseSourcePath` returns null in that state because
 * neither canonical nor legacy file has content, so recovery would never run. If a
 * rotation artifact (`.rotate-new` / `.rotate-oldkey`) exists for a canonical key
 * path, that path is the interrupted rotation's target — return it so recovery can
 * finish forward. Null when no such artifact is present.
 */
function resolveInterruptedKeyPath(): string | null {
  for (const fp of [passphraseFilePath(), legacyPassphraseFilePath()]) {
    if (fs.existsSync(`${fp}.rotate-new`) || fs.existsSync(`${fp}.rotate-oldkey`)) return fp;
  }
  // Co-located layout: the key lives inside the store dir and travels with it in a
  // single rename, so no `.rotate-new`/`.rotate-oldkey` key artifacts are ever
  // written. A crash in that rename leaves the store dir absent with its old store +
  // co-located key sitting in the `<dir>.rotate-old-*` backup, and the canonical/
  // legacy key files both gone — so the checks above return null and recovery would
  // never run. If a backup holding a co-located `.passphrase` is present, the
  // interrupted rotation's key target is that legacy co-located path; return it so
  // recovery restores the backup (old store + old key) and heals the store.
  const dir = fileDir();
  if (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    const base = path.basename(dir);
    let entries: string[];
    try { entries = fs.readdirSync(parent); } catch { return null; }
    const bak = entries.find((e) => e.startsWith(`${base}.rotate-old-`));
    if (bak && fs.existsSync(path.join(parent, bak, '.passphrase'))) {
      return legacyPassphraseFilePath();
    }
  }
  return null;
}

/** Outcome of a `rotatePassphrase` run. Carries no secret material. */
export interface RotatePassphraseReport {
  /** True when nothing was written (report-only). */
  dryRun: boolean;
  /** True when the store was re-encrypted and the key file swapped. */
  committed: boolean;
  /** Encrypted items that decrypt under the current key and were (or would be) re-keyed. */
  bundleCount: number;
  /** `.enc` files that do NOT decrypt under the current key — left untouched, never re-keyed. */
  skipped: string[];
  /** Every re-keyed item round-tripped (decrypt) under the new key before any swap. */
  roundTripOk: boolean;
  /** The machine-local passphrase file that was (or would be) rewritten in place. */
  keyFilePath: string;
  /**
   * A previous rotation had left artifacts on disk and they were healed before
   * this rotation proceeded. This happens under `--dry-run` too — recovery is how
   * a crashed store becomes readable again without re-keying it — and is the only
   * thing a dry run writes.
   */
  recoveredInterruptedRotation: boolean;
}

/** Flush a file's data to disk (durability before the atomic swap). */
function writeFileFsync(fp: string, data: string | Buffer, mode: number): void {
  const fd = fs.openSync(fp, 'w', mode);
  try {
    // Narrow to one of fs.writeSync's overloads: the string form encodes as UTF-8,
    // the Buffer form writes raw bytes verbatim (binary-safe copy-through).
    if (typeof data === 'string') fs.writeSync(fd, data);
    else fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // A freshly-created file needs its mode set explicitly — the open() mode is
  // masked by the process umask, so 0600 is not guaranteed by the flag alone.
  try { fs.chmodSync(fp, mode); } catch { /* best effort on platforms without chmod */ }
}

/** fsync a directory so a rename/create in it is durable. Best-effort: some
 *  filesystems reject O_RDONLY fsync on a directory. */
function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // filesystem doesn't support directory fsync — the rename is still ordered
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** True if `enc` decrypts (auth-tag verifies) under `keyVal`. */
function opensUnder(enc: EncFile, keyVal: string): boolean {
  try { decryptForFallback(enc, keyVal); return true; } catch { return false; }
}

/** How a candidate key relates to a store's `.enc` items. */
type StoreKeyMatch = 'all' | 'some' | 'none';

/**
 * Classify how the `.enc` items in `dir` relate to `keyVal`, so recovery can tell
 * a single-key store (safe to sweep) apart from a MIXED store (live data sealed
 * under two keys at once — unsafe). `candidateKeys` is every key a mid-rotation
 * crash could have left on disk: the live key file, `<key>.rotate-new` (the
 * incoming key), and `<key>.rotate-oldkey` (the retired key). An item that opens
 * under NONE of them is a genuine orphan — sealed under a third key and carried
 * through a rotation verbatim — and is ignored: it neither proves nor disproves
 * consistency. Among the remaining, non-orphan items:
 *   'all'  — every one opens under `keyVal`  → `keyVal` is the store's one key
 *   'some' — at least one opens under `keyVal` AND at least one does not → MIXED
 *   'none' — none open under `keyVal`
 *
 * Only 'all' is safe to sweep against. The original "any one item opens" heuristic
 * returned true for a mixed store — so a single stray item sealed under the live
 * key (an interstitial `secrets set` after a mid-swap crash) made recovery sweep
 * `<key>.rotate-new`, the only surviving copy of the key the *other* items need,
 * destroying every one of them silently (RUSH-1975).
 */
function classifyStore(dir: string, keyVal: string | null, candidateKeys: (string | null)[]): StoreKeyMatch {
  if (keyVal == null) return 'none';
  let names: string[];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.enc')); } catch { return 'none'; }
  const otherKeys = candidateKeys.filter((k): k is string => k != null && k !== keyVal);
  let nonOrphan = 0;
  let openUnderKey = 0;
  for (const name of names) {
    let enc: EncFile;
    try { enc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as EncFile; } catch { continue; }
    const opensKey = opensUnder(enc, keyVal);
    // Ignore genuine orphans (open under no candidate key) — a third-party cache
    // carried through verbatim is not evidence of a mixed store.
    if (!opensKey && !otherKeys.some((k) => opensUnder(enc, k))) continue;
    nonOrphan++;
    if (opensKey) openUnderKey++;
  }
  if (openUnderKey === 0) return 'none';
  return openUnderKey === nonOrphan ? 'all' : 'some';
}

/** True if `dir` holds at least one `.enc` item. */
function storeHasEnc(dir: string): boolean {
  try { return fs.readdirSync(dir).some((f) => f.endsWith('.enc')); } catch { return false; }
}

/**
 * `.enc` basenames present in the `<dir>.rotate-old-*` backup but ABSENT from the
 * live `dir` — ciphertext that lives ONLY in the backup. A genuine post-swap store
 * is always a superset of the pre-swap store (rotation re-keys every item and copies
 * orphans/non-.enc files through verbatim — nothing is dropped), so this set is empty
 * for any real completed/interrupted rotation. It is non-empty only when the live
 * `dir` is NOT the post-swap store: an interstitial `secrets set` recreated the store
 * dir after a crash in the move-aside window left it absent (RUSH-1975). Sweeping the
 * backup then destroys those items — so recovery refuses instead.
 */
function backupOnlyEnc(bak: string, dir: string): string[] {
  let bakNames: string[];
  try { bakNames = fs.readdirSync(bak).filter((f) => f.endsWith('.enc')); } catch { return []; }
  let dirNames: Set<string>;
  try { dirNames = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.enc'))); } catch { dirNames = new Set(); }
  return bakNames.filter((n) => !dirNames.has(n));
}

/** Read a key file's trimmed contents, or null if absent/empty. */
function readKeyFile(fp: string): string | null {
  try { const v = fs.readFileSync(fp, 'utf8').trim(); return v.length > 0 ? v : null; }
  catch { return null; }
}

/**
 * Recover from a rotation that was interrupted mid-swap on a prior run, so the
 * store is always left in a single, self-consistent, readable state.
 *
 * Recovery is CONTENT-aware, not presence-aware, and it classifies the WHOLE
 * store, not just one item. The mere existence of the store dir and the key file
 * does not prove they match (RUSH-1975 data-loss window): on the non-co-located
 * key path the swap is four renames, and a crash after the store swap
 * (`stageDir`->`dir`) but before the key swap (`keyTmp`->`keyPath`) finishes
 * leaves a NEW-key store next to the OLD key file, both present. A presence check
 * would see "both here" and wrongly sweep the only copies of the old ciphertext
 * (`<dir>.rotate-old-*`) and the new key (`<key>.rotate-new`), permanently
 * orphaning every secret. So we probe the actual ciphertext with `classifyStore`,
 * which distinguishes a store that opens fully under one key ('all') from one that
 * is MIXED — some items under the live key, others under the incoming key ('some',
 * e.g. after a mid-swap crash contaminated by a later `secrets set`):
 *
 *  1. The live key opens EVERY non-orphan item ('all') → rotation complete and
 *     consistent (or never interrupted); sweeping the `.rotate-*` artifacts is safe —
 *     unless a `<dir>.rotate-old-*` backup still holds `.enc` items absent from the
 *     live dir. That means the live dir is not the post-swap store but a fresh dir an
 *     interstitial `secrets set` created after a crash in the move-aside window left
 *     the store dir absent, so the backup is the only copy of those items → REFUSE.
 *  2. Else, if `<key>.rotate-new` opens every non-orphan item ('all'), the crash
 *     landed after the store swap but before the key swap finished → finish the
 *     rotation forward by installing `.rotate-new` as the live key, then sweep.
 *  3. Else, if neither key opens any item, roll back: restore the
 *     `<dir>.rotate-old-*` backup over `dir` and `<key>.rotate-oldkey` over the key
 *     file — but only once the backup is proven to open fully under the old key.
 *  4. If a key opens SOME but not all items ('some'), the store is MIXED — an
 *     interrupted rotation contaminated by a later write, with live data under two
 *     keys at once. Sweeping would delete the only copy of one of those keys, so we
 *     REFUSE: throw an actionable error and preserve every recovery artifact for
 *     out-of-band repair. Likewise, if neither forward nor rollback can be proven,
 *     leave every artifact in place — a leftover temp dir is recoverable, deleting
 *     the only copy of a key or ciphertext is not.
 *
 * A phase-marker / journal file was considered and deliberately skipped: the
 * AES-256-GCM auth tag already makes the decrypt probe an authoritative,
 * self-validating record of which key matches the store. A separate marker would
 * be a second source of truth that can disagree with reality — its own write has
 * crash windows, and a stale marker misleads — so it would weaken, not strengthen,
 * this guarantee. Idempotent; a no-op when no rotation artifacts are present.
 * Callers run this under the store lock (see `withStoreLock`).
 */
/**
 * Whether a previous rotation left artifacts on disk — i.e. whether
 * {@link recoverInterruptedRotation} would do any work. Read-only, so `--dry-run`
 * can report a pending recovery without performing (and thus writing) one.
 */
export function hasInterruptedRotationArtifacts(keyPath: string): boolean {
  const dir = fileDir();
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  let entries: string[];
  try { entries = fs.readdirSync(parent); } catch { return false; }
  return entries.some((e) => e.startsWith(`${base}.rotate-`))
    || fs.existsSync(`${keyPath}.rotate-new`)
    || fs.existsSync(`${keyPath}.rotate-oldkey`);
}

function recoverInterruptedRotation(keyPath: string): void {
  const dir = fileDir();
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  let entries: string[];
  try { entries = fs.readdirSync(parent); } catch { return; }

  const keyNew = `${keyPath}.rotate-new`;
  const keyOld = `${keyPath}.rotate-oldkey`;
  const bakName = entries.find((e) => e.startsWith(`${base}.rotate-old-`));
  let bakDir = bakName ? path.join(parent, bakName) : null;

  // Nothing rotation-related on disk -> no interrupted rotation to recover.
  if (!hasInterruptedRotationArtifacts(keyPath)) return;

  // If the live store dir vanished mid-swap (crash between the two store renames,
  // before the new store landed), restore the old store from its backup — the key
  // was not touched yet, so old store + old key is a consistent state.
  if (!fs.existsSync(dir) && bakDir && fs.existsSync(bakDir)) {
    fs.renameSync(bakDir, dir);
    bakDir = null; // consumed
  }

  const sweep = (): void => {
    for (const e of fs.readdirSync(parent)) {
      if (e.startsWith(`${base}.rotate-`)) {
        try { fs.rmSync(path.join(parent, e), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    for (const suffix of ['.rotate-new', '.rotate-oldkey']) {
      try { fs.rmSync(`${keyPath}${suffix}`, { force: true }); } catch { /* best effort */ }
    }
  };

  // An empty or unreadable store holds no ciphertext at risk. Only sweep once the
  // live key file is present again; never delete recovery artifacts for a store we
  // cannot probe.
  if (!storeHasEnc(dir)) {
    if (fs.existsSync(keyPath)) sweep();
    return;
  }

  const liveKey = readKeyFile(keyPath);
  const newKey = readKeyFile(keyNew);
  const oldKey = readKeyFile(keyOld);
  const candidates = [liveKey, newKey, oldKey];

  // A MIXED store cannot be swept safely: live data is sealed under two keys at
  // once, so deleting either `.rotate-new` or the old-ciphertext backup destroys
  // one class permanently. Refuse loudly and keep every artifact for out-of-band
  // repair — never report success over a store we would be corrupting.
  const refuseMixed = (label: string): never => {
    throw new Error(
      `Interrupted secrets rotation left a MIXED store at ${dir}: ${label}. This ` +
      `happens when a \`secrets set\` landed between a crashed rotation and this ` +
      `recovery. Refusing to sweep — every recovery artifact is preserved. Recover ` +
      `out of band: for each ${dir}/*.enc, decrypt it under whichever of ${keyPath}` +
      (fs.existsSync(keyNew) ? `, ${keyNew}` : '') +
      (fs.existsSync(keyOld) ? `, ${keyOld}` : '') +
      ` opens it, re-seal all items under one key, then re-run \`rotate-passphrase\`.`,
    );
  };

  // 1. Live key opens the WHOLE store -> rotation complete/consistent. Sweep safe,
  //    UNLESS a `<dir>.rotate-old-*` backup still holds items absent from the live
  //    dir: then the live dir is not the post-swap store but a fresh dir an
  //    interstitial `secrets set` created after a crash in the move-aside window
  //    (store dir absent), and the backup is the ONLY copy of those items. Sweeping
  //    would destroy them, so refuse. Opens only some items -> MIXED, refuse.
  const liveMatch = classifyStore(dir, liveKey, candidates);
  if (liveMatch === 'all') {
    const orphaned = bakDir && fs.existsSync(bakDir) ? backupOnlyEnc(bakDir, dir) : [];
    if (orphaned.length > 0) {
      const shown = orphaned.slice(0, 3).join(', ') + (orphaned.length > 3 ? ', …' : '');
      throw new Error(
        `Interrupted secrets rotation left a MIXED (split) store: the live key opens ` +
        `${dir}, but its backup ${bakDir} holds ${orphaned.length} item(s) absent from ` +
        `the live store (${shown}) — so the live dir is not the whole store. This ` +
        `happens when a \`secrets set\` recreated the store dir after a crash left it ` +
        `absent. Refusing to sweep — every recovery artifact is preserved. Recover out ` +
        `of band: merge ${bakDir}/*.enc into ${dir} (both open under ${keyPath}), then ` +
        `re-run \`rotate-passphrase\`.`,
      );
    }
    sweep();
    return;
  }
  if (liveMatch === 'some') refuseMixed('some items open under the live key and others do not');

  // 2. `.rotate-new` opens the whole store, the live key none of it -> the crash
  //    landed after the store swap, before the key swap finished. Finish the
  //    rotation forward by installing the new key, then sweep. Opens only some ->
  //    MIXED, refuse.
  const newMatch = classifyStore(dir, newKey, candidates);
  if (newMatch === 'all') {
    try { fs.rmSync(keyPath, { force: true }); } catch { /* may be absent mid-key-swap */ }
    fs.renameSync(keyNew, keyPath);
    fsyncDir(path.dirname(keyPath));
    sweep();
    return;
  }
  if (newMatch === 'some') refuseMixed('some items open under the incoming (.rotate-new) key and others do not');

  // 3. Neither key opens the live store -> roll back to the pre-rotation state, but
  //    only once the backup store is proven to open FULLY under the old key (or the
  //    live key, when `.rotate-oldkey` was not written yet — Window A).
  const rollbackKey = bakDir && classifyStore(bakDir, oldKey, candidates) === 'all'
    ? oldKey
    : (bakDir && classifyStore(bakDir, liveKey, candidates) === 'all' ? liveKey : null);
  if (bakDir && fs.existsSync(bakDir) && rollbackKey != null) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(bakDir, dir);
    fsyncDir(path.dirname(dir));
    if (rollbackKey === oldKey && fs.existsSync(keyOld)) {
      try { fs.rmSync(keyPath, { force: true }); } catch { /* may be absent */ }
      fs.renameSync(keyOld, keyPath);
      fsyncDir(path.dirname(keyPath));
    }
    sweep();
    return;
  }

  // 4. Neither forward nor rollback is provable -> leave every artifact untouched
  //    for out-of-band recovery. Do NOT sweep: that is the data-loss bug.
}

/**
 * Rotate the machine-local file-store passphrase: decrypt every `.enc` item
 * under the current key and re-encrypt it under a freshly generated one, then
 * swap both the ciphertext and the key file atomically.
 *
 * Safety contract (RUSH-1975):
 *  - Verify before writing: every re-keyed item must round-trip decrypt under
 *    the new key, and the re-keyed count must reconcile with the source, or the
 *    run aborts having written nothing.
 *  - Atomic: the new store is staged in a sibling temp dir, fsync'd, then swapped
 *    into place by directory rename; the new key file is fsync'd and swapped the
 *    same way. A crash before the swap leaves the old store and old key fully
 *    intact and readable; a crash inside the swap self-heals on the next run
 *    (see `recoverInterruptedRotation`). No half-re-keyed store is ever exposed.
 *  - No plaintext (secret value or passphrase) is ever written to disk, argv, or
 *    a log — only ciphertext is staged, and the new key lands only in the 0600
 *    key file.
 *  - Items that do not decrypt under the current key (orphan caches, stale test
 *    artifacts written under another key) are copied through verbatim, never
 *    re-keyed, and reported in `skipped`.
 *
 * `newPassphrase` and the `on*` callbacks are test seams. `newPassphrase` pins the
 * generated key so a test can assert the swap. `onStagedBeforeCommit` fires after
 * staging but before any swap (a crash here leaves the old store fully intact).
 * `onStoreSwappedBeforeKeySwap` fires after the store swap but before the key swap
 * begins (Window A: NEW-key store beside the OLD key file). `onKeyBackedUpBeforeNewKey`
 * fires after the old key is moved aside but before the new key lands (Window B: NEW
 * store, key file absent). Each throws to simulate a mid-swap crash at that exact
 * point, and next-run recovery must heal it without data loss. `tamperStaged` forces
 * a staged item to fail its round-trip check, exercising the verify-before-swap abort.
 */
export interface RotatePassphraseOpts {
  dryRun?: boolean;
  newPassphrase?: string;
  onStagedBeforeCommit?: () => void;
  onStoreMovedAsideBeforeSwap?: () => void;
  onStoreSwappedBeforeKeySwap?: (heartbeat: () => void) => void;
  onKeyBackedUpBeforeNewKey?: () => void;
  tamperStaged?: boolean;
}

/**
 * Rotate under the exclusive store lock, so no `secrets set`/`delete` and no
 * second rotation can interleave with the swap (see `withStoreLock`). The whole
 * run — recovery, verify, swap — holds the lock; it is released on return or throw.
 */
export function rotatePassphrase(opts: RotatePassphraseOpts = {}): RotatePassphraseReport {
  return withStoreLock((heartbeat) => rotatePassphraseLocked(opts, heartbeat));
}

function rotatePassphraseLocked(opts: RotatePassphraseOpts, heartbeat: () => void = () => {}): RotatePassphraseReport {
  const dryRun = opts.dryRun ?? false;
  // Resolve the key path. If the live key file is absent because a prior rotation
  // crashed mid-key-swap, fall back to the interrupted rotation's target so
  // recovery below can still run and heal the store (RUSH-1975 Window B).
  const keyPath = machinePassphraseSourcePath() ?? resolveInterruptedKeyPath();
  if (!keyPath) {
    throw new Error(
      'No machine-local passphrase to rotate. `rotate-passphrase` re-keys the ' +
      'file store\'s auto-provisioned key; none is provisioned on this machine.',
    );
  }
  // Recovery runs even under --dry-run, deliberately: healing an interrupted
  // rotation is how a crashed store becomes readable again WITHOUT re-keying it,
  // and gating it would leave such a store recoverable only via a full rotation.
  // It is the one thing a dry run writes, so the report says so and the CLI
  // prints it instead of claiming "nothing written".
  const recoveredInterruptedRotation = hasInterruptedRotationArtifacts(keyPath);
  recoverInterruptedRotation(keyPath);

  const oldPass = fs.readFileSync(keyPath, 'utf8').trim();
  if (!oldPass) throw new Error(`Machine-local passphrase file ${keyPath} is empty.`);
  const newPass = opts.newPassphrase ?? randomBytes(32).toString('base64');
  if (newPass === oldPass) throw new Error('New passphrase equals the current one — refusing a no-op rotation.');

  const dir = fileDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.enc'));
  } catch {
    names = [];
  }
  if (names.length === 0) {
    throw new Error(`No encrypted items in ${dir} — nothing to rotate.`);
  }

  // Phase 1 — decrypt-all, re-encrypt, re-verify in memory. Nothing on disk is
  // touched here, so any throw leaves the live store and key file untouched.
  const staged: Array<{ name: string; enc: string }> = [];
  const skipped: string[] = [];
  for (const name of names) {
    // Keep the store lock fresh across the scrypt-bound loop: each item runs the
    // KDF three times (decrypt, re-encrypt, verify), so on a real store this loop
    // outlives the lock's stale window — without this a peer could break the lock
    // as "stale" mid-run and interleave a write (see `withFileLock`'s heartbeat).
    heartbeat();
    const raw = fs.readFileSync(path.join(dir, name), 'utf8');
    let parsed: EncFile;
    try { parsed = JSON.parse(raw); } catch { skipped.push(`${name} (not valid EncFile JSON)`); continue; }
    let plain: string;
    try { plain = decryptForFallback(parsed, oldPass); }
    catch { skipped.push(`${name} (does not decrypt under the current key — orphan)`); continue; }
    let reEnc = encryptForFallback(plain, newPass);
    if (opts.tamperStaged) reEnc = { ...reEnc, ciphertext: `00${reEnc.ciphertext.slice(2)}` };
    let check: string;
    try { check = decryptForFallback(reEnc, newPass); }
    catch { throw new Error(`Re-encryption of ${name} failed to verify under the new key — aborted, nothing written.`); }
    if (check !== plain) throw new Error(`Round-trip mismatch on ${name} — aborted, nothing written.`);
    staged.push({ name, enc: JSON.stringify(reEnc) });
  }
  if (staged.length === 0) {
    throw new Error('No item decrypted under the current machine-local key — aborted, nothing written.');
  }

  const report: RotatePassphraseReport = {
    dryRun,
    committed: false,
    bundleCount: staged.length,
    skipped,
    roundTripOk: true,
    keyFilePath: keyPath,
    recoveredInterruptedRotation,
  };
  if (dryRun) return report;

  // Phase 2 — stage the complete replacement store in a sibling temp dir, fsync,
  // then swap. Orphans and any non-.enc files are copied through verbatim so the
  // swapped dir is a complete superset of the old one (nothing is dropped).
  const keyColocated = path.dirname(keyPath) === dir;
  const rand = randomBytes(6).toString('hex');
  const stageDir = `${dir}.rotate-${rand}`;
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  const stagedNames = new Set(staged.map((s) => s.name));
  for (const { name, enc } of staged) {
    heartbeat(); // each write is an fsync; keep the lock fresh across the batch
    writeFileFsync(path.join(stageDir, name), enc, 0o600);
  }
  for (const entry of fs.readdirSync(dir)) {
    if (stagedNames.has(entry)) continue;
    if (keyColocated && entry === path.basename(keyPath)) continue; // rewritten below, not copied
    const src = path.join(dir, entry);
    if (!fs.statSync(src).isFile()) continue;
    heartbeat();
    // Copy through as raw bytes — reading as 'utf8' would decode any non-UTF-8
    // byte to U+FFFD and silently corrupt the file on the way through the swap.
    writeFileFsync(path.join(stageDir, entry), fs.readFileSync(src), 0o600);
  }
  // A co-located legacy key travels with the store: write the new value into the
  // staged dir so a single directory swap commits both ciphertext and key.
  if (keyColocated) writeFileFsync(path.join(stageDir, path.basename(keyPath)), newPass, 0o600);
  fsyncDir(stageDir);

  // Test seam: simulate a crash after staging but before the swap. The live store
  // and key file are still untouched at this point.
  opts.onStagedBeforeCommit?.();

  // For a non-co-located key, stage the new key beside the old one first so the
  // swap is two quick renames with no I/O between them.
  const keyTmp = `${keyPath}.rotate-new`;
  if (!keyColocated) {
    writeFileFsync(keyTmp, newPass, 0o600);
    fsyncDir(path.dirname(keyPath));
  }

  // Swap. Move the live store aside, then the staged store into place. The gap
  // between these two renames is the only crash window that leaves the store dir
  // absent; recoverInterruptedRotation restores it from the backup on next run.
  const bakDir = `${dir}.rotate-old-${rand}`;
  fs.renameSync(dir, bakDir);
  // Test seam: crash after the live store is moved aside, before the staged store
  // lands (the store dir is absent). For a co-located key this is the ONLY swap
  // window — the single rename carries both ciphertext and key.
  opts.onStoreMovedAsideBeforeSwap?.();
  fs.renameSync(stageDir, dir);
  fsyncDir(path.dirname(dir));
  const keyBak = `${keyPath}.rotate-oldkey`;
  if (!keyColocated) {
    // Test seam: crash after the store swap, before the key swap begins (Window A).
    // Also receives the lock heartbeat so a test can prove a long hold stays fresh.
    opts.onStoreSwappedBeforeKeySwap?.(heartbeat);
    fs.renameSync(keyPath, keyBak);
    // Test seam: crash after the old key is moved aside, before the new key lands (Window B).
    opts.onKeyBackedUpBeforeNewKey?.();
    fs.renameSync(keyTmp, keyPath);
    fsyncDir(path.dirname(keyPath));
  }

  // Verify a real read out of the now-live store under the new key. On failure,
  // roll the store (and key) back to the backup — the old passphrase still works.
  try {
    const probe = JSON.parse(fs.readFileSync(path.join(dir, staged[0].name), 'utf8')) as EncFile;
    decryptForFallback(probe, newPass);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(bakDir, dir);
    if (!keyColocated && fs.existsSync(keyBak)) {
      try { fs.rmSync(keyPath, { force: true }); } catch { /* may not exist */ }
      fs.renameSync(keyBak, keyPath);
    }
    throw new Error(`Post-swap verification failed; rolled back to the old key. (${(err as Error).message})`);
  }

  // Committed. Drop the old ciphertext and old key — both hold the retired key.
  fs.rmSync(bakDir, { recursive: true, force: true });
  if (!keyColocated) fs.rmSync(keyBak, { force: true });
  cachedPassphrase = newPass;
  report.committed = true;
  return report;
}

/** Test-only: reset module state (file dir + cached passphrase). */
export function _resetFileStoreForTest(opts: {
  fileDir?: string | null;
  passphraseDir?: string | null;
  passphrase?: string | null;
} = {}): void {
  fileDirOverride = opts.fileDir ?? null;
  if (opts.passphraseDir !== undefined) {
    passphraseDirOverride = opts.passphraseDir;
  } else if (opts.fileDir) {
    // Hermetic sibling when only the store dir is overridden (linux.test.ts).
    passphraseDirOverride = path.resolve(opts.fileDir, '..', `${path.basename(opts.fileDir)}-key`);
  } else {
    passphraseDirOverride = null;
  }
  cachedPassphrase = opts.passphrase ?? null;
  warnedAutoPassphrase = false;
  lockAcquireTimeoutMsOverride = null;
  lockStaleMsOverride = null;
}

/** Test-only: shorten the store-lock acquire timeout so a contended-lock assertion
 *  fails fast instead of waiting out the 30s production budget. */
export function _setFileStoreLockTimeoutForTest(ms: number | null): void {
  lockAcquireTimeoutMsOverride = ms;
}

/** Test-only: shrink the store-lock stale window so a heartbeat/steal assertion runs
 *  in milliseconds instead of the 5s production window. */
export function _setFileStoreLockStaleMsForTest(ms: number | null): void {
  lockStaleMsOverride = ms;
}

/** Test-only: the cross-process store-lock target (sibling of the store dir). */
export function _fileStoreLockPathForTest(): string {
  return fileStoreLockPath();
}
