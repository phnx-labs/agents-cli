/**
 * Negative memo for failed/cancelled macOS keychain reads (the "back-off").
 *
 * A cancelled Touch ID sheet is the user saying "not now" — but a polling
 * caller (AGI EXT host's `agents view` loop, a watch script)
 * retries the same read a few seconds later and pops the sheet again, forever.
 * The headless guard (index.ts `assertRawKeychainReadAllowed`) covers the
 * no-TTY case; this memo covers a context that CAN prompt but just had its
 * prompt cancelled or fail: the next read of the same item within the TTL
 * throws the back-off error instead of re-prompting. Any successful read (or
 * write) of the item clears the memo.
 *
 * Stored as regenerable state under `~/.agents/.cache/keychain-read-backoff/`,
 * one file per item (filename is a hash of the item name; the file carries no
 * secret material — a name and a deadline only). All operations are
 * best-effort: a lost memo costs at most one extra prompt, never a read.
 */

import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** How long a failed/cancelled read suppresses retries of the same item. */
export const KEYCHAIN_READ_BACKOFF_TTL_MS = 5 * 60 * 1000;

let dirOverride: string | null = null;

/** Test seam: point the memo at a temp dir so tests never touch the real cache. */
export function setKeychainReadBackoffDirForTest(dir: string | null): void {
  dirOverride = dir;
}

function backoffDir(): string {
  return dirOverride ?? path.join(os.homedir(), '.agents', '.cache', 'keychain-read-backoff');
}

function backoffFile(key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return path.join(backoffDir(), `${digest}.json`);
}

/** True while `key` is inside the back-off window opened by a failed/cancelled read. */
export function isKeychainReadBackedOff(key: string, now: number = Date.now()): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(backoffFile(key), 'utf8')) as { until?: unknown };
    return typeof parsed.until === 'number' && parsed.until > now;
  } catch {
    return false; // absent or malformed memo → no back-off
  }
}

/** Open (or refresh) the back-off window for `key` after a failed/cancelled read. */
export function noteKeychainReadFailure(key: string, now: number = Date.now()): void {
  try {
    fs.mkdirSync(backoffDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      backoffFile(key),
      JSON.stringify({ item: key, until: now + KEYCHAIN_READ_BACKOFF_TTL_MS }),
      { mode: 0o600 },
    );
  } catch {
    /* best-effort — the cache dir is regenerable; a lost memo costs one prompt */
  }
}

/** Clear the memo: a successful read or write of the item resets the back-off. */
export function clearKeychainReadBackoff(key: string): void {
  try {
    fs.rmSync(backoffFile(key), { force: true });
  } catch {
    /* best-effort */
  }
}
