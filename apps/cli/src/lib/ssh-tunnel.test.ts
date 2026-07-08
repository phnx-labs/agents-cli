import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTunnelArgs,
  buildScpArgs,
  buildPushScript,
  buildVerifyPushScript,
  buildRegisterTaskScript,
  buildUnregisterTaskScript,
  pickFreePort,
  readRemoteState,
  writeRemoteState,
  clearRemoteState,
  REMOTE_HELPER_PORT,
  REMOTE_TASK_NAME,
  WIN_HELPER_EXE,
  scpRemotePath,
} from './ssh-tunnel.js';
import { SSH_OPTS } from './ssh-exec.js';
import { encodePowerShell } from './browser/drivers/ssh.js';

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
  it('registers an interactive LOGON task running the exe with --port', () => {
    const s = buildRegisterTaskScript(REMOTE_HELPER_PORT, REMOTE_TASK_NAME);
    expect(s).toContain('-AtLogOn'); // survives ssh disconnect
    expect(s).toContain('-LogonType Interactive'); // real desktop session for UIA/screenshot
    expect(s).toContain('-RunLevel Highest');
    expect(s).toContain(`--port ${REMOTE_HELPER_PORT}`);
    expect(s).toContain(REMOTE_TASK_NAME);
    expect(s).toContain('Register-ScheduledTask');
    expect(s).toContain('Start-ScheduledTask'); // start now, no logout/in
    expect(s).toContain(WIN_HELPER_EXE);
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
