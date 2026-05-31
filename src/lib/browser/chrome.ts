import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getProfileRuntimeDir } from './profiles.js';
import { discoverBrowserWsUrl, registerPipeTransport } from './cdp.js';
import { readAndResolveBundleEnv, bundleExists } from '../secrets/bundles.js';
import { writeProfileRuntime, readProfileRuntime } from './runtime-state.js';
import type { ChromeOptions } from './types.js';
import type { Readable, Writable } from 'stream';

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

// Per-platform Chromium-family priority list for "no --profile" auto-pick.
// Order is: most-likely-installed-and-stable first. Safari and Firefox are
// intentionally excluded — they don't speak the Chrome DevTools Protocol the
// way cdp.ts expects, so they'd need separate drivers.
const DEFAULT_BROWSER_PRIORITY: Record<string, BrowserType[]> = {
  // macOS: Chrome leads (>70% of dev machines), then the rest of the family.
  darwin: ['chrome', 'brave', 'edge', 'chromium', 'comet'],
  // Linux: Chrome/Chromium first (apt/snap), then Brave/Edge if present.
  linux: ['chrome', 'chromium', 'brave', 'edge'],
  // Windows: Edge is preinstalled on every supported build, so it's the
  // reliable always-there default.
  win32: ['edge', 'chrome', 'brave'],
};

/**
 * Walk the per-platform priority list and return the first browser that's
 * actually installed on disk. Returns null if none of them are present.
 *
 * This is the auto-pick the `agents browser start` command uses when the user
 * doesn't pass `--profile`. The intent matches "use whatever's preinstalled,"
 * but constrained to Chromium-family binaries so CDP works without a new
 * driver layer.
 */
export function findFirstInstalledBrowser(
  platform: string = os.platform()
): { browserType: BrowserType; binary: string } | null {
  const priority = DEFAULT_BROWSER_PRIORITY[platform];
  if (!priority) return null;
  const platformPaths = BROWSER_PATHS[platform];
  if (!platformPaths) return null;
  for (const browserType of priority) {
    const candidates = platformPaths[browserType] || [];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return { browserType, binary: p };
      }
    }
  }
  return null;
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
  customBinary?: string,
  // `electron: true` distinguishes Notion / VS Code-style apps from
  // regular Chrome — purely informational, stored in meta.json so the
  // orphan reaper and `agents browser status` can label processes.
  isElectron: boolean = false
): Promise<LaunchResult> {
  const browserPath = findBrowserPath(browserType, customBinary);

  const runtimeDir = getProfileRuntimeDir(profileName);
  const userDataDir = path.join(runtimeDir, 'chrome-data');
  fs.mkdirSync(userDataDir, { recursive: true });

  // First-launch seed: stamp the user-data-dir's Default/Preferences with
  // the agents-cli profile name so Chromium's UI shows "<profile>" instead
  // of its default "Person 1". Done only when the file doesn't exist —
  // subsequent launches inherit whatever Chrome wrote in the meantime.
  seedDefaultProfileName(userDataDir, profileName);

  // Chromium on macOS coordinates instances via the SingletonLock file
  // *inside* each user-data-dir. Direct binary spawn with a fresh
  // --user-data-dir creates a fully independent process — the user's
  // normal browser (running under their default user-data-dir) and our
  // sandboxed one coexist as two real processes. The macOS Dock collapses
  // them into one icon per .app bundle, which makes it look like a single
  // instance, but `ps -ww` will show both.

  const viewport = options.viewport ?? { width: 1512, height: 982 };
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // First-run + default-browser modals block automation: when targetFilter
    // matches by URL, the onboarding page (`chrome://welcome/`) isn't a
    // match and start fails with "no page target". Suppress them.
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DefaultBrowserSetting,ChromeWhatsNewUI',
    '--disable-crash-reporter',
    ...(options.headless ? ['--headless=new'] : []),
    `--window-size=${viewport.width},${viewport.height}`,
    ...(viewport.x !== undefined && viewport.y !== undefined
      ? [`--window-position=${viewport.x},${viewport.y}`]
      : []),
    ...(options.args || []),
  ];

  let env: NodeJS.ProcessEnv = { ...process.env };
  if (secrets && bundleExists(secrets)) {
    try {
      const { env: bundleEnv } = readAndResolveBundleEnv(secrets, { caller: 'browser profile' });
      env = { ...env, ...bundleEnv };
    } catch {
      // Bundle failed to resolve, continue without secrets
    }
  }

  const child = spawn(browserPath, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    env,
  });
  child.unref();
  child.stdout?.resume();
  child.stderr?.resume();

  const pid = child.pid!;
  const writePipe = child.stdio[3] as Writable | null;
  const readPipe = child.stdio[4] as Readable | null;
  if (!writePipe || !readPipe) {
    throw new Error('Chrome failed to expose CDP pipe file descriptors');
  }
  const wsUrl = registerPipeTransport({ read: readPipe, write: writePipe });

  writeProfileRuntime(profileName, {
    pid,
    command: path.basename(browserPath),
    userDataDir,
    kind: isElectron ? 'electron' : 'browser',
  });

  return { pid, port: 0, wsUrl };
}

export async function attachToChrome(port: number): Promise<string> {
  const { wsUrl } = await discoverBrowserWsUrl(port);
  return wsUrl;
}

export function killChrome(pid: number): void {
  try {
    process.kill(pid, 'SIGINT');
  } catch {
    // Process already dead
  }
}

export function getRunningChromeInfo(
  profileName: string
): { pid: number; port: number } | null {
  // Delegate to runtime-state, which auto-cleans stale files and verifies
  // the live pid still runs the command we recorded — so a recycled pid
  // doesn't masquerade as our browser.
  const rt = readProfileRuntime(profileName);
  if (!rt) return null;
  if (rt.port === undefined) return null;
  return { pid: rt.pid, port: rt.port };
}

/**
 * Stamp `<userDataDir>/Default/Preferences` with our profile name so
 * Chrome's UI labels the window with the agents-cli name rather than the
 * default "Person 1". Only writes when the file is absent (first launch).
 * Best-effort: any I/O hiccup is silently ignored; missing the rename is
 * cosmetic, not functional.
 */
function seedDefaultProfileName(userDataDir: string, profileName: string): void {
  const defaultDir = path.join(userDataDir, 'Default');
  const prefsPath = path.join(defaultDir, 'Preferences');
  if (fs.existsSync(prefsPath)) return;
  try {
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(
      prefsPath,
      JSON.stringify({ profile: { name: profileName } })
    );
  } catch { /* not critical */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function allocatePort(): number {
  const base = 9200;
  const max = 9300;

  for (let port = base; port < max; port++) {
    try {
      execFileSync('lsof', ['-i', `:${port}`], { stdio: 'ignore' });
    } catch {
      return port;
    }
  }

  throw new Error('No available ports in range 9200-9300');
}

export interface PortOccupant {
  pid: number;
  command: string;
}

/**
 * Identify the process listening on a TCP port via lsof. Returns null when nothing is bound.
 * Used for clearer error messages when a profile's configured port is taken by a non-debug
 * process (e.g. Comet running without --remote-debugging-port).
 */
export function getPortOccupant(port: number): PortOccupant | null {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let pid = 0;
    let command = '';
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = parseInt(line.slice(1), 10) || 0;
      else if (line.startsWith('c') && !command) command = line.slice(1);
    }
    if (!pid) return null;
    return { pid, command: command || 'unknown' };
  } catch {
    return null;
  }
}
