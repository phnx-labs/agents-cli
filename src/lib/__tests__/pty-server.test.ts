/**
 * PTY sidecar server hardening tests.
 *
 * Two security invariants are pinned here:
 *
 *   1. The unix socket lands at mode 0o600 — without that, any local user
 *      with execute on ~/.agents can connect and drive PTY sessions.
 *      Verified by booting the real server and stat()-ing the inode.
 *
 *   2. captureProcessStartTime returns a stable identifier we can use to
 *      defeat PID reuse before sending kill(2) — a structural check that
 *      the helper is exported and behaves on the current platform.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

const { TEST_HOME } = vi.hoisted(() => {
  const nodeOs = require('os');
  const nodeFs = require('fs');
  const nodePath = require('path');
  const testHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'agents-pty-server-test-'));
  // Set before state.ts loads so its module-level HOME constant picks up the override.
  process.env.HOME = testHome;
  return { TEST_HOME: testHome };
});

const { runPtyServer, captureProcessStartTime, getSocketPath } = await import('../pty-server.js');

afterEach(async () => {
  // Belt-and-braces cleanup so a hanging server from one test doesn't
  // bleed into the next.
  const sock = path.join(TEST_HOME, '.agents', '.cache', 'helpers', 'pty', 'pty.sock');
  await fsp.rm(sock, { force: true });
});

describe('PTY socket permission', () => {
  it('chmods the socket to 0o600 immediately after listen', async () => {
    // runPtyServer awaits forever; kick it off without awaiting and poll
    // for the socket inode to appear.
    const serverPromise = runPtyServer().catch(() => {
      // Server shutdown via process.exit will reject the keep-alive
      // promise — swallow so the test doesn't see an unhandled rejection.
    });

    const socketPath = getSocketPath();
    const deadline = Date.now() + 10_000;
    let stat: fs.Stats | null = null;
    while (Date.now() < deadline) {
      try {
        stat = fs.statSync(socketPath);
        if (stat.isSocket()) break;
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(stat, 'pty.sock should exist after server startup').not.toBeNull();
    // Socket should be owner-only: rw for user, nothing for group/other.
    const mode = stat!.mode & 0o777;
    expect(mode.toString(8)).toBe('600');

    // Parent dir lockdown is also part of the fix — verify it landed at 0o700.
    const parent = fs.statSync(path.join(TEST_HOME, '.agents', '.cache', 'helpers', 'pty'));
    expect((parent.mode & 0o777).toString(8)).toBe('700');

    // The server holds the loop open with `await new Promise(() => {})` —
    // there is no clean stop API exposed, so we send SIGTERM at the OS
    // level. The shutdown handler closes the server and unlinks the socket.
    process.kill(process.pid, 0); // sanity: we're alive
    // Trigger the shutdown by deleting the socket and signaling the server.
    // (The server registers SIGTERM/SIGINT handlers that call shutdown().)
    // We can't send SIGTERM to ourselves without killing the test runner,
    // so instead just unlink the socket — the next request would fail and
    // the cleanup interval will eventually expire the server. For test
    // hygiene, we let the process exit at suite end.
    await Promise.race([serverPromise, Promise.resolve()]);
  }, 15_000);
});

describe('captureProcessStartTime', () => {
  it('returns null or a non-empty string for the current process', () => {
    const value = captureProcessStartTime(process.pid);
    expect(value === null || typeof value === 'string').toBe(true);
    if (typeof value === 'string') {
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('returns the same value across calls (stable identifier)', () => {
    const a = captureProcessStartTime(process.pid);
    const b = captureProcessStartTime(process.pid);
    expect(a).toBe(b);
  });

  it('returns null for invalid pids', () => {
    expect(captureProcessStartTime(0)).toBeNull();
    expect(captureProcessStartTime(-1)).toBeNull();
  });
});
