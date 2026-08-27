/**
 * `maybePickBrowserProfile` — the `agents setup` browser pick (PHNX-3296).
 *
 * Real critical path: only the interactive prompt is injected (there is no TTY
 * under vitest). Everything the pick actually does — `createProfile` and
 * `setConfigValue('browser.profile', …)` — runs for real against a temp
 * device-config store, exactly as it would on a machine. The unit under test is
 * NOT mocked; only the OS/browser-discovery and state boundaries are, the same
 * seam profiles.test.ts uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrowserProfileConfig } from '../lib/types.js';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-setup-pick-test-'));

// Spread the REAL state module (setup-preferences pulls in modules that touch
// many of its exports) and override only the dirs + the meta sink, so the
// profile write and the browser.profile config write land in a temp tree.
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

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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

import { maybePickBrowserProfile } from './setup-preferences.js';
import { readMeta, writeMeta, updateMeta } from '../lib/state.js';
import { getConfigValue } from '../lib/device-config.js';

type Store = { browser: Record<string, BrowserProfileConfig>; deviceBrowser?: Record<string, BrowserProfileConfig> };

function wireStore(store: Store): void {
  vi.mocked(readMeta).mockImplementation(() => store as any);
  vi.mocked(writeMeta).mockImplementation((meta: any) => {
    store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
    store.deviceBrowser = (meta.deviceBrowser ?? {}) as Record<string, BrowserProfileConfig>;
  });
  vi.mocked(updateMeta).mockImplementation((updates: any) => {
    const meta = vi.mocked(readMeta)() as any;
    const next = typeof updates === 'function' ? updates(meta) : { ...meta, ...updates };
    vi.mocked(writeMeta)(next);
    return next;
  });
}

describe('maybePickBrowserProfile (PHNX-3296)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No carried-over device default between tests.
    fs.rmSync(path.join(TEST_ROOT, '.agents', 'devices'), { recursive: true, force: true });
  });

  it('interactive pick creates the profile and sets it as this machine default', async () => {
    const store: Store = { browser: {}, deviceBrowser: {} };
    wireStore(store);

    const picked = await maybePickBrowserProfile({ interactive: true, select: async () => 'chrome' });

    expect(picked).toBe(true);
    // The profile really landed in THIS machine's store (machine-local map)...
    expect(store.deviceBrowser!['auto-chrome'].browser).toBe('chrome');
    expect(store.deviceBrowser!['auto-chrome'].binary).toBe(CHROME);
    // ...and browser.profile now points at it — the same key `agents browser use` writes.
    expect(getConfigValue('browser.profile').value).toBe('auto-chrome');
  });

  it('picking "None" (the fleet-hub opt-out) creates nothing and sets no default', async () => {
    const store: Store = { browser: {}, deviceBrowser: {} };
    wireStore(store);
    const writeSpy = vi.mocked(writeMeta);

    // The opt-out choice carries the SKIP sentinel.
    const picked = await maybePickBrowserProfile({ interactive: true, select: async () => '__skip__' });

    expect(picked).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(getConfigValue('browser.profile').value).toBeUndefined();
  });

  it('non-interactive setup never prompts and never creates', async () => {
    const store: Store = { browser: {}, deviceBrowser: {} };
    wireStore(store);
    const writeSpy = vi.mocked(writeMeta);
    const select = vi.fn(async () => 'chrome');

    const picked = await maybePickBrowserProfile({ interactive: false, select });

    expect(picked).toBe(false);
    // The prompt is never shown and nothing is written — a headless box relies on the hub.
    expect(select).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(getConfigValue('browser.profile').value).toBeUndefined();
  });
});
