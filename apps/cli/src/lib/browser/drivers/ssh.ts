import { spawn, execFileSync, type ChildProcess } from 'child_process';
import * as net from 'net';
import { CDPClient, discoverBrowserWsUrl, verifyBrowserIdentity } from '../cdp.js';
import { getPortOccupant } from '../chrome.js';
import { parseEndpointUrl } from '../profiles.js';
import { writeProfileRuntime, clearProfileRuntime } from '../runtime-state.js';
import type { BrowserProfile } from '../types.js';
// shellQuote lives in the shared ssh-exec helper (single choke point); re-export
// so existing importers of `shellQuote` from this module keep working. SSH_OPTS
// is the shared hardened baseline (BatchMode + ConnectTimeout + keepalive) —
// reuse it so the raw-ssh spawns below fail fast on an unreachable host instead
// of hanging on the default ~127s TCP timeout, rather than re-listing options.
import { shellQuote, SSH_OPTS } from '../../ssh-exec.js';
export { shellQuote };
// The `ssh -L` tunnel spawn is shared with `agents computer --host`; it lives in
// the single ssh-tunnel helper. Calling it with no options preserves this
// driver's original foreground, stderr-captured behavior exactly.
import { startSSHTunnel } from '../../ssh-tunnel.js';
import { encodePwshBase64 } from '../../pwsh.js';

export interface SSHConnection {
  cdp: CDPClient;
  port: number;
  pid: number;
  cleanup: () => void;
}

/**
 * Which shell dialect the *remote* host speaks. Selected per-endpoint via the
 * `&os=windows` query param on an `ssh://` target. POSIX is the default — the
 * historical behavior for macOS/Linux remotes. Windows remotes run OpenSSH
 * Server with cmd.exe as the default shell, so the launch/teardown command
 * strings differ (no `&` backgrounding, no `lsof`, `.exe` instead of `.app`).
 */
export type RemoteOs = 'windows' | 'posix';

export async function connectSSH(
  endpoint: string,
  profile: BrowserProfile
): Promise<SSHConnection> {
  const url = new URL(endpoint);

  if (url.protocol !== 'ssh:') {
    throw new Error(`Invalid SSH endpoint: ${endpoint}`);
  }

  const user = url.username || process.env.USER || 'root';
  // Use the shared parser so the documented `ssh://host?port=N` form works
  // identically to `ssh://host:N`. Previously `url.port` alone meant every
  // `?port=`-style profile silently fell back to 9222.
  const parsed = parseEndpointUrl(endpoint);
  if (!parsed) {
    throw new Error(`Could not extract host:port from SSH endpoint: ${endpoint}`);
  }
  const host = parsed.host;
  const remotePort = parsed.port;

  // `&os=windows` switches the remote-command dialect (cmd.exe launch via
  // `start`, taskkill teardown). Anything else — including absent — is posix.
  // The query param is the single source of truth so the driver never has to
  // be threaded a separate per-profile field.
  const remoteOs: RemoteOs =
    (url.searchParams.get('os') || '').toLowerCase() === 'windows' ? 'windows' : 'posix';

  // Bind the tunnel to the SAME local port the user configured. Using an
  // allocated port instead made `status` print confusing rows like
  // `port 9200 (configured 10005)` and made it impossible to predict which
  // local port a profile would land on. Now `ssh://host?port=N` => local N.
  const localPort = remotePort;

  // Preflight: if the local port is busy with something that isn't our
  // own SSH tunnel for this very target, bail with a clear error. Letting
  // ssh -L race ahead would either silently succeed (binding to a second
  // port via fail-safe) or fail with cryptic stderr.
  const occupant = getPortOccupant(localPort);
  if (occupant && !isOwnTunnel(occupant.pid, host, remotePort)) {
    throw new Error(
      `Local port ${localPort} (needed for SSH tunnel to ${host}:${remotePort}) ` +
        `is already in use by ${occupant.command} (pid ${occupant.pid}). ` +
        `Either kill that process (\`kill ${occupant.pid}\`) or change the profile's port.`
    );
  }

  // A non-zero remote exit (missing exe, auth failure, bad launch) now rejects
  // with the captured stderr and propagates. An already-running browser exits 0
  // (the launch backgrounds/WMI-spawns regardless), so this does not spuriously
  // fail the reconnect path — only genuine launch failures reach the caller
  // instead of being swallowed and mis-reported later as a tunnel timeout.
  await ensureRemoteBrowser(user, host, profile.browser, remotePort, remoteOs, profile.binary);

  let tunnel: ChildProcess;
  if (occupant) {
    // Reuse the existing tunnel rather than spawning a duplicate.
    tunnel = { pid: occupant.pid, kill: () => { try { process.kill(occupant.pid); } catch { /* gone */ } } } as ChildProcess;
  } else {
    tunnel = await startSSHTunnel(user, host, localPort, remotePort);
  }

  try {
    await waitForPort(localPort, 8000);
  } catch {
    tunnel.kill();
    throw new Error(`SSH tunnel failed to establish to ${host}`);
  }

  const { wsUrl, browser } = await discoverBrowserWsUrl(localPort, 'localhost', profile.name);
  try {
    verifyBrowserIdentity(browser, profile.browser, remotePort, host);
  } catch (err) {
    tunnel.kill();
    throw err;
  }
  const cdp = new CDPClient();
  await cdp.connect(wsUrl);

  // Record the tunnel in the profile's runtime so a future daemon — or
  // the orphan reaper after a crash — can find and clean it up. The
  // `kind: 'tunnel'` flag distinguishes it from a locally-launched
  // browser process.
  const tunnelPid = tunnel.pid ?? 0;
  if (tunnelPid > 0) {
    writeProfileRuntime(profile.name, {
      pid: 0,
      port: localPort,
      command: 'ssh',
      kind: 'tunnel',
      tunnelPid,
    });
  }

  return {
    cdp,
    port: localPort,
    pid: tunnelPid,
    cleanup: () => {
      cdp.close();
      // Kill the remote browser BEFORE tearing down the tunnel. It runs on a
      // separate ssh connection (independent of the tunnel we're about to
      // kill), so tunnel teardown can't cut it off. Fire-and-forget — cleanup
      // stays synchronous, and killRemoteBrowser never rejects.
      killRemoteBrowser(user, host, remoteOs, remotePort).catch(() => {});
      tunnel.kill();
      clearProfileRuntime(profile.name);
    },
  };
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await tryConnect(port);
      return;
    } catch {
      await sleep(200);
    }
  }

  throw new Error(`Port ${port} not ready after ${timeoutMs}ms`);
}

