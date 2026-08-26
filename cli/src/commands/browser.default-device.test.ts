import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Exercises the fleet browser hub (`browser.device`) resolution through the REAL
// device-config layer — no mocks — so the sync scope and the self/fleet-remote
// short-circuits are checked as they actually behave. machineId is pinned to
// `testbox` via AGENTS_SYNC_MACHINE_ID (same lever browser.use.test.ts uses).

let testHome = '';

async function freshBrowserModules() {
  vi.resetModules();
  const browser = await import('./browser.js');
  const config = await import('../lib/device-config.js');
  return { ...browser, ...config };
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-browser-hub-'));
  process.env.HOME = testHome;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  delete process.env.AGENTS_FLEET_REMOTE;
});

afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  delete process.env.AGENTS_FLEET_REMOTE;
  vi.restoreAllMocks();
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('defaultBrowserHub', () => {
  it('is undefined when browser.device is unset (drive locally)', async () => {
    const { defaultBrowserHub } = await freshBrowserModules();
    expect(defaultBrowserHub()).toBeUndefined();
  });

  it('returns the configured hub when it is a different device', async () => {
    const { defaultBrowserHub, setConfigValue } = await freshBrowserModules();
    setConfigValue('browser.device', 'mac-mini');
    expect(defaultBrowserHub()).toBe('mac-mini');
  });

  it('short-circuits to undefined when the hub IS this machine (the hub drives locally)', async () => {
    const { defaultBrowserHub, setConfigValue } = await freshBrowserModules();
    // AGENTS_SYNC_MACHINE_ID pins machineId to `testbox`, so a hub named `testbox`
    // is self — the single synced value is safe precisely because the hub ignores it.
    setConfigValue('browser.device', 'testbox');
    expect(defaultBrowserHub()).toBeUndefined();
  });

  it('short-circuits to undefined on a fleet-remote invocation (no re-forward loop)', async () => {
    const { defaultBrowserHub, setConfigValue } = await freshBrowserModules();
    setConfigValue('browser.device', 'mac-mini');
    process.env.AGENTS_FLEET_REMOTE = '1';
    expect(defaultBrowserHub()).toBeUndefined();
  });

  it('is a user-scope key, so it lands in the fleet-synced central config block', async () => {
    const { setConfigValue, getConfigValue } = await freshBrowserModules();
    setConfigValue('browser.device', 'mac-mini');
    // Re-read through a fresh module graph: a user-scope value round-trips via the
    // central agents.yaml store that `agents repo push/pull` syncs fleet-wide.
    const { getConfigValue: reread } = await freshBrowserModules();
    expect(reread('browser.device').value).toBe('mac-mini');
    expect(getConfigValue('browser.device').value).toBe('mac-mini');
  });

  it('rejects an invalid device name', async () => {
    const { setConfigValue } = await freshBrowserModules();
    expect(() => setConfigValue('browser.device', 'Not A Device!')).toThrow();
  });

  it('surfaces the configured hub in `agents browser use` status', async () => {
    const { runBrowserUse, setConfigValue } = await freshBrowserModules();
    setConfigValue('browser.device', 'mac-mini');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runBrowserUse(undefined, {}, false)).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Browser hub (browser.device): mac-mini'),
    );
  });
});
