/**
 * Per-harness auth-operation mutex (PHNX-3940 security follow-up).
 *
 * Serializes connect and logout per harness: two parallel native-login flows for
 * the same harness race to read meta, allocate a slot, and register — the second
 * login can overwrite the first account's home before the duplicate-name check
 * fires. This mutex ensures only ONE connect or logout runs per harness at a
 * time, failing immediately on contention (never queuing — a human browser flow
 * must not wait silently behind another).
 *
 * Two layers of protection:
 *  1. In-process: a per-harness boolean flag catches concurrent Promises in the
 *     same process (e.g. two `runConnect` calls without an await in between).
 *  2. Cross-process: a lock file with pid + heartbeat catches multiple
 *     `agents accounts connect` invocations running in parallel in separate
 *     processes. The heartbeat is renewed every {@link HEARTBEAT_INTERVAL_MS} so
 *     a long browser OAuth flow does not expire the lock while the user signs in.
 *
 * Scope: NATIVE auth operations only (connect, logout). Provider flows (API-key,
 * setup-token, bearer) are independent writes and do not need serialization here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRuntimeStateDir } from '../state.js';
import type { AgentId } from '../types.js';

/** Renew the lock-file heartbeat this often. */
const HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * A lock whose heartbeat is older than this AND whose pid is dead is stale and
 * may be reclaimed. Set well above the heartbeat interval so a momentary disk
 * flush delay never causes a false reclaim.
 */
const STALE_THRESHOLD_MS = 30_000;

interface LockData { pid: number; heartbeatAt: number; }

// In-process flag: true while a native auth op is in progress for that harness.
const inProcessHeld = new Map<AgentId, boolean>();

/** Path of the lock file for `agent` in the runtime-state dir (or `stateDir`). */
export function authLockFilePath(agent: AgentId, stateDir?: string): string {
  return path.join(stateDir ?? getRuntimeStateDir(), `auth-op-lock-${agent}.json`);
}

function readLockData(lockPath: string): LockData | null {
  try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockData; }
  catch { return null; }
}

function writeLockExclusive(lockPath: string, data: LockData): void {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  // 'wx' = O_WRONLY | O_CREAT | O_EXCL — atomic: throws EEXIST if file is present.
  fs.writeFileSync(lockPath, JSON.stringify(data), { flag: 'wx' });
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function buildError(agent: AgentId, ownerPid?: number): Error {
  const pidNote = ownerPid !== undefined ? ` (pid ${ownerPid})` : '';
  return new Error(
    `A ${agent} sign-in is already in progress${pidNote}. `
    + `Wait for it to complete, then try again — or restart your terminal if the other sign-in stalled.`,
  );
}

export interface AuthOperationLock {
  /** Release the mutex. Safe to call multiple times; idempotent. */
  release(): void;
}

/**
 * Acquire the per-harness auth-operation mutex. Throws immediately on contention
 * — never queues or waits. Always call {@link AuthOperationLock.release} in a
 * `finally` block so exceptions still release the lock.
 *
 * @param stateDir Override the runtime-state dir (for tests — use a tmp dir).
 */
export function acquireAuthOperationLock(agent: AgentId, stateDir?: string): AuthOperationLock {
  // ── Layer 1: in-process guard ─────────────────────────────────────────────
  if (inProcessHeld.get(agent)) throw buildError(agent);
  inProcessHeld.set(agent, true);

  // ── Layer 2: cross-process file lock ──────────────────────────────────────
  const lockPath = authLockFilePath(agent, stateDir);
  const lockData: LockData = { pid: process.pid, heartbeatAt: Date.now() };
  let fileAcquired = false;

  const acquireFileLock = (): void => {
    try {
      writeLockExclusive(lockPath, lockData);
      fileAcquired = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        // Unexpected filesystem error (read-only mount, permissions…): don't
        // block the auth operation over a file we can't write — the in-process
        // layer is still held and covers the common concurrent-Promise case.
        return;
      }

      // File exists — check whether the holder is still alive.
      const existing = readLockData(lockPath);
      if (!existing) {
        // Corrupt or unreadable — attempt a take-over.
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        try { writeLockExclusive(lockPath, lockData); fileAcquired = true; } catch { /* ignore */ }
        return;
      }

      const age = Date.now() - existing.heartbeatAt;
      if (age > STALE_THRESHOLD_MS && !isProcessAlive(existing.pid)) {
        // Stale lock from a dead process — reclaim.
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        try { writeLockExclusive(lockPath, lockData); fileAcquired = true; } catch { /* ignore */ }
        return;
      }

      // Fresh lock by a live process — fail immediately.
      inProcessHeld.delete(agent);
      throw buildError(agent, existing.pid);
    }
  };

  acquireFileLock();

  // Heartbeat: keep the lock file fresh during a long browser OAuth flow.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (fileAcquired) {
    heartbeatTimer = setInterval(() => {
      try {
        const current = readLockData(lockPath);
        // Bail if another process reclaimed the file (e.g. after a stale-check race).
        if (current?.pid !== process.pid) return;
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, heartbeatAt: Date.now() }));
      } catch { /* ignore */ }
    }, HEARTBEAT_INTERVAL_MS);
    // Don't keep the Node.js event loop alive just for the heartbeat.
    heartbeatTimer.unref?.();
  }

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      inProcessHeld.delete(agent);
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (fileAcquired) {
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        fileAcquired = false;
      }
    },
  };
}
