/**
 * Shared SSH port-forward tunnel + remote computer-helper provisioning.
 *
 * Two layers live here:
 *
 *  1. `startSSHTunnel` — the generic `ssh -L localPort:127.0.0.1:remotePort -N`
 *     spawn, extracted verbatim from the browser CDP driver so both the browser
 *     and `agents computer --host` reach a remote loopback service through one
 *     hardened tunnel. Behavior for the browser caller is unchanged (default,
 *     foreground, stderr-captured).
 *
 *  2. Remote computer-helper orchestration — resolve a registered device to an
 *     ssh target, push the cross-published Windows daemon exe, register it as a
 *     LOGON scheduled task (interactive session so real-desktop UIA/screenshot
 *     works and it survives the ssh disconnect), and open a tunnel the TS RPC
 *     client drives via TCP. Everything rides the existing `ssh-exec` /
 *     `devices/connect` primitives — no parallel SSH implementation.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { Transform } from 'stream';
import { sshExec, SSH_OPTS } from './ssh-exec.js';
import { encodePowerShell } from './browser/drivers/ssh.js';
import { getDevice, type DeviceProfile } from './devices/registry.js';
import { sshTargetFor } from './devices/connect.js';
import { hostNameFor } from './devices/ssh-config.js';
import { getCacheDir } from './state.js';
import { openComputerClient, resolveTcpEndpoint, type ComputerClient } from './computer-rpc.js';

// ---------------------------------------------------------------------------
// 1. Generic ssh -L tunnel (shared with the browser CDP driver)
// ---------------------------------------------------------------------------

export interface StartTunnelOptions {
  /**
   * Detach the tunnel so it OUTLIVES this CLI process. Used by
   * `agents computer start --host` — the tunnel must persist across separate
   * verb invocations (`apps`, `click`, …) until `stop --host` tears it down.
   * The browser driver leaves this false: it holds the tunnel for the lifetime
   * of one CDP session and kills it on cleanup.
   */
  detached?: boolean;
}

/** Build the ssh argv (after the `ssh` program name) for an `-L` tunnel. Pure. */
export function buildTunnelArgs(
  user: string,
  host: string,
  localPort: number,
  remotePort: number,
): string[] {
  return [
    '-L',
    `${localPort}:127.0.0.1:${remotePort}`,
    `${user}@${host}`,
    '-N',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
  ];
}

/**
 * Spawn `ssh -L localPort:127.0.0.1:remotePort -N user@host`.
 *
 * Foreground (default): stderr is captured so a tunnel that dies inside 500ms
 * rejects with the ssh error — the browser driver's original contract. Detached
 * mode ignores stdio and `unref`s the child so the parent can exit while the
 * tunnel lives; liveness is then confirmed by the caller probing the service.
 */
export function startSSHTunnel(
  user: string,
  host: string,
  localPort: number,
  remotePort: number,
  opts: StartTunnelOptions = {},
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const args = buildTunnelArgs(user, host, localPort, remotePort);

    const tunnel = spawn('ssh', args, {
      stdio: opts.detached ? 'ignore' : ['ignore', 'ignore', 'pipe'],
      detached: Boolean(opts.detached),
    });

    let stderr = '';
    tunnel.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    tunnel.on('error', (err) => {
      reject(new Error(`SSH tunnel failed: ${err.message}`));
    });

    setTimeout(() => {
      if (tunnel.killed) {
        reject(new Error(`SSH tunnel died: ${stderr}`));
      } else {
        // Let the CLI exit without waiting on a persistent tunnel.
        if (opts.detached) tunnel.unref();
        resolve(tunnel);
      }
    }, 500);
  });
}

// ---------------------------------------------------------------------------
// 2. Remote computer-helper orchestration
// ---------------------------------------------------------------------------

/** Loopback TCP port the Windows daemon binds on the remote (Program.cs default). */
export const REMOTE_HELPER_PORT = 8765;

/** Task Scheduler task name for the daemon. Stable so setup/stop pair up. */
export const REMOTE_TASK_NAME = 'AgentsComputerHelper';

