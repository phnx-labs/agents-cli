import { afterEach, describe, it, expect, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'fs';
import * as net from 'net';
import * as path from 'path';
import {
  BrowserDaemonNotRunningError,
  formatBrowserDaemonNotRunningError,
  getSocketPath,
  isDaemonReachable,
  sendIPCRequest,
  shouldRestartStaleDaemon,
} from './ipc.js';
import { getHelpersDir } from '../state.js';
import { ipcEndpoint } from '../platform/index.js';
import { startDaemon } from '../daemon.js';

const HELPER_DIR = `/tmp/agents-cli-browser-ipc-${process.pid}`;

// vi.mock factories close over local state but vitest 4 hoists them above
// const declarations. Keep everything the factories reference inline so the
// hoist is safe, then retrieve the vi.fn() back through the mocked module
// (`startDaemon`) for assertions.
// Redirect ONLY the helpers dir, into a per-pid temp dir; everything else in
// state.js stays real. A whole-module replacement broke any collaborator that
// reaches state.js transitively (BrowserService -> version.ts ->
// getCliVersionCachePath), which the stop() test below constructs for real.
vi.mock('../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state.js')>()),
  getHelpersDir: vi.fn(() => `/tmp/agents-cli-browser-ipc-${process.pid}`),
}));

vi.mock('../daemon.js', () => ({
  startDaemon: vi.fn(),
  stopDaemon: vi.fn(),
}));

afterEach(() => {
  rmSync(HELPER_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('getSocketPath', () => {
  it('places the browser IPC socket in its own helper subdirectory', () => {
    expect(getSocketPath()).toBe(path.join(getHelpersDir(), 'browser', 'browser.sock'));
  });
});

describe('sendIPCRequest', () => {
  it('reports daemon-not-running without starting the daemon when autoStartDaemon is false', async () => {
    await expect(
      sendIPCRequest({ action: 'status' }, { autoStartDaemon: false })
    ).rejects.toThrow(BrowserDaemonNotRunningError);
    await expect(
      sendIPCRequest({ action: 'status' }, { autoStartDaemon: false })
    ).rejects.toThrow(formatBrowserDaemonNotRunningError());
    expect(startDaemon).not.toHaveBeenCalled();
  });
});

// RUSH-2421: `stop()` called `server.close()` and moved on. `close()` is
// asynchronous — it stops accepting at once, but the binding is not released
// until the 'close' event fires, after existing connections end. So `stop()`
// resolved while the socket was still held, and the daemon's `handleShutdown`
// awaits `stop()` before exiting, which is exactly the proof a successor's
// `claimDaemonInstance` relies on ("the incumbent is dead, so its resources are
// free", SING-11). Resolving early made that proof false.
//
// An open connection is what makes the difference observable: with one held,
// `close()` cannot complete, so a correct `stop()` must still be pending.
describe('BrowserIPCServer.stop (releases the binding, promptly)', () => {
  it('ends held connections and resolves with the socket genuinely released', async () => {
    const { BrowserIPCServer } = await import('./ipc.js');
    const { BrowserService } = await import('./service.js');
    const server = new BrowserIPCServer(new BrowserService());
    await server.start();

    // A warm client connection — the normal case, not an edge case: clients
    // hold one open between actions on purpose.
    const held = net.createConnection(ipcEndpoint(getSocketPath()));
    await new Promise<void>((resolve, reject) => {
      held.on('connect', () => resolve());
      held.on('error', reject);
    });
    let clientSawClose = false;
    held.on('close', () => { clientSawClose = true; });

    // `net.Server.close()` does not complete while a connection is open, so a
    // stop that WAITS for the client sits there until its timeout. That is what
    // made every graceful daemon stop escalate to killTree: handleShutdown
    // awaits this, and the timeout equalled the daemon's SIGTERM grace window.
    // stop() must therefore END the connection, not wait for it.
    const started = Date.now();
    await server.stop();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(clientSawClose).toBe(true);
    // The binding is gone: a fresh connect finds nothing accepting.
    await expect(new Promise((resolve, reject) => {
      const probe = net.createConnection(ipcEndpoint(getSocketPath()));
      probe.on('connect', () => { probe.destroy(); resolve('connected'); });
      probe.on('error', reject);
    })).rejects.toThrow();
  }, 20_000);

  it('is idempotent — a second stop awaits the same close instead of skipping it', async () => {
    const { BrowserIPCServer } = await import('./ipc.js');
    const { BrowserService } = await import('./service.js');
    const server = new BrowserIPCServer(new BrowserService());
    await server.start();
    // A second SIGTERM must not race past the release because `this.server` was
    // already nulled by the first.
    await Promise.all([server.stop(), server.stop()]);
    await expect(new Promise((resolve, reject) => {
      const probe = net.createConnection(ipcEndpoint(getSocketPath()));
      probe.on('connect', () => { probe.destroy(); resolve('connected'); });
      probe.on('error', reject);
    })).rejects.toThrow();
  }, 20_000);
});

// #556: the daemon binds its browser IPC socket, then a crash / immediate
// self-teardown leaves the socket *file* on disk with nothing listening. The
// old reachability check was `fs.existsSync(socketPath)`, which treats that
// stale file as a live daemon — the client then connects and gets ECONNREFUSED.
// isDaemonReachable must be an actual connection probe: reachable only when a
// process is really accepting on the socket.
describe('isDaemonReachable (connection probe, not file existence)', () => {
  it('is false when no socket exists at all', async () => {
    expect(await isDaemonReachable()).toBe(false);
  });

  it('is false for a stale socket file that nothing is listening on', async () => {
    const socketPath = getSocketPath();
    mkdirSync(path.dirname(socketPath), { recursive: true });
    // A plain file at the socket path: exists on disk, but no listener.
    // fs.existsSync would report this as "reachable" — the bug we are fixing.
    writeFileSync(socketPath, '');
    expect(await isDaemonReachable()).toBe(false);
  });

  it('is true only when a process is actually accepting on the socket', async () => {
    const socketPath = getSocketPath();
    mkdirSync(path.dirname(socketPath), { recursive: true });
    const server = net.createServer();
    // Listen on the same endpoint the probe connects to (a named pipe on
    // Windows, the socket file path on POSIX).
    await new Promise<void>((resolve) => server.listen(ipcEndpoint(socketPath), () => resolve()));
    try {
      expect(await isDaemonReachable()).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // After the listener goes away, reachability flips back to false.
    expect(await isDaemonReachable()).toBe(false);
  });
});

describe('shouldRestartStaleDaemon', () => {
  it('restarts when the daemon reports a different concrete version', () => {
    expect(shouldRestartStaleDaemon('1.2.0', '1.3.0')).toBe(true);
    expect(shouldRestartStaleDaemon('0.0.0-dev.abc', '0.0.0-dev.def')).toBe(true);
  });

  it('does not restart when versions match', () => {
    expect(shouldRestartStaleDaemon('1.3.0', '1.3.0')).toBe(false);
  });

  it('does not restart on an ambiguous daemon version', () => {
    expect(shouldRestartStaleDaemon(undefined, '1.3.0')).toBe(false);
    expect(shouldRestartStaleDaemon('', '1.3.0')).toBe(false);
    expect(shouldRestartStaleDaemon('unknown', '1.3.0')).toBe(false);
  });
});
