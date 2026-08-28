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
import * as os from 'os';
import * as path from 'path';

// macOS sun_path is 104 chars; os.tmpdir() under /var/folders pushes the
// socket path over that and listen() returns EINVAL. /tmp resolves short
// on both Linux (/tmp) and macOS (/private/tmp) so the socket fits.
// Plain top-level statements run before the dynamic `await import` below,
// so vi.hoisted is not needed (and is also not supported by Bun's native
// test runner).
const tmpBase = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
const TEST_HOME = fs.mkdtempSync(path.join(tmpBase, 'agents-pty-test-'));
process.env.HOME = TEST_HOME;

const { runPtyServer, captureProcessStartTime, getSocketPath, derivePtyEndpoint, buildSentinelCommand, describeNativePtyLoadFailure } = await import('../pty-server.js');

// The multiarch fork BAKES Linux prebuilds (glibc + musl, all Node ABIs incl.
// 22/24) into its npm tarball, so the native binary is present on Linux even
// under CI's `bun install --ignore-scripts` — these server-boot tests run on
// Linux runners (unlike mainline node-pty, which only ships darwin/win32 and
// must compile on Linux). macOS/Windows fetch their prebuild via the trusted
// postinstall. If the module still isn't loadable, skip rather than fail.
let nodePtyLoadable = true;
try {
  await import('@homebridge/node-pty-prebuilt-multiarch');
} catch {
  nodePtyLoadable = false;
}

afterEach(async () => {
  // Belt-and-braces cleanup so a hanging server from one test doesn't
  // bleed into the next.
  const sock = path.join(TEST_HOME, '.agents', '.cache', 'helpers', 'pty', 'pty.sock');
  await fsp.rm(sock, { force: true });
});