/** Basename of the cross-published exe under packages/computer-helper-win/dist. */
export const WIN_HELPER_EXE = 'computer-helper-win.exe';

/**
 * Locate the cross-published Windows daemon exe. Only the local build output is
 * a candidate — `scripts/build-win.sh` writes it to packages/.../dist/.
 */
export function resolveWinHelperExe(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Running from the agents-cli checkout (src/lib -> repo root).
    path.resolve(here, '..', '..', 'packages', 'computer-helper-win', 'dist', WIN_HELPER_EXE),
    // Bundled with the npm package (dist/lib -> package root).
    path.resolve(here, '..', 'computer-helper-win', WIN_HELPER_EXE),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Persisted per-device tunnel state so verbs can reconnect after `start --host`. */
export interface RemoteTunnelState {
  device: string;
  target: string;
  localPort: number;
  remotePort: number;
  tunnelPid: number;
  token: string | null;
  taskName: string;
  startedAt: number;
}

function remoteStateDir(): string {
  return path.join(getCacheDir(), 'computer', 'remote');
}

/** State file path for a device. Device names are ssh-alias safe (validated). */
export function remoteStatePath(device: string): string {
  return path.join(remoteStateDir(), `${device}.json`);
}

export function readRemoteState(device: string): RemoteTunnelState | null {
  try {
    return JSON.parse(fs.readFileSync(remoteStatePath(device), 'utf-8')) as RemoteTunnelState;
  } catch {
    return null;
  }
}

export function writeRemoteState(state: RemoteTunnelState): void {
  const dir = remoteStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(remoteStatePath(state.device), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function clearRemoteState(device: string): void {
  try {
    fs.unlinkSync(remoteStatePath(device));
  } catch {
    /* already gone */
  }
}

/** Resolve a registered device to its ssh pieces, or throw a clear error. */
export async function resolveRemoteDevice(
  name: string,
): Promise<{ device: DeviceProfile; target: string; user: string; host: string }> {
  const device = await getDevice(name);
  if (!device) {
    throw new Error(`Unknown device '${name}'. Register it with \`agents devices add\` / \`agents devices sync\`, then retry.`);
  }
  if (device.platform !== 'windows') {
    throw new Error(`Device '${name}' is ${device.platform}, not windows. \`agents computer --host\` drives the Windows computer-helper daemon.`);
  }
  const target = sshTargetFor(device); // validates address + injection guard
  const host = hostNameFor(device)!; // sshTargetFor already threw if absent
  const user = device.user || process.env.USER || 'Administrator';
  return { device, target, user, host };
}

/**
 * PowerShell that streams base64 from stdin, decodes it incrementally to
 * %LOCALAPPDATA%\agents\computer-helper-win.exe, and stops any running instance
 * first so the file isn't locked. The CryptoStream/FromBase64Transform decode
 * is streaming — the ~156MB exe never lands in memory whole on the remote.
 */
export function buildPushScript(): string {
  return [
    `$dir = Join-Path $env:LOCALAPPDATA 'agents'`,
    `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
    `$dst = Join-Path $dir '${WIN_HELPER_EXE}'`,
    `Get-Process -Name 'computer-helper-win' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`,
    `$si = [Console]::OpenStandardInput()`,
    `$t = New-Object Security.Cryptography.FromBase64Transform`,
    `$cs = New-Object Security.Cryptography.CryptoStream($si, $t, [Security.Cryptography.CryptoStreamMode]::Read)`,
    `$fs = [IO.File]::Create($dst)`,
    `$cs.CopyTo($fs)`,
    `$fs.Close(); $cs.Close()`,
    `Write-Output $dst`,
  ].join('; ');
}

/**
 * PowerShell that registers the daemon as a LOGON scheduled task. Interactive
 * logon type + Highest run level so the daemon runs in the real desktop session
 * (UIAutomation and ScreenCapture need a live session, not Session 0) and
 * survives ssh disconnect — the same rationale as the browser WMI launch. The
 * task is started immediately so the caller need not log out/in.
 */
export function buildRegisterTaskScript(port: number, taskName: string): string {
  return [
    `$exe = Join-Path (Join-Path $env:LOCALAPPDATA 'agents') '${WIN_HELPER_EXE}'`,
    `$action = New-ScheduledTaskAction -Execute $exe -Argument '--port ${port}'`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn`,
    `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    `Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${taskName}'`,
  ].join('; ');
}

/** PowerShell that unregisters the task and stops any running daemon process. */
export function buildUnregisterTaskScript(taskName: string): string {
  return [
    `Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue`,
    `Get-Process -Name 'computer-helper-win' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`,
  ].join('; ');
}

/**
 * `setup --host`: push the exe, then register + start the LOGON task. Both hops
 * go through `sshExec` (BatchMode key auth — the same hardening the browser
 * driver and `agents ssh` use). Throws with the remote stderr on any failure.
 */
/**
 * Base64-encode a byte stream in 3-byte-aligned chunks so the concatenated
 * output is valid (every chunk boundary lands on a base64 quantum).
 */
class Base64Encode extends Transform {
  private leftover = Buffer.alloc(0);
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    const buf = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
    const usable = buf.length - (buf.length % 3);
    this.leftover = Buffer.from(buf.subarray(usable));
    if (usable > 0) this.push(buf.subarray(0, usable).toString('base64'));
    cb();
  }
  override _flush(cb: () => void): void {
    if (this.leftover.length) this.push(this.leftover.toString('base64'));
    cb();
  }
}

/**
 * Stream a local file to a remote command's stdin over ssh, base64-encoded on
 * the fly. Async spawn + piping honors backpressure; the previous
 * `spawnSync({ input })` blob deadlocked once the ssh socket buffer filled
 * (~4MB) on large files (the 157MB Windows helper reproduced this reliably),
 * and worse, reported a false success leaving a 0-byte remote file. Rejects on
 * any pipe error so a broken transfer fails loudly instead.
 */
function streamFileOverSsh(
  target: string,
  remoteCmd: string,
  filePath: string,
  timeoutMs = 600_000,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...SSH_OPTS, target, remoteCmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.stdout.on('data', (d) => (stdout += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ssh push to ${target} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (e: Error) => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(e);
    };
    child.on('error', fail);
    child.stdin.on('error', fail); // EPIPE if the remote decoder dies mid-stream
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr: stderr || stdout });
    });
    const src = fs.createReadStream(filePath);
    src.on('error', fail);
    // disk -> aligned base64 -> ssh stdin; .pipe() applies backpressure
    src.pipe(new Base64Encode()).pipe(child.stdin);
  });
}

