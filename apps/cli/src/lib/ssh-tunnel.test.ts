import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildTunnelArgs,
  startSSHTunnel,
  buildScpArgs,
  buildPushScript,
  buildVerifyPushScript,
  buildRegisterTaskScript,
  buildWriteTokenScript,
  WIN_HELPER_TOKEN_FILE,
  helperTokenPath,
  readHelperToken,
  writeHelperToken,
  clearHelperToken,
  buildUnregisterTaskScript,
  downloadWinHelperExe,
  parseSha256Asset,
  pickFreePort,
  readRemoteState,
  writeRemoteState,
  clearRemoteState,
  sha256File,
  winHelperAssetUrls,
  winHelperCacheDir,
  REMOTE_HELPER_PORT,
  REMOTE_TASK_NAME,
  WIN_HELPER_EXE,
  scpRemotePath,
} from './ssh-tunnel.js';
import { SSH_OPTS } from './ssh-exec.js';
import { encodePowerShell } from './browser/drivers/ssh.js';

describe('startSSHTunnel — target validation (C5)', () => {
  // buildTunnelArgs places `${user}@${host}` before `-N`/SSH_OPTS, so a
  // `-`-leading user (from a crafted ssh:// profile or device record) would be
  // parsed by ssh as an option flag. startSSHTunnel must reject before spawning.
  it('rejects an option-injecting user before spawning ssh', async () => {
    await expect(startSSHTunnel('-Fattacker', 'victim', 55000, 8765)).rejects.toThrow(/Invalid SSH target/);
  });

  it('rejects a host containing shell/option metacharacters', async () => {
    await expect(startSSHTunnel('me', 'a b;rm', 55000, 8765)).rejects.toThrow(/Invalid SSH target/);
  });
});

describe('buildTunnelArgs', () => {
  it('forwards localPort to the remote loopback port and stays hardened', () => {
    const args = buildTunnelArgs('muqsit', 'win-mini', 55000, 8765);
    // The -L mapping is the whole point: local -> 127.0.0.1:remote on the box.
    expect(args).toContain('-L');
    expect(args).toContain('55000:127.0.0.1:8765');
    expect(args).toContain('muqsit@win-mini');
    expect(args).toContain('-N'); // no remote command, just forwarding
    expect(args.join(' ')).toContain('StrictHostKeyChecking=accept-new');
    expect(args.join(' ')).toContain('BatchMode=yes');
    expect(args.join(' ')).toContain('ConnectTimeout=10');
  });

  it('is the -L mapping + target + -N followed by the shared hardened baseline', () => {
    // The tunnel now composes the canonical SSH_OPTS instead of re-listing the
    // options, so it automatically inherits the keepalive (which lets a dropped
    // -N tunnel exit instead of zombying) and any future baseline hardening.
    expect(buildTunnelArgs('u', 'h', 9222, 9222)).toEqual([
      '-L',
      '9222:127.0.0.1:9222',
      'u@h',
      '-N',
      ...SSH_OPTS,
    ]);
  });

  it('inherits the keepalive from the shared baseline', () => {
    const args = buildTunnelArgs('u', 'h', 9222, 9222);
    expect(args.join(' ')).toContain('ServerAliveInterval=15');
    expect(args.join(' ')).toContain('ServerAliveCountMax=3');
  });
});

describe('buildPushScript', () => {
  it('resolves %LOCALAPPDATA%\\agents and does not decode base64 from stdin', () => {
    const s = buildPushScript();
    expect(s).toContain('$env:LOCALAPPDATA');
    expect(s).toContain(WIN_HELPER_EXE);
    expect(s).toContain('Write-Output $dst');
    expect(s).not.toContain('FromBase64Transform');
    expect(s).not.toContain('CryptoStream');
    expect(s).not.toContain('OpenStandardInput');
    expect(s).not.toContain('FromBase64String');
  });

  it('stops a running instance first so the exe file is not locked', () => {
    expect(buildPushScript()).toContain("Stop-Process");
  });

  it('builds scp args for a binary transfer with BatchMode enabled', () => {
    const args = buildScpArgs('muqsit@win-mini', String.raw`C:\Users\muqsit\AppData\Local\agents\computer-helper-win.exe`, '/tmp/helper.exe');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('/tmp/helper.exe');
    expect(args[args.length - 1]).toBe('muqsit@win-mini:C:/Users/muqsit/AppData/Local/agents/computer-helper-win.exe');
    expect(args.join(' ')).not.toContain('powershell');
    expect(args.join(' ')).not.toContain('base64');
  });

  it('normalizes Windows paths for scp without changing the remote destination', () => {
    expect(scpRemotePath(String.raw`C:\Users\muqsit\AppData\Local\agents\computer-helper-win.exe`))
      .toBe('C:/Users/muqsit/AppData/Local/agents/computer-helper-win.exe');
  });

  it('verifies the copied helper byte count with LiteralPath', () => {
    const s = buildVerifyPushScript(String.raw`C:\Users\muqsit\AppData\Local\agents\computer-helper-win.exe`, 165);
    expect(s).toContain('Get-Item -LiteralPath $dst -ErrorAction Stop');
    expect(s).toContain('$item.Length -ne 165');
    expect(s).toContain('helper copy length mismatch');
  });
});

