import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import lockfile from 'proper-lockfile';

const LOCK_STALE_MS = 5_000;
// Wall-clock budget to acquire the lock before giving up. A count-bounded retry
// (the old 5 attempts / ~750ms ceiling) could expire while a peer legitimately
// held the lock — under CI/parallel load two `agents` invocations mutating
// agents.yaml would have one throw and silently drop its write. The budget must
// comfortably exceed both a normal critical-section hold and the stale-break
// window (LOCK_STALE_MS): a dead holder's lock turns stale at 5s and is then
// broken on the next attempt, so this only ever waits out a live, in-progress
// holder. Bounded (not unbounded) so a truly wedged holder still surfaces an
// error instead of hanging the CLI forever.
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MIN_MS = 50;
const LOCK_RETRY_MAX_MS = 250;

// Reused across all sleepSync calls — avoids allocating a new SAB each time.
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms: number): void {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

/**
 * Ensures the target file (and its parent directory) exist so proper-lockfile
 * can create a sibling .lock directory. Created with flag 'wx' so concurrent
 * creation races are safe (EEXIST is swallowed).
 */
export function ensureLockTarget(filePath: string, initialContent = '', dirMode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, ...(dirMode != null ? { mode: dirMode } : {}) });
  if (fs.existsSync(filePath)) return;
  try {
    fs.writeFileSync(filePath, initialContent, { encoding: 'utf-8', flag: 'wx' });
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }
}

/**
 * Writes content to filePath via a temp file + rename so readers never see a
 * partial write. On POSIX, rename(2) is atomic.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Acquires an exclusive proper-lockfile lock on filePath, runs fn, then
 * releases the lock. Retries with capped linear back-off until either the lock
 * is acquired or LOCK_ACQUIRE_TIMEOUT_MS elapses. Breaks stale locks older than
 * LOCK_STALE_MS, so a crashed holder never blocks past the stale window.
 */
export function withFileLock<T>(filePath: string, fn: () => T): T {
  let release: (() => void) | null = null;
  let lastError: unknown;
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      release = lockfile.lockSync(filePath, { stale: LOCK_STALE_MS });
      break;
    } catch (err) {
      lastError = err;
      if (Date.now() >= deadline) break;
      const backoff = Math.min(LOCK_RETRY_MIN_MS * (attempt + 1), LOCK_RETRY_MAX_MS);
      sleepSync(Math.min(backoff, Math.max(0, deadline - Date.now())));
    }
  }
  if (!release) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Could not acquire lock for ${filePath} after ${LOCK_ACQUIRE_TIMEOUT_MS}ms: ${message}`,
    );
  }
  try {
    return fn();
  } finally {
    release();
  }
}