// Windows uses a named pipe, not a filesystem socket inode — getSocketPath()
// returns a \\.\pipe\ path that can't be stat()ed or chmod()ed. These boot
// tests assert unix-socket file semantics, so they are POSIX-only.
describe.skipIf(!nodePtyLoadable || process.platform === 'win32')('PTY socket permission', () => {
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

// POSIX-only for the same reason: it pre-stages a regular file at the socket
// path and asserts it survives — a \\.\pipe\ path on Windows can't be written.
describe.skipIf(!nodePtyLoadable || process.platform === 'win32')('PTY duplicate-spawn race resolution', () => {
  it('exits cleanly without touching the socket when a live PID file already exists', async () => {
    // Pre-stage a PID file pointing to a live process (this test runner). The
    // server boot must detect this via isPtyServerRunning() and exit cleanly
    // — if it didn't, line ~223's unlinkSync would clobber the winner's socket
    // inode, orphaning the prior server. We pin a sentinel byte sequence in
    // the socket path and assert it survives.
    const pidDir = path.join(TEST_HOME, '.agents', '.cache', 'helpers', 'pty');
    await fsp.mkdir(pidDir, { recursive: true });
    const pidPath = path.join(pidDir, 'pty.pid');
    await fsp.writeFile(pidPath, String(process.pid), 'utf-8');

    const socketPath = getSocketPath();
    const sentinel = 'sentinel-from-winner';
    await fsp.writeFile(socketPath, sentinel, 'utf-8');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__test_exit_${code ?? 0}`);
    }) as never);

    let caught: Error | null = null;
    try {
      await runPtyServer();
    } catch (err: any) {
      caught = err;
    }

    expect(caught, 'runPtyServer should have exited via process.exit(0)').not.toBeNull();
    expect(caught!.message).toBe('__test_exit_0');

    // Sentinel survived — the duplicate did not clobber the winner's socket.
    expect(await fsp.readFile(socketPath, 'utf-8')).toBe(sentinel);
    // PID file untouched — the winner's PID is still there.
    expect(await fsp.readFile(pidPath, 'utf-8')).toBe(String(process.pid));

    exitSpy.mockRestore();
    await fsp.rm(pidPath, { force: true });
    await fsp.rm(socketPath, { force: true });
  }, 15_000);
});

describe('derivePtyEndpoint (cross-platform transport)', () => {
  const ptyDir = '/home/u/.agents/.cache/helpers/pty';

  it('returns a pty.sock file path on unix platforms', () => {
    expect(derivePtyEndpoint('linux', ptyDir)).toBe(path.join(ptyDir, 'pty.sock'));
    expect(derivePtyEndpoint('darwin', ptyDir)).toBe(path.join(ptyDir, 'pty.sock'));
  });

  it('returns a \\\\.\\pipe\\ named pipe on win32 — never a filesystem path', () => {
    const winDir = 'C:\\Users\\u\\.agents\\.cache\\helpers\\pty';
    const endpoint = derivePtyEndpoint('win32', winDir);
    // Named pipes must use the \\.\pipe\ prefix or net.createServer rejects them.
    expect(endpoint).toMatch(/^\\\\\.\\pipe\\agents-pty-[0-9a-f]{16}$/);
    // It must NOT be a real path under the scratch dir — fs.existsSync would
    // always report false for a pipe, breaking the readiness probe if it were.
    expect(endpoint.startsWith(winDir)).toBe(false);
  });

  it('is stable for a given dir and unique per dir (per-user pipe isolation)', () => {
    const a1 = derivePtyEndpoint('win32', 'C:\\Users\\alice\\pty');
    const a2 = derivePtyEndpoint('win32', 'C:\\Users\\alice\\pty');
    const b = derivePtyEndpoint('win32', 'C:\\Users\\bob\\pty');
    expect(a1).toBe(a2);        // same dir -> same pipe (client/server agree)
    expect(a1).not.toBe(b);     // different user -> different pipe
  });
});

describe('buildSentinelCommand (shell-aware exec wrapper)', () => {
  it('uses POSIX `;` + `$?` for sh/zsh/bash', () => {
    expect(buildSentinelCommand('/bin/zsh', 'ls')).toBe('ls; echo "__AGENTS_PTY_DONE__:$?"');
    expect(buildSentinelCommand('/bin/bash', 'ls')).toBe('ls; echo "__AGENTS_PTY_DONE__:$?"');
  });

  it('uses cmd.exe `&` + %errorlevel% so the marker always prints', () => {
    // `&&` would skip the echo on failure; `&` must be used so completion is
    // always detected regardless of the command's exit status.
    expect(buildSentinelCommand('C:\\Windows\\System32\\cmd.exe', 'dir'))
      .toBe('dir & echo __AGENTS_PTY_DONE__:%errorlevel%');
  });

  it('uses PowerShell `;` + $LASTEXITCODE', () => {
    expect(buildSentinelCommand('powershell.exe', 'Get-ChildItem'))
      .toBe('Get-ChildItem; echo "__AGENTS_PTY_DONE__:$LASTEXITCODE"');
    expect(buildSentinelCommand('pwsh', 'Get-ChildItem'))
      .toBe('Get-ChildItem; echo "__AGENTS_PTY_DONE__:$LASTEXITCODE"');
  });
});

// Regression guard for PHNX-2740: the native binding must actually LOAD and
// spawn on the platform running the suite. The Linux prebuilds are baked into
// the npm tarball for every Node ABI, so on a Linux runner this is a hard
// requirement — a bump that drops the ABI the runner uses (or a broken install)
// fails here instead of silently skipping. It also exercises the real critical
// path (spawn -> onData -> onExit), no mocks. On macOS/Windows the prebuild is
// fetched at install and CI does not run those, so we only assert-or-skip there.
describe('native pty binding loads and spawns on this platform', () => {
  it.skipIf(process.platform !== 'linux')('LINUX: loads the binding and round-trips a real shell', async () => {
    const mod: any = await import('@homebridge/node-pty-prebuilt-multiarch');
    const nodePty = mod.default?.spawn ? mod.default : mod;
    expect(typeof nodePty.spawn).toBe('function');

    const output = await new Promise<string>((resolve, reject) => {
      const proc = nodePty.spawn(process.env.SHELL || 'bash', ['-c', 'echo PTY_LOADS_OK'], {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: TEST_HOME, env: process.env,
      });
      let buf = '';
      proc.onData((d: string) => { buf += d; });
      proc.onExit(() => resolve(buf));
      setTimeout(() => reject(new Error('pty spawn did not exit in time')), 5000);
    });
    expect(output).toContain('PTY_LOADS_OK');
  }, 10_000);

  it.skipIf(process.platform === 'linux')('non-Linux: binding must load if present (fetched at install)', async () => {
    if (!nodePtyLoadable) return; // prebuild not fetched in this env — nothing to assert
    const mod: any = await import('@homebridge/node-pty-prebuilt-multiarch');
    const nodePty = mod.default?.spawn ? mod.default : mod;
    expect(typeof nodePty.spawn).toBe('function');
  });
});

describe('describeNativePtyLoadFailure (actionable, not a raw MODULE_NOT_FOUND)', () => {
  it('names the platform, Node ABI, a remediation, and the underlying error', () => {
    const err = Object.assign(new Error("Cannot find module '../build/Debug/pty.node'"), {
      code: 'MODULE_NOT_FOUND',
    });
    const lines = describeNativePtyLoadFailure(err);
    const text = lines.join('\n');

    // Platform + ABI so a user can tell whether their Node is simply too new.
    expect(text).toContain(`${process.platform}-${process.arch}`);
    expect(text).toContain(`ABI ${process.versions.modules}`);
    // A concrete fix, not just "install it".
    expect(text).toContain('npm rebuild @homebridge/node-pty-prebuilt-multiarch');
    // The real error is preserved for debugging, never swallowed.
    expect(text).toContain("Cannot find module '../build/Debug/pty.node'");
    // Never the bare failure with no guidance.
    expect(text).not.toBe('MODULE_NOT_FOUND');
  });

  it('handles a non-Error thrown value without crashing', () => {
    const lines = describeNativePtyLoadFailure('some string failure');
    expect(lines.join('\n')).toContain('some string failure');
  });
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