describe('buildRegisterTaskScript', () => {
  const TOKEN_PATH = 'C:\\Users\\me\\AppData\\Local\\agents\\helper-token';

  it('registers an interactive LOGON task running the exe with --port and --token-file', () => {
    const s = buildRegisterTaskScript(REMOTE_HELPER_PORT, REMOTE_TASK_NAME, TOKEN_PATH);
    expect(s).toContain('-AtLogOn'); // survives ssh disconnect
    expect(s).toContain('-LogonType Interactive'); // real desktop session for UIA/screenshot
    expect(s).toContain('-RunLevel Highest');
    expect(s).toContain(`--port ${REMOTE_HELPER_PORT}`);
    expect(s).toContain(REMOTE_TASK_NAME);
    expect(s).toContain('Register-ScheduledTask');
    expect(s).toContain('Start-ScheduledTask'); // start now, no logout/in
    expect(s).toContain(WIN_HELPER_EXE);
    // C2: the daemon requires a token, so the task must point at the token file
    // (quoted so a path with spaces stays one argv entry).
    expect(s).toContain(`--token-file "${TOKEN_PATH}"`);
  });
});

describe('buildWriteTokenScript', () => {
  it('writes the token owner-only and echoes the path', () => {
    const s = buildWriteTokenScript('deadbeefcafe');
    expect(s).toContain(WIN_HELPER_TOKEN_FILE);
    expect(s).toContain('Set-Content');
    expect(s).toContain("'deadbeefcafe'"); // ps-single-quoted token value
    expect(s).toContain('icacls'); // owner-only ACL, inheritance removed
    expect(s).toContain('/inheritance:r');
    expect(s).toContain('Write-Output $tok'); // returns the resolved path
  });
});

describe('helper token persistence (C2)', () => {
  // Uses the real cache dir with a test-only device name (repo convention:
  // real services, no mocking), cleaned up after each case.
  const DEV = '__test-tok-device__';
  afterEach(() => clearHelperToken(DEV));

  it('round-trips a token for a device and clears it', () => {
    expect(readHelperToken(DEV)).toBeNull();
    writeHelperToken(DEV, 'sekret-token');
    expect(readHelperToken(DEV)).toBe('sekret-token');
    // written owner-only
    const mode = fs.statSync(helperTokenPath(DEV)).mode & 0o777;
    expect(mode).toBe(0o600);
    clearHelperToken(DEV);
    expect(readHelperToken(DEV)).toBeNull();
  });

  it('reads null for a missing/empty token', () => {
    expect(readHelperToken(DEV)).toBeNull();
    writeHelperToken(DEV, '   ');
    expect(readHelperToken(DEV)).toBeNull(); // whitespace-only trims to empty
  });
});

describe('buildUnregisterTaskScript', () => {
  it('unregisters the task and stops the daemon process', () => {
    const s = buildUnregisterTaskScript(REMOTE_TASK_NAME);
    expect(s).toContain('Unregister-ScheduledTask');
    expect(s).toContain(REMOTE_TASK_NAME);
    expect(s).toContain('Stop-Process');
  });
});

describe('pickFreePort', () => {
  it('reserves a real, positive, unprivileged local port', async () => {
    const p = await pickFreePort();
    expect(Number.isInteger(p)).toBe(true);
    expect(p).toBeGreaterThan(1024);
  });
});

describe('win helper release-asset download', () => {
  it('builds asset URLs pinned to the exact v<version> tag', () => {
    const u = winHelperAssetUrls('1.20.50');
    expect(u.exe).toBe(
      'https://github.com/phnx-labs/agents-cli/releases/download/v1.20.50/computer-helper-win.exe',
    );
    expect(u.sha256).toBe(`${u.exe}.sha256`);
  });

  it('parses sha256sum-format and bare-hex checksum assets, rejects garbage', () => {
    const hex = 'a'.repeat(64);
    expect(parseSha256Asset(`${hex}  ${WIN_HELPER_EXE}\r\n`)).toBe(hex);
    expect(parseSha256Asset(hex.toUpperCase())).toBe(hex);
    expect(() => parseSha256Asset('not a checksum')).toThrow(/malformed/);
    expect(() => parseSha256Asset(hex.slice(0, 63))).toThrow(/malformed/);
  });

  it('hashes file contents with streaming sha256', async () => {
    const f = path.join(os.tmpdir(), `ssh-tunnel-sha-test-${process.pid}.bin`);
    fs.writeFileSync(f, 'hello');
    try {
      // Well-known vector: sha256("hello").
      expect(await sha256File(f)).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  it('returns the cached exe without touching the network', async () => {
    const version = '0.0.0-ssh-tunnel-cache-test';
    const dir = winHelperCacheDir(version);
    const cached = path.join(dir, WIN_HELPER_EXE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cached, 'cached-exe-bytes');
    try {
      expect(await downloadWinHelperExe(version)).toBe(cached);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails naming the exact tag checked when the release asset does not exist', async () => {
    // Real GitHub 404 — no fallback to any other tag is attempted.
    await expect(downloadWinHelperExe('0.0.0-ssh-tunnel-no-such-tag')).rejects.toThrow(
      /v0\.0\.0-ssh-tunnel-no-such-tag/,
    );
  }, 30_000);
});

describe('remote tunnel state round-trip', () => {
  const device = '__ssh_tunnel_test_device__';
  afterEach(() => clearRemoteState(device));

  it('persists and reloads a tunnel record, then clears it', () => {
    expect(readRemoteState(device)).toBeNull();
    writeRemoteState({
      device,
      target: 'muqsit@win-mini',
      localPort: 55001,
      remotePort: REMOTE_HELPER_PORT,
      tunnelPid: 4242,
      token: null,
      taskName: REMOTE_TASK_NAME,
      startedAt: 1_700_000_000_000,
    });
    const got = readRemoteState(device);
    expect(got?.localPort).toBe(55001);
    expect(got?.target).toBe('muqsit@win-mini');
    clearRemoteState(device);
    expect(readRemoteState(device)).toBeNull();
  });
});
