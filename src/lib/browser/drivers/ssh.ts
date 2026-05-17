import { spawn, execFileSync, type ChildProcess } from 'child_process';
import * as net from 'net';
import { CDPClient, discoverBrowserWsUrl, verifyBrowserIdentity } from '../cdp.js';
import { getPortOccupant } from '../chrome.js';
import { parseEndpointUrl } from '../profiles.js';
import { writeProfileRuntime, clearProfileRuntime } from '../runtime-state.js';
import type { BrowserProfile } from '../types.js';

export interface SSHConnection {
  cdp: CDPClient;
  port: number;
  pid: number;
  cleanup: () => void;
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

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

  try {
    await ensureRemoteBrowser(user, host, profile.browser, remotePort, profile.binary);
  } catch {
    // Browser may already be running, continue
  }

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

  const { wsUrl, browser } = await discoverBrowserWsUrl(localPort);
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
      tunnel.kill();
      clearProfileRuntime(profile.name);
    },
  };
}

function startSSHTunnel(
  user: string,
  host: string,
  localPort: number,
  remotePort: number
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const args = [
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

    const tunnel = spawn('ssh', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
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
        resolve(tunnel);
      }
    }, 500);
  });
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

async function ensureRemoteBrowser(
  user: string,
  host: string,
  browserType: string,
  port: number,
  customBinary?: string
): Promise<void> {
  const browserPaths: Record<string, string> = {
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    comet: '/Applications/Comet.app/Contents/MacOS/Comet',
    chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  };

  let browserPath: string;
  if (customBinary) {
    browserPath = customBinary;
  } else if (browserType === 'custom') {
    throw new Error('browser: custom requires a binary path in the profile');
  } else {
    browserPath = browserPaths[browserType];
    if (!browserPath) {
      throw new Error(`Unknown browser type: ${browserType}`);
    }
  }

  const remoteCmd = [
    shellQuote(browserPath),
    `--remote-debugging-port=${port}`,
    shellQuote('--remote-allow-origins=*'),
    '--disable-background-timer-throttling',
    `--user-data-dir=/tmp/agents-browser-${port}`,
    '</dev/null >/dev/null 2>&1 &',
  ].join(' ');

  return new Promise((resolve, reject) => {
    const child = spawn(
      'ssh',
      [
        `${user}@${host}`,
        '-o',
        'BatchMode=yes',
        remoteCmd,
      ],
      { stdio: 'ignore' }
    );

    child.on('close', () => resolve());
    child.on('error', reject);

    setTimeout(() => {
      child.kill();
      resolve();
    }, 2000);
  });
}

export async function restartRemoteBrowser(
  user: string,
  host: string,
  browserType: string,
  port: number,
  customBinary?: string
): Promise<void> {
  // Kill any process using the remote debugging port
  const killCmd = `pids=$(lsof -ti ${shellQuote(`:${port}`)} 2>/dev/null); [ -z "$pids" ] || kill -9 $pids 2>/dev/null || true`;
  await runSSHCommand(user, host, killCmd);
  await sleep(500);
  await ensureRemoteBrowser(user, host, browserType, port, customBinary);
  await sleep(1500);
}

function runSSHCommand(user: string, host: string, cmd: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('ssh', [`${user}@${host}`, '-o', 'BatchMode=yes', cmd], {
      stdio: 'ignore',
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
 */
function isOwnTunnel(pid: number, host: string, remotePort: number): boolean {
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