export async function setupRemoteHelper(name: string): Promise<{ target: string; taskName: string }> {
  const { target } = await resolveRemoteDevice(name);

  const exe = resolveWinHelperExe();
  if (!exe) {
    throw new Error(`Windows helper exe not built. Run: bash scripts/build-win.sh`);
  }

  // Push: stream the exe from disk, base64-encoded on the fly, to the remote
  // decoder. Streaming (vs a single spawnSync `input` blob) honors ssh socket
  // backpressure — the blob path deadlocks once the socket buffer fills (~4MB).
  const push = await streamFileOverSsh(target, encodePowerShell(buildPushScript()), exe);
  if (push.code !== 0) {
    throw new Error(`pushing helper exe to '${name}' failed (exit ${push.code ?? 'null'}): ${push.stderr.trim()}`);
  }

  // Register + start the LOGON task.
  const reg = sshExec(target, encodePowerShell(buildRegisterTaskScript(REMOTE_HELPER_PORT, REMOTE_TASK_NAME)), {
    timeoutMs: 60_000,
  });
  if (reg.code !== 0) {
    throw new Error(`registering scheduled task on '${name}' failed (exit ${reg.code ?? 'null'}): ${reg.stderr.trim() || reg.stdout.trim()}`);
  }

  return { target, taskName: REMOTE_TASK_NAME };
}

/** Reserve a free local TCP port by binding :0 and reading the assigned port. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not reserve a local port'))));
    });
  });
}

/**
 * `start --host`: open a detached ssh -L tunnel to the remote daemon, verify it
 * answers over TCP, and persist the tunnel state so verbs can reconnect. Returns
 * the state (and leaves the tunnel running in the background).
 */
