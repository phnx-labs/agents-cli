/**
 * Tests for the per-harness auth-operation mutex (PHNX-3940 security follow-up).
 *
 * The mutex has two layers:
 *  1. In-process: a per-harness boolean flag.
 *  2. Cross-process: a lock file with pid + heartbeat timestamp.
 *
 * These tests cover both layers with real-filesystem I/O; no mocking.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireAuthOperationLock, authLockFilePath } from './auth-operation-lock.js';

// Each test gets its own temp directory so lock files don't interfere.
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-op-lock-test-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('in-process layer', () => {
  it('acquires and releases cleanly', () => {
    const lock = acquireAuthOperationLock('claude', stateDir);
    expect(fs.existsSync(authLockFilePath('claude', stateDir))).toBe(true);
    lock.release();
    expect(fs.existsSync(authLockFilePath('claude', stateDir))).toBe(false);
  });

  it('fails immediately when the same harness is already held', () => {
    const lock = acquireAuthOperationLock('claude', stateDir);
    try {
      expect(() => acquireAuthOperationLock('claude', stateDir)).toThrow(/already in progress/i);
    } finally {
      lock.release();
    }
  });

  it('allows a different harness concurrently', () => {
    const lock1 = acquireAuthOperationLock('claude', stateDir);
    let lock2: ReturnType<typeof acquireAuthOperationLock> | undefined;
    try {
      expect(() => { lock2 = acquireAuthOperationLock('codex', stateDir); }).not.toThrow();
    } finally {
      lock1.release();
      lock2?.release();
    }
  });

  it('is re-entrant safe: released lock can be re-acquired', () => {
    const lock1 = acquireAuthOperationLock('claude', stateDir);
    lock1.release();
    const lock2 = acquireAuthOperationLock('claude', stateDir);
    lock2.release();
    // No error thrown — both acquired successfully.
  });

  it('release is idempotent: calling release twice does not throw', () => {
    const lock = acquireAuthOperationLock('claude', stateDir);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  it('concurrent Promises: second caller sees "already in progress" before the first finishes', async () => {
    const errors: string[] = [];
    // Hold the lock for the duration of one Promise, and try to acquire from a
    // second Promise that runs before the first releases.
    let releaseFn: (() => void) | undefined;
    const firstDone = new Promise<void>(resolve => {
      const lock = acquireAuthOperationLock('claude', stateDir);
      releaseFn = () => { lock.release(); resolve(); };
    });

    // Second acquire must fail immediately — it does not wait for firstDone.
    try {
      acquireAuthOperationLock('claude', stateDir).release();
    } catch (err) {
      errors.push((err as Error).message);
    }

    releaseFn!();
    await firstDone;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/already in progress/i);

    // After release, a new acquire should succeed.
    const lock3 = acquireAuthOperationLock('claude', stateDir);
    lock3.release();
  });
});

describe('cross-process layer (lock file)', () => {
  it('writes a lock file with the current pid', () => {
    const lock = acquireAuthOperationLock('claude', stateDir);
    try {
      const data = JSON.parse(fs.readFileSync(authLockFilePath('claude', stateDir), 'utf8'));
      expect(data.pid).toBe(process.pid);
      expect(typeof data.heartbeatAt).toBe('number');
    } finally {
      lock.release();
    }
  });

  it('detects a stale lock file from a dead pid and reclaims it', () => {
    // Write a lock file as-if from a dead process with an old heartbeat.
    const lockPath = authLockFilePath('claude', stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // PID 99999999 almost certainly does not exist, and heartbeatAt is ancient.
    const staleEntry = { pid: 99_999_999, heartbeatAt: Date.now() - 60_000 };
    fs.writeFileSync(lockPath, JSON.stringify(staleEntry));

    // acquireAuthOperationLock should reclaim the stale file.
    const lock = acquireAuthOperationLock('claude', stateDir);
    try {
      const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      expect(data.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it('refuses to reclaim a fresh lock from a live process', () => {
    // Simulate a fresh lock from THIS pid (which is alive) — this is what
    // a second process invocation would see.
    const lockPath = authLockFilePath('claude', stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const freshEntry = { pid: process.pid, heartbeatAt: Date.now() };
    fs.writeFileSync(lockPath, JSON.stringify(freshEntry));

    // In-process layer sees no held flag, so it passes; file layer must refuse.
    expect(() => acquireAuthOperationLock('claude', stateDir)).toThrow(/already in progress/i);

    // Clean up the planted file so afterEach can remove the dir.
    fs.unlinkSync(lockPath);
  });

  it('release removes the lock file', () => {
    const lock = acquireAuthOperationLock('claude', stateDir);
    lock.release();
    expect(fs.existsSync(authLockFilePath('claude', stateDir))).toBe(false);
  });

  it('creates parent dirs when the state dir does not exist yet', () => {
    const nested = path.join(stateDir, 'new', 'sub');
    // Do not pre-create `nested` — lock should create it.
    const lock = acquireAuthOperationLock('claude', nested);
    try {
      expect(fs.existsSync(authLockFilePath('claude', nested))).toBe(true);
    } finally {
      lock.release();
    }
  });
});

describe('runConnect integration: parallel same-harness connects are serialized', () => {
  // This verifies the mutex integrates correctly with runConnect by driving two
  // concurrent calls for the same harness — only one should proceed; the other
  // must fail immediately with the contention error. We use injected runners so
  // no real network or filesystem install occurs.
  it('second parallel connect fails immediately when first holds the mutex', async () => {
    // Import lazily so the test env's meta state is set up before the import.
    const { runConnect } = await import('./connect.js');
    const { readMeta, updateMeta } = await import('../state.js');

    // Blank slate.
    updateMeta(meta => ({
      ...meta,
      accounts: { ...meta.accounts, native: {}, defaults: {} },
      deviceAccounts: { ...meta.deviceAccounts, native: {}, homes: {}, pendingConnects: {} },
    }));

    // A runner that hangs indefinitely during launchLogin (simulating the browser
    // OAuth flow). The SECOND connect attempt sees the mutex is held and throws
    // before even reaching the runner.
    let releaseLogin: (() => void) | undefined;
    const hangingLoginPromise = new Promise<{ code: number }>(resolve => {
      releaseLogin = () => resolve({ code: 0 });
    });

    const slowRunners = {
      installedLabels: () => [] as string[],
      install: async () => ({ success: true }),
      launchLogin: async () => hangingLoginPromise,
      observeIdentity: async () => ({ identityKey: 'claude:user=hang', email: 'h@x.com', signedIn: true, releaseVersion: null }),
      signedInHomes: async () => [] as Array<{ agent: 'claude'; identityKey: string; label: string }>,
    };

    // First connect starts and hangs in the login phase.
    const first = runConnect('claude', 'work-a', { meta: readMeta(), stateDir }, slowRunners as never);

    // Second connect for the SAME harness should fail immediately (no waiting).
    await expect(
      runConnect('claude', 'work-b', { meta: readMeta(), stateDir }, slowRunners as never),
    ).rejects.toThrow(/already in progress/i);

    // Unblock the first connect and clean up.
    releaseLogin!();
    // first will error on identity check (we'll just ignore that in this test)
    await first.catch(() => { /* expected failure from identity / meta race */ });

    updateMeta(meta => ({
      ...meta,
      accounts: { ...meta.accounts, native: {}, defaults: {} },
      deviceAccounts: { ...meta.deviceAccounts, native: {}, homes: {}, pendingConnects: {} },
    }));
  });
});
