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
export function atomicWriteFileSync(filePath: string, content: string, options: fs.WriteFileOptions = 'utf-8'): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  fs.writeFileSync(tmpPath, content, options);
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
 *
 * `fn` is handed a `heartbeat()` it can call during a long, fully SYNCHRONOUS
 * critical section. proper-lockfile keeps a held lock "alive" by refreshing its
 * lockfile mtime on a `setTimeout` every `stale/2` — but that timer only fires
 * when the event loop gets a turn. A synchronous hold that outruns `stale`
 * (e.g. the scrypt-bound rotation loop in filestore.ts, ~16s on a real store)
 * never yields, so the timer cannot run: the lock ages past `stale` mid-hold and a
 * peer contending for it treats the live holder as crashed, breaks the lock, and
 * interleaves — corrupting the invariant the lock exists to protect, with no crash
 * involved. `heartbeat()` drives the same refresh synchronously (bumps the lockfile
 * mtime), so a long sync holder stays fresh while the short `stale` window still
 * detects a genuinely crashed holder within LOCK_STALE_MS. Callers whose critical
 * section is short (a single read-modify-write) can ignore it.
 */
export interface FileLockOptions {
  staleMs?: number;
  acquireTimeoutMs?: number;
}

export function withFileLock<T>(filePath: string, fn: (heartbeat: () => void) => T, opts: FileLockOptions = {}): T {
  let release: (() => void) | null = null;
  let lastError: unknown;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS;
  const deadline = Date.now() + acquireTimeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      release = lockfile.lockSync(filePath, { stale: staleMs });
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
      `Could not acquire lock for ${filePath} after ${acquireTimeoutMs}ms: ${message}`,
    );
  }
  // proper-lockfile's lock dir is `<filePath>.lock`; touching its mtime is exactly
  // what proper-lockfile's own async updater does, so the staleness check keys off
  // a fresh mtime. Best-effort: a failed touch just leaves the async updater's
  // behaviour unchanged (no worse than before this heartbeat existed).
  const lockDir = `${filePath}.lock`;
  const heartbeat = (): void => {
    try { const now = new Date(); fs.utimesSync(lockDir, now, now); } catch { /* best effort */ }
  };
  try {
    return fn(heartbeat);
  } finally {
    release();
  }
}