export async function startRemoteTunnel(name: string): Promise<RemoteTunnelState> {
  const { target, user, host } = await resolveRemoteDevice(name);
  const remotePort = REMOTE_HELPER_PORT;
  const localPort = await pickFreePort();

  const tunnel = await startSSHTunnel(user, host, localPort, remotePort, { detached: true });
  const tunnelPid = tunnel.pid ?? 0;

  // Verify the daemon answers through the tunnel before we record it. This is
  // the real end-to-end check: tunnel up + daemon listening + RPC round-trips.
  const token: string | null = null; // tunnel-gated; the daemon runs token-less
  const prevTcp = process.env.COMPUTER_HELPER_TCP;
  process.env.COMPUTER_HELPER_TCP = `127.0.0.1:${localPort}`;
  const client = openComputerClient();
  let ok = false;
  let probeErr = '';
  try {
    const r = await client.call('list_apps');
    ok = !r.error;
    if (r.error) probeErr = `${r.error.code}: ${r.error.message}`;
  } catch (e) {
    probeErr = (e as Error).message;
  } finally {
    await client.close();
    if (prevTcp === undefined) delete process.env.COMPUTER_HELPER_TCP;
    else process.env.COMPUTER_HELPER_TCP = prevTcp;
  }
  if (!ok) {
    try { if (tunnelPid) process.kill(tunnelPid); } catch { /* gone */ }
    throw new Error(
      `tunnel to '${name}' opened but the daemon did not answer (${probeErr}). ` +
        `Is it installed? Run: agents computer setup --host ${name}`,
    );
  }

  const state: RemoteTunnelState = {
    device: name,
    target,
    localPort,
    remotePort,
    tunnelPid,
    token,
    taskName: REMOTE_TASK_NAME,
    startedAt: Date.now(),
  };
  writeRemoteState(state);
  return state;
}

/**
 * `stop --host`: kill the local tunnel, unregister the remote task (best-effort
 * — the box may be offline), and clear the persisted state.
 */
export async function stopRemoteHelper(name: string): Promise<{ tunnelKilled: boolean; taskRemoved: boolean }> {
  const state = readRemoteState(name);
  let tunnelKilled = false;
  if (state?.tunnelPid) {
    try {
      process.kill(state.tunnelPid);
      tunnelKilled = true;
    } catch {
      /* already gone */
    }
  }

  let taskRemoved = false;
  try {
    const { target } = await resolveRemoteDevice(name);
    const res = sshExec(target, encodePowerShell(buildUnregisterTaskScript(REMOTE_TASK_NAME)), { timeoutMs: 60_000 });
    taskRemoved = res.code === 0;
  } catch {
    /* device gone / offline — local teardown still succeeds */
  }

  clearRemoteState(name);
  return { tunnelKilled, taskRemoved };
}

/**
 * Point this process's RPC client at a device's live tunnel by setting
 * COMPUTER_HELPER_TCP / COMPUTER_HELPER_TOKEN from persisted state. Called for
 * remote verbs (`apps --host`, `click --host`, …) so the shared
 * openComputerClient() transparently selects the TcpClient transport — no
 * per-verb wiring. Exits with guidance when there is no active tunnel.
 */
export function hydrateRemoteEnvFromState(name: string): void {
  const state = readRemoteState(name);
  if (!state) {
    console.error(`No active remote tunnel for '${name}'.`);
    console.error(`Run:  agents computer start --host ${name}`);
    process.exit(1);
  }
  process.env.COMPUTER_HELPER_TCP = `127.0.0.1:${state.localPort}`;
  if (state.token) process.env.COMPUTER_HELPER_TOKEN = state.token;
  // Touch resolveTcpEndpoint so a later platform-gate check sees the endpoint.
  void resolveTcpEndpoint();
}

/** Generate a shared-secret token (reserved for token-file provisioning). */
export function generateToken(): string {
  return randomBytes(24).toString('hex');
}
