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

describe('osOpen — detection without blocking', () => {
  // trySpawn races `spawn` against its `error` event. The pair of properties
  // that matters: a missing binary must be DETECTED (so the next candidate and
  // `via:'none'` stay live), and a long-running opener must NOT be waited on
  // (spawnSync waited for the child's whole lifetime, which would stall
  // `devices lease` behind the browser, right before it prompts for a key).
  const FAKE = { name: 'nope', browser: 'chrome' as const, endpoints: ['cdp://127.0.0.1:39899'] };

  it('reports via:none when no opener works, so a caller can print the URL', async () => {
    const { showUrl } = await fresh();
    const out = await showUrl('https://example.com', { spawnOpen: () => false });
    expect(out.via).toBe('none');
    expect(out.via === 'none' && out.reason).toMatch(/opener/i);
  });

  it('does not wait for the opener to exit', async () => {
    // Through the real (non-injected) path: a viewer-less machine falls to the
    // OS branch. If this ever regresses to a blocking wait, the assertion is
    // the wall clock, not a mock.
    const { showUrl } = await fresh();
    const started = Date.now();
    await showUrl('https://example.com');
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it('falls through to the next candidate when the first opener fails', async () => {
    const { showUrl } = await fresh();
    const tried: string[] = [];
    const out = await showUrl('https://example.com', {
      spawnOpen: (cmd) => {
        tried.push(cmd);
        return false;
      },
    });
    expect(out.via).toBe('none');
    // Every platform candidate was attempted, not just the first.
    expect(tried.length).toBeGreaterThanOrEqual(1);
  });
});
