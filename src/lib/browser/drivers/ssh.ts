import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import { CDPClient, discoverBrowserWsUrl } from '../cdp.js';
import { allocatePort } from '../chrome.js';
import type { BrowserProfile } from '../types.js';

export interface SSHConnection {
  cdp: CDPClient;
  port: number;
  pid: number;
  cleanup: () => void;
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
  const host = url.hostname;
  const remotePort = parseInt(url.searchParams.get('port') || '9222', 10);
  const localPort = allocatePort();

  try {
    await ensureRemoteBrowser(user, host, profile.browser, remotePort, profile.binary);
  } catch {
    // Browser may already be running, continue
  }

  const tunnel = await startSSHTunnel(user, host, localPort, remotePort);

  try {
    await waitForPort(localPort, 8000);
  } catch {
    tunnel.kill();
    throw new Error(`SSH tunnel failed to establish to ${host}`);
  }

  const wsUrl = await discoverBrowserWsUrl(localPort);
  const cdp = new CDPClient();
  await cdp.connect(wsUrl);

  return {
    cdp,
    port: localPort,
    pid: tunnel.pid || 0,
    cleanup: () => {
      cdp.close();
      tunnel.kill();
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
    chrome: '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome',
    comet: '/Applications/Comet.app/Contents/MacOS/Comet',
    chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    brave: '/Applications/Brave\\ Browser.app/Contents/MacOS/Brave\\ Browser',
    edge: '/Applications/Microsoft\\ Edge.app/Contents/MacOS/Microsoft\\ Edge',
  };

  let browserPath: string;
  if (customBinary) {
    browserPath = customBinary.replace(/ /g, '\\ ');
  } else if (browserType === 'custom') {
    throw new Error('browser: custom requires a binary path in the profile');
  } else {
    browserPath = browserPaths[browserType];
    if (!browserPath) {
      throw new Error(`Unknown browser type: ${browserType}`);
    }
  }

  const remoteCmd = `${browserPath} --remote-debugging-port=${port} '--remote-allow-origins=*' --disable-background-timer-throttling --user-data-dir=/tmp/agents-browser-${port} </dev/null >/dev/null 2>&1 &`;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
