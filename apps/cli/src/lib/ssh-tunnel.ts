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
import { randomBytes, createHash } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { sshExec, SSH_OPTS, assertValidSshTarget } from './ssh-exec.js';
import { backgroundSpawnOptions } from './platform/process.js';
import { encodePowerShell } from './browser/drivers/ssh.js';
import { getDevice, type DeviceProfile } from './devices/registry.js';
import { sshTargetFor } from './devices/connect.js';
import { hostNameFor } from './devices/ssh-config.js';
import { getCacheDir } from './state.js';
import { getCliVersion } from './version.js';
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

/** Build the ssh argv (after the `ssh` program name) for an `-L` tunnel. Pure.
 *
 * Composes the shared hardened baseline (`SSH_OPTS`) rather than re-listing it,
 * so the tunnel inherits the same options — crucially the keepalive, which lets
 * a dropped `-N` tunnel exit instead of lingering as a zombie on the laptop. */
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
    ...SSH_OPTS,
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
    // `user`/`host` can originate from a browser ssh:// profile or a device
    // record. buildTunnelArgs places `${user}@${host}` before `-N`/SSH_OPTS, so
    // a `-`-leading user would be parsed as an ssh option flag (option
    // injection). Validate at the spawn sink so every caller is covered; reject
    // (rather than throw synchronously) to keep the Promise contract.
    try {
      assertValidSshTarget(`${user}@${host}`);
    } catch (err) {
      reject(err as Error);
      return;
    }
    const args = buildTunnelArgs(user, host, localPort, remotePort);

    const tunnel = spawn('ssh', args, {
      stdio: opts.detached ? 'ignore' : ['ignore', 'ignore', 'pipe'],
      ...(opts.detached ? backgroundSpawnOptions() : { detached: false, windowsHide: true }),
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

/** Basename of the cross-published exe under native/computer-win/dist. */
export const WIN_HELPER_EXE = 'computer-helper-win.exe';

/** Basename of the daemon's shared-secret token file under %LOCALAPPDATA%\agents. */
export const WIN_HELPER_TOKEN_FILE = 'helper-token';

/**
 * Locate a locally built Windows daemon exe — a repo-checkout build output from
 * `scripts/build-win.sh`, or one bundled next to the package. Local paths are
 * only the first candidate; npm-installed CLIs have neither and fall through to
 * the release-asset download (`ensureWinHelperExe`).
 */
export function resolveWinHelperExe(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Running from the agents-cli checkout. apps/cli/dist/lib -> repo root (4 up) -> native/computer-win.
    path.resolve(here, '..', '..', '..', '..', 'native', 'computer-win', 'dist', WIN_HELPER_EXE),
    // Bundled with the npm package (dist/lib -> package root).
    path.resolve(here, '..', 'computer-helper-win', WIN_HELPER_EXE),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** GitHub repo whose `v<version>` releases carry the exe as an asset. */
export const WIN_HELPER_RELEASE_REPO = 'phnx-labs/agents-cli';

/** Cache dir for downloaded helper exes, one subdir per release tag. */
export function winHelperCacheDir(version: string): string {
  return path.join(getCacheDir(), 'computer', 'win-helper', `v${version}`);
}

/** Release-asset URLs for the exe + its checksum at one exact `v<version>` tag. */
export function winHelperAssetUrls(version: string): { exe: string; sha256: string } {
  const base = `https://github.com/${WIN_HELPER_RELEASE_REPO}/releases/download/v${version}`;
  return { exe: `${base}/${WIN_HELPER_EXE}`, sha256: `${base}/${WIN_HELPER_EXE}.sha256` };
}

/**
 * Parse the published `.sha256` asset — `sha256sum` format (`<hex>  <name>`) or
 * a bare hex digest. Throws on anything that does not lead with 64 hex chars.
 */
export function parseSha256Asset(text: string): string {
  const m = text.trim().match(/^([A-Fa-f0-9]{64})(\s|$)/);
  if (!m) throw new Error(`malformed .sha256 release asset: ${JSON.stringify(text.slice(0, 80))}`);
  return m[1].toLowerCase();
}

/** Stream a file through sha256 — the exe is ~157MB, never read it whole. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Download the exe release asset for this CLI version, verify its sha256
 * against the published `.sha256` asset, and cache it under the agents cache
 * dir. Only the exact `v<version>` tag is consulted — a missing asset is a
 * hard error naming that tag, never a silent fallback to another release.
 */
export async function downloadWinHelperExe(version: string): Promise<string> {
  const cached = path.join(winHelperCacheDir(version), WIN_HELPER_EXE);
  if (fs.existsSync(cached)) return cached;

  const tag = `v${version}`;
  const { exe: exeUrl, sha256: shaUrl } = winHelperAssetUrls(version);
  const missing = (status: number, url: string) =>
    new Error(
      `no ${WIN_HELPER_EXE} release asset for tag ${tag} (HTTP ${status} on ${url}). ` +
        `The Windows helper ships as a GitHub release asset per tagged CLI version; ` +
        `from a repo checkout you can build it locally instead: bash scripts/build-win.sh`,
    );

  // Checksum first: it is tiny and 404s fast when the tag has no assets.
  const shaRes = await fetch(shaUrl, { signal: AbortSignal.timeout(30_000) });
  if (!shaRes.ok) throw missing(shaRes.status, shaUrl);
  const expected = parseSha256Asset(await shaRes.text());

  console.error(`Downloading ${WIN_HELPER_EXE} ${tag} from GitHub releases (~160 MB)...`);
  const exeRes = await fetch(exeUrl, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!exeRes.ok || !exeRes.body) throw missing(exeRes.status, exeUrl);

  fs.mkdirSync(path.dirname(cached), { recursive: true });
  // Stream to a partial file and rename only after the checksum passes, so an
  // interrupted download can never be picked up as a valid cache hit.
  const partial = `${cached}.download`;
  try {
    await pipeline(
      Readable.fromWeb(exeRes.body as unknown as import('stream/web').ReadableStream),
      fs.createWriteStream(partial),
    );
    const actual = await sha256File(partial);
    if (actual !== expected) {
      throw new Error(`sha256 mismatch for ${exeUrl}: expected ${expected}, got ${actual}`);
    }
    fs.renameSync(partial, cached);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  return cached;
}

/**
 * Resolve the helper exe for `setup --host`: local build outputs first (repo
 * checkout / bundled), then the checksum-verified release-asset download for
 * the running CLI version. Throws with the tag it checked when neither exists.
 */
export async function ensureWinHelperExe(version = getCliVersion()): Promise<string> {
  const local = resolveWinHelperExe();
  if (local) return local;
  return downloadWinHelperExe(version);
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

/**
 * Local file holding the shared-secret token for a device's helper daemon.
 * Written at `setup --host` (0600), read at `start --host` so the RPC client
 * authenticates. The remote daemon reads the same value from its own
 * `--token-file`; the CLI is the source of truth and never round-trips it back.
 */
export function helperTokenPath(device: string): string {
  return path.join(remoteStateDir(), `${device}.token`);
}

export function readHelperToken(device: string): string | null {
  try {
    const t = fs.readFileSync(helperTokenPath(device), 'utf-8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export function writeHelperToken(device: string, token: string): void {
  const dir = remoteStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(helperTokenPath(device), token, { mode: 0o600 });
}

export function clearHelperToken(device: string): void {
  try {
    fs.unlinkSync(helperTokenPath(device));
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
 * Single-quote a string for embedding inside a PowerShell literal.
 */
function psSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * PowerShell that resolves the destination under %LOCALAPPDATA%\agents and
 * stops any running instance first so the file is not locked. The caller copies
 * the exe with scp and then verifies the byte count separately.
 */
export function buildPushScript(): string {
  return [
    `$dir = Join-Path $env:LOCALAPPDATA 'agents'`,
    `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
    `$dst = Join-Path $dir '${WIN_HELPER_EXE}'`,
    `Get-Process -Name 'computer-helper-win' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`,
    `Write-Output $dst`,
  ].join('; ');
}

/** PowerShell that verifies scp wrote the expected number of bytes. */
export function buildVerifyPushScript(remotePath: string, expectedBytes: number): string {
  return [
    `$dst = ${psSingleQuote(remotePath)}`,
    `$item = Get-Item -LiteralPath $dst -ErrorAction Stop`,
    `if ($item.Length -ne ${expectedBytes}) { throw "helper copy length mismatch: expected ${expectedBytes}, got $($item.Length)" }`,
    `Write-Output "$dst $($item.Length)"`,
  ].join('; ');
}

/**
 * PowerShell that registers the daemon as a LOGON scheduled task. Interactive
 * logon type + Highest run level so the daemon runs in the real desktop session
 * (UIAutomation and ScreenCapture need a live session, not Session 0) and
 * survives ssh disconnect — the same rationale as the browser WMI launch. The
 * task is started immediately so the caller need not log out/in.
 */
/**
 * PowerShell that writes the shared-secret token under %LOCALAPPDATA%\agents
 * with an owner-only ACL (inheritance removed, read granted only to the current
 * user) and echoes the resolved path so the caller can pass it to `--token-file`.
 */
export function buildWriteTokenScript(token: string): string {
  return [
    `$dir = Join-Path $env:LOCALAPPDATA 'agents'`,
    `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
    `$tok = Join-Path $dir '${WIN_HELPER_TOKEN_FILE}'`,
    `Set-Content -LiteralPath $tok -Value ${psSingleQuote(token)} -NoNewline -Encoding ascii`,
    `icacls $tok /inheritance:r /grant:r ("$($env:USERNAME):(R)") | Out-Null`,
    `Write-Output $tok`,
  ].join('; ');
}

export function buildRegisterTaskScript(port: number, taskName: string, tokenPath: string): string {
  const argument = `--port ${port} --token-file "${tokenPath}"`;
  return [
    `$exe = Join-Path (Join-Path $env:LOCALAPPDATA 'agents') '${WIN_HELPER_EXE}'`,
    `$action = New-ScheduledTaskAction -Execute $exe -Argument ${psSingleQuote(argument)}`,
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

/** Convert a Windows path returned by PowerShell into the scp/SFTP path form. */
export function scpRemotePath(remotePath: string): string {
  return remotePath.replace(/\\/g, '/');
}

/**
 * Build the scp argv used for the helper exe transfer. Exported so tests can
 * assert the real binary copy path keeps BatchMode and does not route bytes
 * through a PowerShell decoder.
 */
export function buildScpArgs(target: string, remotePath: string, filePath: string): string[] {
  return [...SSH_OPTS, filePath, `${target}:${scpRemotePath(remotePath)}`];
}

/**
 * Copy a local file to the remote destination with scp. This is a binary
 * transfer; no base64 transform runs on either side.
 */
function copyFileOverScp(
  target: string,
  remotePath: string,
  filePath: string,
  timeoutMs = 600_000,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('scp', buildScpArgs(target, remotePath, filePath), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`scp push to ${target} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (e: Error) => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(e);
    };
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/**
 * `setup --host`: push the exe, then register + start the LOGON task. Remote
 * PowerShell hops go through `sshExec` (BatchMode key auth — the same hardening
 * the browser driver and `agents ssh` use), and the large exe rides a binary
 * scp transfer. Throws with the remote stderr on any failure.
 */

export async function setupRemoteHelper(name: string): Promise<{ target: string; taskName: string }> {
  const { target } = await resolveRemoteDevice(name);

  // Local build output, else the checksum-verified GitHub release asset for
  // this CLI version. Throws naming the tag it checked when neither exists.
  const exe = await ensureWinHelperExe();

  const prep = sshExec(target, encodePowerShell(buildPushScript()), { timeoutMs: 60_000 });
  if (prep.code !== 0) {
    throw new Error(`preparing helper exe path on '${name}' failed (exit ${prep.code ?? 'null'}): ${prep.stderr.trim() || prep.stdout.trim()}`);
  }
  const remotePath = prep.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!remotePath) {
    throw new Error(`preparing helper exe path on '${name}' did not return a destination path`);
  }

  const push = await copyFileOverScp(target, remotePath, exe);
  if (push.code !== 0) {
    throw new Error(`pushing helper exe to '${name}' failed (exit ${push.code ?? 'null'}): ${push.stderr.trim()}`);
  }

  const expectedBytes = fs.statSync(exe).size;
  const verify = sshExec(target, encodePowerShell(buildVerifyPushScript(remotePath, expectedBytes)), { timeoutMs: 60_000 });
  if (verify.code !== 0) {
    throw new Error(`verifying helper exe on '${name}' failed (exit ${verify.code ?? 'null'}): ${verify.stderr.trim() || verify.stdout.trim()}`);
  }

  // Provision the auth token: generate it locally, write it on the remote with
  // an owner-only ACL, and register the task with --token-file. The daemon now
  // refuses to start without a token, so a token-less (open-to-any-local-process)
  // daemon can no longer be stood up through the CLI.
  const token = generateToken();
  const tokWrite = sshExec(target, encodePowerShell(buildWriteTokenScript(token)), { timeoutMs: 60_000 });
  if (tokWrite.code !== 0) {
    throw new Error(`writing helper token on '${name}' failed (exit ${tokWrite.code ?? 'null'}): ${tokWrite.stderr.trim() || tokWrite.stdout.trim()}`);
  }
  const remoteTokenPath = tokWrite.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!remoteTokenPath) {
    throw new Error(`writing helper token on '${name}' did not return a destination path`);
  }

  // Register + start the LOGON task, pointing it at the token file.
  const reg = sshExec(target, encodePowerShell(buildRegisterTaskScript(REMOTE_HELPER_PORT, REMOTE_TASK_NAME, remoteTokenPath)), {
    timeoutMs: 60_000,
  });
  if (reg.code !== 0) {
    throw new Error(`registering scheduled task on '${name}' failed (exit ${reg.code ?? 'null'}): ${reg.stderr.trim() || reg.stdout.trim()}`);
  }

  // Persist the token locally so `start --host` authenticates to the daemon.
  writeHelperToken(name, token);

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
  // The daemon now requires a token, so the probe must authenticate with the one
  // provisioned at `setup`. A missing token means setup predates auth — guide
  // the user to re-run it rather than silently failing the RPC.
  const token = readHelperToken(name);
  const prevTcp = process.env.COMPUTER_HELPER_TCP;
  const prevTok = process.env.COMPUTER_HELPER_TOKEN;
  process.env.COMPUTER_HELPER_TCP = `127.0.0.1:${localPort}`;
  if (token) process.env.COMPUTER_HELPER_TOKEN = token;
  else delete process.env.COMPUTER_HELPER_TOKEN;
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
    if (prevTok === undefined) delete process.env.COMPUTER_HELPER_TOKEN;
    else process.env.COMPUTER_HELPER_TOKEN = prevTok;
  }
  if (!ok) {
    try { if (tunnelPid) process.kill(tunnelPid); } catch { /* gone */ }
    const hint = token
      ? `Is it installed? Run: agents computer setup --host ${name}`
      : `No auth token on record for '${name}' — re-run: agents computer setup --host ${name}`;
    throw new Error(
      `tunnel to '${name}' opened but the daemon did not answer (${probeErr}). ${hint}`,
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
  clearHelperToken(name);
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
