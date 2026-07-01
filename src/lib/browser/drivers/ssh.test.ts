import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// isOwnTunnel's win32 branch delegates to getPortOccupant; mock it so the test
// exercises the branch logic without shelling out to netstat/tasklist.
vi.mock('../chrome.js', () => ({ getPortOccupant: vi.fn() }));

import {
  buildLaunchCmd,
  buildKillCmd,
  buildWindowsLaunchScript,
  buildWindowsKillScript,
  encodePowerShell,
  isOwnTunnel,
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
  it('spawns via WMI so the browser survives the ssh session (no start /B)', () => {
    const s = buildWindowsLaunchScript('edge', 9222);
    expect(s).toContain('Win32_Process');
    expect(s).toContain('Invoke-CimMethod');
    expect(s).not.toContain('start /B');
    expect(s).not.toContain('Start-Process');
  });

  it('resolves the real .exe from App Paths for a known browser', () => {
    expect(buildWindowsLaunchScript('edge', 9222)).toContain('App Paths\\msedge.exe');
    expect(buildWindowsLaunchScript('chrome', 9222)).toContain('App Paths\\chrome.exe');
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
  it('returns an EncodedCommand wrapping the WMI launch script', () => {
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
  it('windows tears down via encoded Get-NetTCPConnection → Stop-Process', () => {
    const cmd = buildKillCmd('windows', 9222);
    const script = decodeEncoded(cmd);
    expect(script).toBe(buildWindowsKillScript(9222));
    expect(script).toContain('Get-NetTCPConnection -LocalPort 9222');
    expect(script).toContain('Stop-Process');
    expect(script).not.toContain('lsof');
  });

  it('posix tears down via lsof + kill on the port', () => {
    const cmd = buildKillCmd('posix', 9222);
    expect(cmd).toContain('lsof -ti');
    expect(cmd).toContain(':9222');
    expect(cmd).not.toContain('Stop-Process');
  });
});
