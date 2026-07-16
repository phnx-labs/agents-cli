import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// isOwnTunnel's win32 branch delegates to getPortOccupant; mock it so the test
// exercises the branch logic without shelling out to netstat/tasklist.
vi.mock('../chrome.js', () => ({ getPortOccupant: vi.fn() }));

// Stub `child_process.spawn` so the ssh-transport tests (launch-failure
// propagation, kill-on-cleanup) drive fake ssh processes instead of shelling
// out to a real `ssh`. `execFileSync` (used by isOwnTunnel) is preserved.
const cp = vi.hoisted(() => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  const calls: { cmd: string; args: string[]; child: any }[] = [];
  const spawn = (cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    calls.push({ cmd, args, child });
    return child;
  };
  return { calls, spawn };
});
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, spawn: cp.spawn };
});

import {
  buildLaunchCmd,
  buildKillCmd,
  buildWindowsLaunchScript,
  buildWindowsKillScript,
  encodePowerShell,
  isOwnTunnel,
  ensureRemoteBrowser,
  killRemoteBrowser,
} from './ssh.js';
import { getPortOccupant } from '../chrome.js';

const mockedOccupant = vi.mocked(getPortOccupant);

const here = dirname(fileURLToPath(import.meta.url));
const sshSrc = readFileSync(join(here, 'ssh.ts'), 'utf8');

/** Decode a `powershell -NoProfile -EncodedCommand <b64>` back to its script. */
function decodeEncoded(cmd: string): string {
  const m = cmd.match(/^powershell -NoProfile -EncodedCommand (\S+)$/);
  if (!m) throw new Error(`not an EncodedCommand invocation: ${cmd}`);
  return Buffer.from(m[1], 'base64').toString('utf16le');
}

describe('ssh driver CDP launch args', () => {
  it('never sets --remote-allow-origins=* (DNS-rebind / cross-origin CDP risk)', () => {
    expect(sshSrc).not.toMatch(/--remote-allow-origins=\*/);
  });

  it('scopes --remote-allow-origins to a 127.0.0.1 URL with the forwarded port', () => {
    expect(sshSrc).toMatch(/--remote-allow-origins=http:\/\/127\.0\.0\.1:\$\{port\}/);
  });
});

describe('buildWindowsLaunchScript', () => {
  it('spawns via an interactive scheduled task so the browser survives the ssh session AND serves CDP', () => {
    const s = buildWindowsLaunchScript('edge', 9222);
    expect(s).toContain('Register-ScheduledTask');
    expect(s).toContain('Start-ScheduledTask');
    // one-shot: nothing lingers in the scheduler after launch
    expect(s).toContain('Unregister-ScheduledTask');
    // start /B and Start-Process children are reaped on ssh disconnect; WMI
    // Win32_Process.Create survives disconnect but lands in session 0, where
    // Edge binds the CDP port yet the DevTools server never initializes
    // (/json/version hangs forever, DevToolsActivePort never written).
    expect(s).not.toContain('start /B');
    expect(s).not.toContain('Start-Process ');
    expect(s).not.toContain('Invoke-CimMethod');
  });

  it('resolves the real .exe from App Paths for a known browser', () => {
    expect(buildWindowsLaunchScript('edge', 9222)).toContain('App Paths\\msedge.exe');
    expect(buildWindowsLaunchScript('chrome', 9222)).toContain('App Paths\\chrome.exe');
  });

  it('falls back to HKCU App Paths for per-user installs (Edge/Chrome default)', () => {
    const s = buildWindowsLaunchScript('edge', 9222);
    // Per-user installs live under HKCU, not HKLM — an HKLM-only lookup missed
    // the default Edge/Chrome install and the launch failed. Both hives probed.
    expect(s).toContain("HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe");
    expect(s).toContain("HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe");
    // HKLM must be tried first, HKCU only as the fallback.
    expect(s.indexOf('HKLM:')).toBeLessThan(s.indexOf('HKCU:'));
    // PowerShell 5.1 has no `??`; the fallback is an explicit `if`.
    expect(s).not.toContain('??');
    // A missing exe throws so it rides out as a non-zero ssh exit.
    expect(s).toContain('throw');
  });

  it('uses a custom binary path verbatim (no App Paths lookup)', () => {
    const s = buildWindowsLaunchScript('custom', 9222, 'C:\\Tools\\msedge.exe');
    expect(s).toContain("$exe = 'C:\\Tools\\msedge.exe'");
    expect(s).not.toContain('App Paths');
  });

  it('sets the CDP port, scoped allow-origins, and a TEMP user-data-dir', () => {
    const s = buildWindowsLaunchScript('edge', 9333);
    expect(s).toContain('--remote-debugging-port=9333');
    expect(s).toContain('--remote-allow-origins=http://127.0.0.1:9333');
    expect(s).toContain('$env:TEMP');
    expect(s).toContain('agents-browser-9333');
  });

  it('rejects browser=custom without a binary', () => {
    expect(() => buildWindowsLaunchScript('custom', 9222)).toThrow(/requires a binary/);
  });
});