function tryConnect(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.on('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.on('error', reject);
  });
}

// macOS .app launchers — the historical POSIX table.
const POSIX_BROWSER_PATHS: Record<string, string> = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  comet: '/Applications/Comet.app/Contents/MacOS/Comet',
  chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
};

// Windows App Paths registry keys per browser. CreateProcess (used by WMI
// Win32_Process.Create) does not honor App Paths the way ShellExecute/`start`
// does, so the launch script resolves the real `.exe` path from this registry
// key at runtime — covering both Program Files and Program Files (x86)
// installs without hardcoding (or guessing) the location.
const WIN_BROWSER_APPPATH: Record<string, string> = {
  chrome: 'chrome.exe',
  chromium: 'chrome.exe',
  brave: 'brave.exe',
  edge: 'msedge.exe',
};

/** Single-quote a string for embedding inside a PowerShell literal. */
function psSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Wrap a PowerShell script as a `-EncodedCommand` invocation. Base64 of the
 * UTF-16LE bytes is a single quote-free token, so it rides through Node spawn
 * → Windows sshd → cmd.exe with zero escaping hazards (hand-quoted
 * `powershell -Command "…"` is fragile the moment a path or URL is involved).
 */
export function encodePowerShell(script: string): string {
  return `powershell -NoProfile -EncodedCommand ${encodePwshBase64(script)}`;
}

/**
 * The PowerShell that launches the browser on a Windows remote. Two hard
 * requirements shaped this:
 *   1. The browser must OUTLIVE the ssh session. Windows OpenSSH terminates
 *      the session's job tree on disconnect, which reaps both `start /B` and
 *      `Start-Process` children (verified against a real box). WMI
 *      `Win32_Process.Create` spawns under the WMI provider service instead,
 *      so the process survives after we drop the ssh connection and reconnect
 *      over the CDP tunnel.
 *   2. A distinct `--user-data-dir` so a fresh instance bound to the debugging
 *      port comes up even when the user already has Edge open.
 * CreateProcess ignores App Paths, so we resolve the real `.exe` from the
 * registry at runtime rather than relying on a bare `msedge` name.
 */
