import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getProfileRuntimeDir } from './profiles.js';
import { discoverBrowserWsUrl } from './cdp.js';
import { readBundle, resolveBundleEnv, bundleExists } from '../secrets/bundles.js';
import type { ChromeOptions } from './types.js';

import type { BrowserType } from './types.js';

const BROWSER_PATHS: Record<string, Record<BrowserType, string[]>> = {
  darwin: {
    chrome: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ],
    comet: ['/Applications/Comet.app/Contents/MacOS/Comet'],
    chromium: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
    brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    custom: [],
  },
  linux: {
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
    comet: [],
    chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    brave: ['/usr/bin/brave-browser', '/usr/bin/brave'],
    edge: ['/usr/bin/microsoft-edge'],
    custom: [],
  },
  win32: {
    chrome: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    comet: [],
    chromium: [],
    brave: [
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
    edge: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    custom: [],
  },
};


export function findBrowserPath(browserType: BrowserType, customBinary?: string): string {
  if (customBinary) {
    if (!fs.existsSync(customBinary)) {
      throw new Error(`Custom binary not found: ${customBinary}`);
    }
    return customBinary;
  }

  if (browserType === 'custom') {
    throw new Error('browser: custom requires a binary path in the profile');
  }

  const platform = os.platform();
  const platformPaths = BROWSER_PATHS[platform];
  if (!platformPaths) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const candidates = platformPaths[browserType] || [];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error(`Browser "${browserType}" not found. Install it first.`);
}

export interface LaunchResult {
  pid: number;
  port: number;
  wsUrl: string;
}

export async function launchBrowser(
  profileName: string,
  browserType: BrowserType,
  port: number,
  options: ChromeOptions = {},
  secrets?: string,
  customBinary?: string
): Promise<LaunchResult> {
  const browserPath = findBrowserPath(browserType, customBinary);

  const runtimeDir = getProfileRuntimeDir(profileName);
  const userDataDir = path.join(runtimeDir, 'chrome-data');
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--remote-allow-origins=*',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    ...(options.headless ? ['--headless=new'] : []),
    ...(options.args || []),
  ];

  let env: NodeJS.ProcessEnv = { ...process.env };
  if (secrets && bundleExists(secrets)) {
    try {
      const bundle = readBundle(secrets);
      const bundleEnv = resolveBundleEnv(bundle);
      env = { ...env, ...bundleEnv };
    } catch {
      // Bundle failed to resolve, continue without secrets
    }
  }

  const child = spawn(browserPath, args, {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();

  const pid = child.pid!;
  fs.writeFileSync(path.join(runtimeDir, 'pid'), String(pid));
  fs.writeFileSync(path.join(runtimeDir, 'port'), String(port));

  let wsUrl: string | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    try {
      wsUrl = await discoverBrowserWsUrl(port);
      break;
    } catch {
      // Chrome still starting
    }
  }

  if (!wsUrl) {
    throw new Error('Chrome failed to start within 6 seconds');
  }

  return { pid, port, wsUrl };
}

export async function attachToChrome(port: number): Promise<string> {
  return discoverBrowserWsUrl(port);
}

export function killChrome(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process already dead
  }
}

export function getRunningChromeInfo(
  profileName: string
): { pid: number; port: number } | null {
  const runtimeDir = getProfileRuntimeDir(profileName);
  const pidFile = path.join(runtimeDir, 'pid');
  const portFile = path.join(runtimeDir, 'port');

  if (!fs.existsSync(pidFile) || !fs.existsSync(portFile)) {
    return null;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  const port = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10);

  if (!isProcessRunning(pid)) {
    fs.unlinkSync(pidFile);
    fs.unlinkSync(portFile);
    return null;
  }

  return { pid, port };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function allocatePort(): number {
  const base = 9200;
  const max = 9300;

  for (let port = base; port < max; port++) {
    try {
      execSync(`lsof -i :${port}`, { stdio: 'ignore' });
    } catch {
      return port;
    }
  }

  throw new Error('No available ports in range 9200-9300');
}