describe('encodePowerShell', () => {
  it('round-trips a script through UTF-16LE base64', () => {
    const script = buildWindowsLaunchScript('edge', 9222);
    const cmd = encodePowerShell(script);
    expect(cmd.startsWith('powershell -NoProfile -EncodedCommand ')).toBe(true);
    expect(decodeEncoded(cmd)).toBe(script);
  });

  it('produces a single quote-free token (safe over ssh → cmd.exe)', () => {
    const cmd = encodePowerShell(buildWindowsLaunchScript('edge', 9222));
    const b64 = cmd.replace('powershell -NoProfile -EncodedCommand ', '');
    expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe('buildLaunchCmd (windows)', () => {
  it('returns an EncodedCommand wrapping the scheduled-task launch script', () => {
    const cmd = buildLaunchCmd('windows', 'edge', 9222);
    expect(decodeEncoded(cmd)).toBe(buildWindowsLaunchScript('edge', 9222));
  });
});

describe('buildLaunchCmd (posix)', () => {
  it('backgrounds the .app binary with & and a /tmp user-data-dir', () => {
    const cmd = buildLaunchCmd('posix', 'edge', 9222);
    expect(cmd).toContain('Microsoft Edge.app');
    expect(cmd).toContain('--remote-debugging-port=9222');
    expect(cmd).toContain('--user-data-dir=/tmp/agents-browser-9222');
    expect(cmd.trimEnd()).toMatch(/&$/);
    expect(cmd).not.toContain('powershell');
  });

  it('uses a custom binary path verbatim', () => {
    const cmd = buildLaunchCmd('posix', 'custom', 9222, '/opt/edge/edge');
    expect(cmd).toContain('/opt/edge/edge');
  });
});

describe('isOwnTunnel (win32)', () => {
  const realPlatform = process.platform;

  function setPlatform(p: string) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  afterEach(() => {
    setPlatform(realPlatform);
    mockedOccupant.mockReset();
  });

  it('treats an ssh.exe holding our local port as our tunnel (ps is absent on Windows)', () => {
    setPlatform('win32');
    mockedOccupant.mockReturnValue({ pid: 4242, command: 'ssh.exe' });

    expect(isOwnTunnel(4242, 'win-mini', 9222)).toBe(true);
    // Verified via the netstat/tasklist occupant path against the local port
    // (localPort === remotePort), not by shelling out to POSIX `ps`.
    expect(mockedOccupant).toHaveBeenCalledWith(9222);
  });

  it('rejects a non-ssh occupant on our port', () => {
    setPlatform('win32');
    mockedOccupant.mockReturnValue({ pid: 4242, command: 'msedge.exe' });

    expect(isOwnTunnel(4242, 'win-mini', 9222)).toBe(false);
  });

  it('rejects when the occupant pid does not match the one we found', () => {
    setPlatform('win32');
    mockedOccupant.mockReturnValue({ pid: 9999, command: 'ssh.exe' });

    expect(isOwnTunnel(4242, 'win-mini', 9222)).toBe(false);
  });

  it('rejects when nothing occupies the port', () => {
    setPlatform('win32');
    mockedOccupant.mockReturnValue(null);

    expect(isOwnTunnel(4242, 'win-mini', 9222)).toBe(false);
  });
});

describe('buildKillCmd', () => {
  it('windows tears down via encoded Get-NetTCPConnection → taskkill tree-kill', () => {
    const cmd = buildKillCmd('windows', 9222);
    const script = decodeEncoded(cmd);
    expect(script).toBe(buildWindowsKillScript(9222));
    expect(script).toContain('Get-NetTCPConnection -LocalPort 9222');
    // Tree-kill: Stop-Process on the main pid orphans Chromium children that
    // hold the profile lock and wedge every subsequent launch.
    expect(script).toContain('taskkill /PID $_.OwningProcess /T /F');
    expect(script).not.toContain('Stop-Process');
    expect(script).not.toContain('lsof');
  });

  it('posix tears down via lsof + kill on the port', () => {
    const cmd = buildKillCmd('posix', 9222);
    expect(cmd).toContain('lsof -ti');
    expect(cmd).toContain(':9222');
    expect(cmd).not.toContain('Stop-Process');
  });
});

describe('ensureRemoteBrowser launch-failure propagation (#558)', () => {
  afterEach(() => {
    cp.calls.length = 0;
  });

  it('rejects with the captured stderr on a non-zero ssh exit', async () => {
    const p = ensureRemoteBrowser('me', 'win-mini', 'edge', 9222, 'windows');
    const child = cp.calls.at(-1)!.child;
    child.stderr.emit('data', Buffer.from('msedge.exe not found in HKLM/HKCU App Paths'));
    child.emit('close', 1);
    await expect(p).rejects.toThrow(/ssh exit 1/);
    await expect(p).rejects.toThrow(/not found in HKLM\/HKCU/);
  });

  it('resolves on a clean (exit 0) launch — an already-running browser is fine', async () => {
    const p = ensureRemoteBrowser('me', 'win-mini', 'edge', 9222, 'windows');
    cp.calls.at(-1)!.child.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
  });

  it('captures ssh auth failure (exit 255) rather than swallowing it', async () => {
    const p = ensureRemoteBrowser('me', 'win-mini', 'edge', 9222, 'windows');
    const child = cp.calls.at(-1)!.child;
    child.stderr.emit('data', Buffer.from('Permission denied (publickey).'));
    child.emit('close', 255);
    await expect(p).rejects.toThrow(/ssh exit 255.*Permission denied/s);
  });
});

describe('killRemoteBrowser on stop/cleanup (#559)', () => {
  afterEach(() => {
    cp.calls.length = 0;
  });

  it('invokes the encoded Windows kill script over ssh', async () => {
    const p = killRemoteBrowser('me', 'win-mini', 'windows', 9222);
    const rec = cp.calls.at(-1)!;
    expect(rec.cmd).toBe('ssh');
    expect(rec.args).toContain('me@win-mini');
    // The remote command is the exact encoded Get-NetTCPConnection -> taskkill /T
    // tree-kill script, so `browser stop` reaps the task-launched browser and its
    // children (not just the tunnel).
    expect(rec.args).toContain(buildKillCmd('windows', 9222));
    rec.child.emit('close', 0);
    await p;
  });

  it('tears down the posix remote via lsof + kill', async () => {
    const p = killRemoteBrowser('me', 'host', 'posix', 9222);
    const rec = cp.calls.at(-1)!;
    expect(rec.args).toContain(buildKillCmd('posix', 9222));
    rec.child.emit('close', 0);
    await p;
  });
});

describe('raw-ssh spawns reuse SSH_OPTS so unreachable hosts fail fast (#746)', () => {
  afterEach(() => {
    cp.calls.length = 0;
  });

  // The two raw-ssh call sites (ensureRemoteBrowser, runSSHCommand-via-
  // killRemoteBrowser) previously passed only `-o BatchMode=yes` — no
  // ConnectTimeout — so a dropped SYN to an unreachable host hung on the OS
  // default (~127s). They now compose the shared hardened baseline.
  const hardened = (args: string[]) => {
    const target = args.find((a) => a.includes('@'))!;
    const targetIdx = args.indexOf(target);
    // ConnectTimeout is present and bounds the connect.
    expect(args).toContain('ConnectTimeout=10');
    expect(args).toContain('BatchMode=yes');
    // Every hardened option (an `-o` and its value) precedes the target — on
    // BSD getopt (macOS) an option after the target is swallowed into the
    // remote command instead of applied.
    const optValueIdx = args.indexOf('ConnectTimeout=10');
    const batchIdx = args.indexOf('BatchMode=yes');
    expect(optValueIdx).toBeLessThan(targetIdx);
    expect(batchIdx).toBeLessThan(targetIdx);
    // The remote command is the LAST arg (after the target).
    expect(targetIdx).toBe(args.length - 2);
  };

  it('ensureRemoteBrowser composes SSH_OPTS before the target', async () => {
    const p = ensureRemoteBrowser('me', '203.0.113.1', 'chrome', 9222, 'posix');
    const rec = cp.calls.at(-1)!;
    hardened(rec.args);
    rec.child.emit('close', 0); // settle so the 2s launch-window timer is cleared
    await p;
  });

  it('killRemoteBrowser (runSSHCommand) composes SSH_OPTS before the target', async () => {
    const p = killRemoteBrowser('me', '203.0.113.1', 'posix', 9222);
    const rec = cp.calls.at(-1)!;
    hardened(rec.args);
    rec.child.emit('close'); // settle so the 3s kill timer is cleared
    await p;
  });

  // C5: user/host come from a git-tracked ssh:// browser profile. A crafted
  // endpoint like `ssh://-Fattacker@victim` puts `-Fattacker` at the ssh target
  // position, where OpenSSH reads it as `-F <file>` and an attacker-supplied ssh
  // config's ProxyCommand runs locally. The target must be validated before spawn.
  it('ensureRemoteBrowser rejects an option-injecting target before spawning', async () => {
    await expect(
      ensureRemoteBrowser('-Fattacker', 'victim', 'chrome', 9222, 'posix'),
    ).rejects.toThrow(/Invalid SSH target/);
    expect(cp.calls.length).toBe(0); // guard runs before the raw ssh spawn
  });

  it('killRemoteBrowser (runSSHCommand) rejects an option-injecting target before spawning', async () => {
    await expect(
      killRemoteBrowser('-Fattacker', 'victim', 'posix', 9222),
    ).rejects.toThrow(/Invalid SSH target/);
    expect(cp.calls.length).toBe(0);
  });
});