export function buildWindowsLaunchScript(
  browserType: string,
  port: number,
  customBinary?: string
): string {
  let exeStmts: string[];
  if (customBinary) {
    exeStmts = [`$exe = ${psSingleQuote(customBinary)}`];
  } else if (browserType === 'custom') {
    throw new Error('browser: custom requires a binary path in the profile');
  } else {
    const exeKey = WIN_BROWSER_APPPATH[browserType];
    if (!exeKey) throw new Error(`Unknown browser type for windows remote: ${browserType}`);
    const appPath = `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeKey}`;
    // Per-user installs — the DEFAULT for Edge and Chrome — register App Paths
    // under HKCU, not HKLM, so an HKLM-only lookup silently missed them and the
    // launch failed. Resolve from HKLM first, then fall through to HKCU.
    // Windows PowerShell 5.1 (what `powershell.exe` is) has no `??`, so the
    // fallback is an explicit `if`. A missing exe `throw`s so the failure rides
    // out as a non-zero ssh exit (surfaced by ensureRemoteBrowser) instead of a
    // silent empty launch.
    exeStmts = [
      `$exe = (Get-ItemProperty 'HKLM:\\${appPath}' -EA SilentlyContinue).'(default)'`,
      `if (-not $exe) { $exe = (Get-ItemProperty 'HKCU:\\${appPath}' -EA SilentlyContinue).'(default)' }`,
      `if (-not $exe) { throw 'browser exe not found in HKLM/HKCU App Paths: ${exeKey}' }`,
    ];
  }
  // Keep the `--remote-allow-origins=http://127.0.0.1:${port}` literal in
  // source — a test asserts CDP is never opened to `*`.
  return [
    ...exeStmts,
    `$cl = '"' + $exe + '" --remote-debugging-port=${port}` +
      ` --remote-allow-origins=http://127.0.0.1:${port}` +
      ` --disable-background-timer-throttling --user-data-dir="' + $env:TEMP + '\\agents-browser-${port}"'`,
    `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cl } | Out-Null`,
  ].join('; ');
}

/** The PowerShell that kills whatever holds the CDP port on a Windows remote. */
export function buildWindowsKillScript(port: number): string {
  return (
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue ` +
    `| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`
  );
}

/**
 * Build the remote command that launches the browser detached with a CDP port.
 * POSIX backgrounds the `.app` binary with `… &`; Windows resolves the exe and
 * spawns it via WMI (encoded PowerShell) so it survives the ssh session.
 */
export function buildLaunchCmd(
  remoteOs: RemoteOs,
  browserType: string,
  port: number,
  customBinary?: string
): string {
  if (remoteOs === 'windows') {
    return encodePowerShell(buildWindowsLaunchScript(browserType, port, customBinary));
  }
  const browserPath = customBinary ?? POSIX_BROWSER_PATHS[browserType];
  if (!browserPath) {
    if (browserType === 'custom') {
      throw new Error('browser: custom requires a binary path in the profile');
    }
    throw new Error(`Unknown browser type for posix remote: ${browserType}`);
  }
  return [
    shellQuote(browserPath),
    `--remote-debugging-port=${port}`,
    shellQuote(`--remote-allow-origins=http://127.0.0.1:${port}`),
    '--disable-background-timer-throttling',
    `--user-data-dir=/tmp/agents-browser-${port}`,
    '</dev/null >/dev/null 2>&1 &',
  ].join(' ');
}

/**
 * Build the remote command that kills whatever holds the CDP port.
 * POSIX uses `lsof`+`kill`; Windows uses encoded PowerShell
 * (Get-NetTCPConnection → Stop-Process).
 */
export function buildKillCmd(remoteOs: RemoteOs, port: number): string {
  if (remoteOs === 'windows') {
    return encodePowerShell(buildWindowsKillScript(port));
  }
  return `pids=$(lsof -ti ${shellQuote(`:${port}`)} 2>/dev/null); [ -z "$pids" ] || kill -9 $pids 2>/dev/null || true`;
}

