import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import lockfile from 'proper-lockfile';

const LOCK_STALE_MS = 5_000;
const LOCK_RETRIES = 5;

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
 * releases the lock. Retries up to LOCK_RETRIES times with linear back-off.
 * Breaks stale locks older than LOCK_STALE_MS.
 */
export function withFileLock<T>(filePath: string, fn: () => T): T {
  let release: (() => void) | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt++) {
    try {
      release = lockfile.lockSync(filePath, { stale: LOCK_STALE_MS });
      break;
    } catch (err) {
      lastError = err;
      if (attempt < LOCK_RETRIES) sleepSync(50 * (attempt + 1));
    }
  }
  if (!release) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Could not acquire lock for ${filePath}: ${message}`);
  }
  try {
    return fn();
  } finally {
    release();
  }
}
