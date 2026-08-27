/**
 * `agents setup browser` — the non-interactive path must NEVER mint a profile
 * (PHNX-3296). Before this, a headless / non-TTY `agents setup browser` on a box
 * with no default silently auto-detected an installed browser and created an
 * `auto-chrome` — the exact "logged-out chrome appeared unbidden" bug. It must
 * now recognize an existing profile but otherwise defer to the fleet hub.
 *
 * Real critical path: `runBrowserWizard` runs for real against a temp
 * device-config store; only the TTY probe and the OS/browser-discovery + state
 * I/O boundary are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrowserProfileConfig } from '../lib/types.js';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-setup-browser-test-'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Force the non-interactive path — this is the headless-worker scenario.
vi.mock('./utils.js', async () => {
  const actual = await vi.importActual<typeof import('./utils.js')>('./utils.js');
  return { ...actual, isInteractiveTerminal: () => false };
});

vi.mock('../lib/state.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/state.js')>('../lib/state.js');
  return {
    ...actual,
    getBrowserRuntimeDir: () => path.join(TEST_ROOT, 'browser-runtime'),
    getUserAgentsDir: () => path.join(TEST_ROOT, '.agents'),
    withMetaLock: (fn: () => unknown) => fn(),
    readMeta: vi.fn(() => ({ browser: {}, deviceBrowser: {} })),
    writeMeta: vi.fn(),
    updateMeta: vi.fn(),
    getDevicesAutoLaunchPath: () => path.join(TEST_ROOT, 'auto-launch.json'),
    getDevicesIgnoredPath: () => path.join(TEST_ROOT, 'ignored.json'),
    getDevicePinsPath: () => path.join(TEST_ROOT, 'pins.json'),
  };
});

vi.mock('../lib/browser/chrome.js', () => ({
  listInstalledBrowsers: vi.fn(() => [{ browserType: 'chrome', binary: CHROME }]),
  findBrowserPath: vi.fn(() => CHROME),
  findFirstInstalledBrowser: vi.fn(() => ({ browserType: 'chrome', binary: CHROME })),
  isPortInUse: vi.fn(() => false),
}));

vi.mock('../lib/browser/registry.js', async () => {
  const state = await import('../lib/state.js');
  const { machineId } = await import('../lib/machine-id.js');
  const build = () => {
    const meta = state.readMeta() as {
      browser?: Record<string, BrowserProfileConfig>;
      deviceBrowser?: Record<string, BrowserProfileConfig>;
    };
    const profiles = { ...meta.browser, ...meta.deviceBrowser };
    return new Map(
      Object.entries(profiles).map(([name, config]) => [name, [{ device: machineId(), config }]]),
    );
  };
  return {
    profileRegistry: vi.fn(build),
    declaringDevices: vi.fn((name: string) => (build().has(name) ? [machineId()] : [])),
    profileKind: vi.fn((name: string) => (build().has(name) ? 'identity' : null)),
  };
});

import { runBrowserWizard } from './setup-browser.js';
import { readMeta, writeMeta } from '../lib/state.js';
import { findFirstInstalledBrowser } from '../lib/browser/chrome.js';

type Store = { browser: Record<string, BrowserProfileConfig>; deviceBrowser?: Record<string, BrowserProfileConfig> };

function wireStore(store: Store): void {
  vi.mocked(readMeta).mockImplementation(() => store as any);
  vi.mocked(writeMeta).mockImplementation((meta: any) => {
    store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
    store.deviceBrowser = (meta.deviceBrowser ?? {}) as Record<string, BrowserProfileConfig>;
  });
}

describe('runBrowserWizard non-interactive (PHNX-3296)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('never creates a profile with no default — defers to the fleet hub, returns false', async () => {
    const store: Store = { browser: {}, deviceBrowser: {} };
    wireStore(store);
    const writeSpy = vi.mocked(writeMeta);

    const ok = await runBrowserWizard();

    expect(ok).toBe(false);
    // The crux: no profile minted even though a browser is installed.
    expect(writeSpy).not.toHaveBeenCalled();
    expect(findFirstInstalledBrowser).not.toHaveBeenCalled();
    expect(store.deviceBrowser).toEqual({});
  });

  it('recognizes an existing auto-chrome without re-creating it', async () => {
    const store: Store = {
      browser: {},
      deviceBrowser: { 'auto-chrome': { browser: 'chrome', binary: CHROME, endpoints: ['cdp://127.0.0.1:9222'] } },
    };
    wireStore(store);
    const writeSpy = vi.mocked(writeMeta);

    const ok = await runBrowserWizard();

    expect(ok).toBe(true);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
