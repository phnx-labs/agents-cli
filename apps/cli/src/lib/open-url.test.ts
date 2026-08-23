import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Drives the REAL viewer policy against a real profile store under a temp HOME.
// Nothing here spawns a browser or an OS opener: the OS branch goes through the
// injected `spawnOpen`, and the profile branch is never reached in these cases
// (or is asserted only up to the routing decision via resolveViewer).

let testHome = '';

async function fresh() {
  vi.resetModules();
  const openUrl = await import('./open-url.js');
  const profiles = await import('./browser/profiles.js');
  const config = await import('./device-config.js');
  return { ...openUrl, ...profiles, ...config };
}

const CHROME = {
  name: 'work',
  browser: 'chrome' as const,
  binary: process.execPath,
  // NOT 9222: that is the standard Chrome debug port, and a test that dials it
  // can attach to a real browser on the developer's machine.
  endpoints: ['cdp://127.0.0.1:39871'],
};

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-viewer-'));
  process.env.HOME = testHome;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
});

afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  vi.restoreAllMocks();
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('resolveViewer', () => {
  it('falls back to the OS handler when no profile is configured at all', async () => {
    const { resolveViewer } = await fresh();
    expect(await resolveViewer()).toBe('os');
  });

  it('follows browser.profile when browser.viewer is unset — the whole point', async () => {
    // The original bug: a machine with a configured browser still leaked every
    // artifact to the OS handler. Unset viewer must mean "the profile agents drive".
    const { createProfile, setConfigValue, resolveViewer } = await fresh();
    await createProfile(CHROME);
    setConfigValue('browser.profile', 'work');

    expect(await resolveViewer()).toEqual({ profile: 'work' });
  });

  it('browser.viewer overrides browser.profile', async () => {
    const { createProfile, setConfigValue, resolveViewer } = await fresh();
    await createProfile(CHROME);
      await createProfile({ ...CHROME, name: 'reading', endpoints: ['cdp://127.0.0.1:39872'] });
    setConfigValue('browser.profile', 'work');
    setConfigValue('browser.viewer', 'reading');

    expect(await resolveViewer()).toEqual({ profile: 'reading' });
  });

  it('browser.viewer=os opts out entirely', async () => {
    const { createProfile, setConfigValue, resolveViewer } = await fresh();
    await createProfile(CHROME);
    setConfigValue('browser.profile', 'work');
    setConfigValue('browser.viewer', 'os');

    expect(await resolveViewer()).toBe('os');
  });

  it('the osBrowser option beats a configured viewer', async () => {
    // If this ever stops winning, a caller that explicitly asked for the user's
    // own browser silently gets the agent profile instead.
    const { createProfile, setConfigValue, resolveViewer } = await fresh();
    await createProfile(CHROME);
    setConfigValue('browser.viewer', 'work');

    expect(await resolveViewer({ osBrowser: true })).toBe('os');
  });

  it('refuses Arc and says so — it is configurable but not drivable', async () => {
    const { createProfile, setConfigValue, resolveViewer } = await fresh();
    await createProfile({ ...CHROME, name: 'arcy', browser: 'arc' });
    setConfigValue('browser.viewer', 'arcy');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await resolveViewer()).toBe('os');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Arc'));
  });

  it('falls back loudly, never silently, when the named profile does not exist', async () => {
    const { setConfigValue, resolveViewer } = await fresh();
    setConfigValue('browser.viewer', 'ghost');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await resolveViewer()).toBe('os');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('ghost'));
  });
});

describe('showFile — which kinds a browser tab is right for', () => {
  const opened: string[][] = [];
  const spawnOpen = (cmd: string, args: string[]) => {
    opened.push([cmd, ...args]);
    return true;
  };

  beforeEach(() => {
    opened.length = 0;
  });

  it('sends a screenshot to the OS app, not a CDP tab', async () => {
    // Preview/QuickTime are the better viewer for these; a browser tab is a
    // downgrade. EXT_KIND in sessions-list.ts is png/jpg/webp/pdf/webm.
    const { createProfile, setConfigValue, showFile } = await fresh();
    await createProfile(CHROME);
    setConfigValue('browser.viewer', 'work');

    for (const ext of ['.png', '.jpg', '.webp', '.pdf', '.webm']) {
      const out = await showFile(`/tmp/capture${ext}`, { spawnOpen });
      expect(out.via, `${ext} should go to the OS app`).toBe('os');
    }
  });

  it('tries the viewer for an .html artifact, and says so when it cannot reach it', async () => {
    // With no daemon reachable the profile attempt FALLS BACK to the OS handler
    // — that is correct, and it is why this asserts the attempt rather than the
    // absence of an OS open. The stderr line names the profile, so it is proof
    // the .html went to the viewer branch; a .png never produces one.
    const { createProfile, setConfigValue, showFile } = await fresh();
    await createProfile(CHROME);
    setConfigValue('browser.viewer', 'work');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await showFile('/tmp/plan.html', { spawnOpen });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('work'));

    err.mockClear();
    await showFile('/tmp/capture.png', { spawnOpen });
    expect(err).not.toHaveBeenCalled();
  });

  it('with no viewer configured, an .html still opens — via the OS handler', async () => {
    const { showFile } = await fresh();
    const out = await showFile('/tmp/plan.html', { spawnOpen });
    expect(out.via).toBe('os');
  });

  it('reports via:none when every opener fails, so the caller can print the URL', async () => {
    const { showUrl } = await fresh();
    const out = await showUrl('https://example.com', { spawnOpen: () => false });
    expect(out.via).toBe('none');
  });
});
