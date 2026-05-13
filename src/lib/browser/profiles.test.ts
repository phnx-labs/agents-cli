import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../state.js', () => ({
  getBrowserRuntimeDir: vi.fn(() => '/tmp/agents-browser-test'),
  readMeta: vi.fn(() => ({ browser: {} })),
  writeMeta: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('./chrome.js', () => ({
  findBrowserPath: vi.fn(() => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
}));

import { extractConfiguredPort, findFreeProfilePort, createProfile } from './profiles.js';
import type { BrowserProfile } from './types.js';
import type { BrowserProfileConfig } from '../types.js';
import { readMeta, writeMeta } from '../state.js';
import { execSync } from 'child_process';

function profile(endpoints: string[]): BrowserProfile {
  return { name: 'test', browser: 'chrome', endpoints };
}

describe('extractConfiguredPort', () => {
  it('extracts explicit port from cdp://', () => {
    expect(extractConfiguredPort(profile(['cdp://localhost:9333']))).toBe(9333);
  });

  it('extracts explicit port from ssh:// with ?port=', () => {
    expect(extractConfiguredPort(profile(['ssh://mac-mini:9444']))).toBe(9444);
  });

  it('defaults to 9222 for cdp:// without explicit port', () => {
    expect(extractConfiguredPort(profile(['cdp://localhost']))).toBe(9222);
  });

  it('defaults to 9222 for ssh:// without explicit port', () => {
    expect(extractConfiguredPort(profile(['ssh://mac-mini']))).toBe(9222);
  });

  it('extracts port from ws:// and wss://', () => {
    expect(extractConfiguredPort(profile(['ws://example.com:9555']))).toBe(9555);
    expect(extractConfiguredPort(profile(['wss://example.com:9666']))).toBe(9666);
  });

  it('returns undefined for endpoint with no port and no default', () => {
    expect(extractConfiguredPort(profile(['ws://example.com']))).toBeUndefined();
  });

  it('returns undefined when endpoints empty', () => {
    expect(extractConfiguredPort(profile([]))).toBeUndefined();
  });

  it('returns undefined for malformed endpoint', () => {
    expect(extractConfiguredPort(profile(['not-a-url']))).toBeUndefined();
  });

  it('uses only the first endpoint', () => {
    expect(
      extractConfiguredPort(profile(['cdp://localhost:9001', 'cdp://localhost:9002']))
    ).toBe(9001);
  });
});

describe('profile YAML round-trip', () => {
  // configToProfile / profileToConfig are internal, but createProfile calls
  // writeMeta(config) and getProfile/listProfiles run configToProfile(config).
  // Round-tripping through that pair is the production code path.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves electron / binary / targetFilter through write -> read', async () => {
    const store: { browser: Record<string, BrowserProfileConfig> } = { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      // Persist exactly what createProfile passes — this mirrors disk YAML.
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
    });

    const input: BrowserProfile = {
      name: 'canva',
      browser: 'custom',
      binary: '/Applications/Canva.app/Contents/MacOS/Canva',
      electron: true,
      targetFilter: 'url:https://www.canva.com/',
      endpoints: ['cdp://127.0.0.1:9201'],
    };

    await createProfile(input);

    const stored = store.browser['canva'];
    expect(stored.browser).toBe('custom');
    expect(stored.binary).toBe('/Applications/Canva.app/Contents/MacOS/Canva');
    expect(stored.electron).toBe(true);
    expect(stored.targetFilter).toBe('url:https://www.canva.com/');

    // And on the read side — configToProfile must not silently drop the field
    // (regression guard: someone could remove it from configToProfile and the
    // value would survive YAML but be undefined at runtime).
    const { listProfiles } = await import('./profiles.js');
    const [restored] = await listProfiles();
    expect(restored.binary).toBe(input.binary);
    expect(restored.electron).toBe(true);
    expect(restored.targetFilter).toBe(input.targetFilter);
  });

  it('does not write electron/binary/targetFilter when they are unset', async () => {
    const store: { browser: Record<string, BrowserProfileConfig> } = { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
    });

    await createProfile({
      name: 'plain',
      browser: 'chrome',
      endpoints: ['cdp://127.0.0.1:9301'],
    });

    const stored = store.browser['plain'];
    expect('binary' in stored).toBe(false);
    expect('electron' in stored).toBe(false);
    expect('targetFilter' in stored).toBe(false);
  });
});

describe('findFreeProfilePort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips profile-owned ports and returns first unowned free port', async () => {
    // Profiles occupy 9222–9225
    vi.mocked(readMeta).mockReturnValue({
      browser: {
        'p1': { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] },
        'p2': { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9223'] },
        'p3': { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9224'] },
        'p4': { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9225'] },
      },
    } as any);
    // All OS ports are free (execSync throws = nothing listening)
    vi.mocked(execSync).mockImplementation(() => { throw new Error('no process'); });

    const port = await findFreeProfilePort();
    expect(port).toBe(9226);
  });

  it('skips OS-in-use ports and returns first OS-free port', async () => {
    // No profiles
    vi.mocked(readMeta).mockReturnValue({ browser: {} } as any);
    // 9222 is in use on the OS (execSync succeeds = something listening)
    // 9223 is free (execSync throws)
    vi.mocked(execSync).mockImplementation((_cmd: any) => {
      const cmd = String(_cmd);
      if (cmd.includes(':9222')) return '' as any;
      throw new Error('no process');
    });

    const port = await findFreeProfilePort();
    expect(port).toBe(9223);
  });
});