export async function ensureRemoteBrowser(
  user: string,
  host: string,
  browserType: string,
  port: number,
  remoteOs: RemoteOs,
  customBinary?: string
): Promise<void> {
  const remoteCmd = buildLaunchCmd(remoteOs, browserType, port, customBinary);

  return new Promise((resolve, reject) => {
    // Capture stderr so a real launch failure (missing exe, auth denied, bad
    // CreateProcess) surfaces here as a clear error. Previously stdio was
    // ignored and this resolved on close regardless of exit code, so failures
    // were swallowed and only re-emerged 8s later as a generic
    // "SSH tunnel failed to establish".
    // Options BEFORE the target (matching `sshExec`): OpenSSH's BSD getopt on
    // macOS stops at the first non-option, so any `-o` after `user@host` would
    // be swallowed into the remote command instead of applied.
    const child = spawn(
      'ssh',
      [
        ...SSH_OPTS,
        `${user}@${host}`,
        remoteCmd,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    );

    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // ssh is still running the backgrounding launch command past our window.
      // Killing the local ssh client does NOT reap the WMI/detached remote
      // browser, so treat this as launched and let waitForPort confirm.
      child.kill();
      resolve();
    }, 2000);

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code && code !== 0) {
        const detail = stderr.trim();
        reject(
          new Error(
            `Remote browser launch failed on ${host} (ssh exit ${code})` +
              (detail ? `: ${detail}` : '')
          )
        );
      } else {
        resolve();
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function restartRemoteBrowser(
  user: string,
  host: string,
  browserType: string,
  port: number,
  remoteOs: RemoteOs,
  customBinary?: string
): Promise<void> {
  // Kill any process using the remote debugging port
  await runSSHCommand(user, host, buildKillCmd(remoteOs, port));
  await sleep(500);
  await ensureRemoteBrowser(user, host, browserType, port, remoteOs, customBinary);
  await sleep(1500);
}

/**
 * Kill the remote browser holding the CDP port. Invoked on stop/cleanup so the
 * WMI-spawned (Windows) / detached (posix) browser process is not orphaned when
 * the ssh tunnel is torn down — killing only the tunnel left it running on
 * win-mini after every `browser stop`. Best-effort: never rejects.
 */
export function killRemoteBrowser(
  user: string,
  host: string,
  remoteOs: RemoteOs,
  port: number
): Promise<void> {
  return runSSHCommand(user, host, buildKillCmd(remoteOs, port));
}

function runSSHCommand(user: string, host: string, cmd: string): Promise<void> {
  return new Promise((resolve) => {
    // Reuse the shared hardened baseline so a hung TCP SYN to an unreachable
    // host is bounded by ConnectTimeout (the local 3s kill below only bounds a
    // connected-but-slow command, not the connect itself). Options precede the
    // target — see ensureRemoteBrowser.
    const child = spawn('ssh', [...SSH_OPTS, `${user}@${host}`, cmd], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
    setTimeout(() => {
      child.kill();
      resolve();
    }, 3000);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Identify whether a pid listening on our target local port is an SSH
 * tunnel WE would have spawned for `host:remotePort`. Used so that two
 * agents-browser invocations of the same SSH profile share a tunnel
 * rather than failing the second one with "port in use".
 *
 * Best-effort match against the ssh -L command line via `ps`. If we
 * can't read the cmd or the args don't look like ours, treat as not-ours.
 *
 * Windows has no `ps`, so the POSIX branch below always throws there and every
 * reuse check returned false — the second invocation to the same host:port then
 * failed "port in use". On win32 we instead reuse the netstat -ano + tasklist
 * occupant lookup (getPortOccupant): the tunnel binds `remotePort` locally
 * (localPort === remotePort in the caller), so the pid holding that port is our
 * ssh.exe. tasklist only exposes the image name, not the full command line, so
 * we can't match host/remotePort as tightly as the POSIX branch — an ssh
 * process on our exact local port is our tunnel in practice.
 */
export function isOwnTunnel(pid: number, host: string, remotePort: number): boolean {
  if (process.platform === 'win32') {
    const occupant = getPortOccupant(remotePort);
    if (!occupant || occupant.pid !== pid) return false;
    return occupant.command.toLowerCase().startsWith('ssh');
  }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (!out.startsWith('ssh')) return false;
    if (!out.includes(host)) return false;
    if (!out.includes(`:${remotePort}`) && !out.includes(`:127.0.0.1:${remotePort}`)) return false;
    return true;
  } catch {
    return false;
  }
}
