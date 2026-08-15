import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../state.js', () => ({
  getBrowserRuntimeDir: vi.fn(() => '/tmp/agents-browser-test'),
  readMeta: vi.fn(() => ({ browser: {} })),
  writeMeta: vi.fn(),
  // device-config.js (the browser.profile store) reads/writes through these.
  updateMeta: vi.fn(),
  META_HEADER: '',
  getUserAgentsDir: vi.fn(() => '/tmp/agents-browser-test/.agents'),
  getDevicesAutoLaunchPath: vi.fn(() => '/tmp/agents-browser-test/auto-launch.json'),
}));

vi.mock('./chrome.js', () => ({
  findBrowserPath: vi.fn(() => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  findFirstInstalledBrowser: vi.fn(() => ({
    browserType: 'chrome',
    binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  })),
  isPortInUse: vi.fn(() => false),
}));

import {
  extractConfiguredPort,
  extractConfiguredEndpoint,
  findFreeProfilePort,
  createProfile,
  ensureDefaultBrowserProfile,
  formatProfilesTable,
  padColumn,
} from './profiles.js';
import { findBrowserPath, findFirstInstalledBrowser, isPortInUse } from './chrome.js';
import type { BrowserProfile } from './types.js';
import type { BrowserProfileConfig } from '../types.js';
import { readMeta, writeMeta, updateMeta } from '../state.js';
import { machineId } from '../machine-id.js';

/** The configured default profile, fixtured where it really lives: this machine's
 * central fleet.devices.<self>.config block (lib/device-config.ts). */
function withDefaultProfile(store: { browser: Record<string, BrowserProfileConfig> }, name: string) {
  return { ...store, fleet: { devices: { [machineId()]: { config: { defaultBrowserProfile: name } } } } };
}

/**
 * The two profile maps as they sit on disk: `browser` is the fleet-synced
 * agents.yaml block, `deviceBrowser` is this machine's own devices/<name> file.
 */
type ProfileStore = {
  browser: Record<string, BrowserProfileConfig>;
  deviceBrowser?: Record<string, BrowserProfileConfig>;
};

/**
 * Read a written profile from whichever map it landed in. `createProfile` is
 * machine-local by default (RUSH-2716), so a test asserting field round-tripping
 * should not also be asserting the store — the store has its own tests below.
 */
function storedProfile(store: ProfileStore, name: string): BrowserProfileConfig {
  return (store.deviceBrowser?.[name] ?? store.browser[name]) as BrowserProfileConfig;
}

function profile(endpoints: string[]): BrowserProfile {
  return { name: 'test', browser: 'chrome', endpoints };
}

function profileMap(
  endpoints: Record<string, { target: string }>,
  defaultEndpoint?: string
): BrowserProfile {
  return { name: 'test', browser: 'chrome', endpoints, defaultEndpoint };
}

describe('extractConfiguredPort', () => {
  it('extracts explicit port from cdp://', () => {
    expect(extractConfiguredPort(profile(['cdp://localhost:9333']))).toBe(9333);
  });

  it('extracts explicit port from ssh://', () => {
    expect(extractConfiguredPort(profile(['ssh://remote-host:9444']))).toBe(9444);
  });

  it('defaults to 9222 for cdp:// without explicit port', () => {
    expect(extractConfiguredPort(profile(['cdp://localhost']))).toBe(9222);
  });

  it('defaults to 9222 for ssh:// without explicit port', () => {
    expect(extractConfiguredPort(profile(['ssh://remote-host']))).toBe(9222);
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

  it('uses only the first endpoint in legacy array shape', () => {
    expect(
      extractConfiguredPort(profile(['cdp://localhost:9001', 'cdp://localhost:9002']))
    ).toBe(9001);
  });
});

describe('extractConfiguredEndpoint', () => {
  it('normalizes localhost to 127.0.0.1 for cdp://', () => {
    expect(extractConfiguredEndpoint(profile(['cdp://localhost:9333']))).toEqual({
      host: '127.0.0.1',
      port: 9333,
    });
  });

  it('preserves 127.0.0.1 verbatim for cdp://', () => {
    expect(extractConfiguredEndpoint(profile(['cdp://127.0.0.1:9333']))).toEqual({
      host: '127.0.0.1',
      port: 9333,
    });
  });

  it('preserves remote host for ssh://', () => {
    expect(extractConfiguredEndpoint(profile(['ssh://remote-host:9222']))).toEqual({
      host: 'remote-host',
      port: 9222,
    });
  });

  it('strips username from ssh://user@host:port', () => {
    expect(extractConfiguredEndpoint(profile(['ssh://user@remote-host:9222']))).toEqual({
      host: 'remote-host',
      port: 9222,
    });
  });

  it('defaults port to 9222 when omitted for cdp:// and ssh://', () => {
    expect(extractConfiguredEndpoint(profile(['cdp://localhost']))).toEqual({
      host: '127.0.0.1',
      port: 9222,
    });
    expect(extractConfiguredEndpoint(profile(['ssh://remote-host']))).toEqual({
      host: 'remote-host',
      port: 9222,
    });
  });

  it('extracts host:port from ws:// and wss://', () => {
    expect(extractConfiguredEndpoint(profile(['ws://example.com:9555']))).toEqual({
      host: 'example.com',
      port: 9555,
    });
    expect(extractConfiguredEndpoint(profile(['wss://example.com:9666']))).toEqual({
      host: 'example.com',
      port: 9666,
    });
  });

  it('returns undefined for ws:// without an explicit port', () => {
    // Unlike cdp:// / ssh://, ws:// has no implicit default — caller has no
    // way to know which port the remote service listens on.
    expect(extractConfiguredEndpoint(profile(['ws://example.com']))).toBeUndefined();
  });

  it('returns undefined for empty / malformed / missing endpoints', () => {
    expect(extractConfiguredEndpoint(profile([]))).toBeUndefined();
    expect(extractConfiguredEndpoint(profile(['not-a-url']))).toBeUndefined();
  });

  it('uses first entry of legacy string[] shape', () => {
    expect(
      extractConfiguredEndpoint(profile(['cdp://localhost:9001', 'cdp://localhost:9002']))
    ).toEqual({ host: '127.0.0.1', port: 9001 });
  });

  it('uses first entry of map shape when no defaultEndpoint set', () => {
    expect(
      extractConfiguredEndpoint(
        profileMap({
          first: { target: 'cdp://127.0.0.1:9001' },
          second: { target: 'cdp://127.0.0.1:9002' },
        })
      )
    ).toEqual({ host: '127.0.0.1', port: 9001 });
  });

  it('honors defaultEndpoint over insertion order in map shape', () => {
    expect(
      extractConfiguredEndpoint(
        profileMap(
          {
            local: { target: 'cdp://127.0.0.1:9001' },
            remote: { target: 'ssh://remote-host:9222' },
          },
          'remote'
        )
      )
    ).toEqual({ host: 'remote-host', port: 9222 });
  });

  it('falls back to first entry when defaultEndpoint references unknown preset', () => {
    expect(
      extractConfiguredEndpoint(
        profileMap(
          { local: { target: 'cdp://127.0.0.1:9001' } },
          'does-not-exist'
        )
      )
    ).toEqual({ host: '127.0.0.1', port: 9001 });
  });

  it('extracts port from ssh URL even with username and explicit port', () => {
    expect(
      extractConfiguredEndpoint(profile(['ssh://root@mac-studio:18805']))
    ).toEqual({ host: 'mac-studio', port: 18805 });
  });

  it('reads the documented ssh://host?port=N query-string form', () => {
    // Regression: types.ts documents `ssh://host?port=N` as the canonical
    // SSH endpoint shape, but WHATWG URL parsing exposes it via searchParams
    // only — `url.port` is empty. Without the searchParams fallback every
    // `?port=`-style profile silently collapses to 9222.
    expect(
      extractConfiguredEndpoint(profile(['ssh://remote-host?port=18805']))
    ).toEqual({ host: 'remote-host', port: 18805 });
  });

  it('reads ssh://user@host?port=N (query-string form with username)', () => {
    expect(
      extractConfiguredEndpoint(profile(['ssh://user@remote-host?port=18805']))
    ).toEqual({ host: 'remote-host', port: 18805 });
  });

  it('prefers explicit :port over ?port= when both are present', () => {
    expect(
      extractConfiguredEndpoint(profile(['ssh://remote-host:9300?port=18805']))
    ).toEqual({ host: 'remote-host', port: 9300 });
  });

  it('rejects non-numeric ?port= value and falls back to ssh default', () => {
    expect(
      extractConfiguredEndpoint(profile(['ssh://remote-host?port=abc']))
    ).toEqual({ host: 'remote-host', port: 9222 });
  });

  it('returns the same port for cdp://localhost and cdp://127.0.0.1 (collision detection)', () => {
    // Regression guard: two profiles using these two forms point at the same
    // local port and must be detected as conflicting. Normalizing localhost
    // to 127.0.0.1 makes the tuples compare equal.
    const a = extractConfiguredEndpoint(profile(['cdp://localhost:9222']));
    const b = extractConfiguredEndpoint(profile(['cdp://127.0.0.1:9222']));
    expect(a).toEqual(b);
  });
});

describe('profile YAML round-trip', () => {
  // configToProfile / profileToConfig are internal, but createProfile calls
  // writeMeta(config) and getProfile/listProfiles run configToProfile(config).
  // Round-tripping through that pair is the production code path.
  beforeEach(() => {
  // Profile writes go through updateMeta (read-under-lock) rather than a bare
  // writeMeta, so a concurrent write is not clobbered. Its real semantics are
  // exactly readMeta + writeMeta, so delegate — each test's own writeMeta store
  // wiring then keeps working as before.
  vi.mocked(updateMeta).mockImplementation((updates: any) => {
    const meta = vi.mocked(readMeta)() as any;
    const next = typeof updates === 'function' ? updates(meta) : { ...meta, ...updates };
    vi.mocked(writeMeta)(next);
    return next;
  });

    vi.clearAllMocks();
  });

  it('preserves electron / binary / targetFilter through write -> read', async () => {
    const store: ProfileStore = { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      // Persist exactly what createProfile passes — this mirrors disk YAML.
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
      store.deviceBrowser = (meta.deviceBrowser ?? {}) as Record<string, BrowserProfileConfig>;
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

    const stored = storedProfile(store, 'canva');
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
    const store: ProfileStore = { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
      store.deviceBrowser = (meta.deviceBrowser ?? {}) as Record<string, BrowserProfileConfig>;
    });

    await createProfile({
      name: 'plain',
      browser: 'chrome',
      endpoints: ['cdp://127.0.0.1:9301'],
    });

    const stored = storedProfile(store, 'plain');
    expect('binary' in stored).toBe(false);
    expect('electron' in stored).toBe(false);
    expect('targetFilter' in stored).toBe(false);
  });

  it('allows spaces in browser binaries used by ssh endpoints', async () => {
    const store: ProfileStore = { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
      store.deviceBrowser = (meta.deviceBrowser ?? {}) as Record<string, BrowserProfileConfig>;
    });

    await expect(
      createProfile({
        name: 'remote-comet',
        browser: 'custom',
        binary: '/Applications/Comet Beta.app/Contents/MacOS/Comet Beta',
        endpoints: ['ssh://remote-host:9222'],
      })
    ).resolves.toBeUndefined();
    expect(storedProfile(store, 'remote-comet').binary).toBe('/Applications/Comet Beta.app/Contents/MacOS/Comet Beta');
  });

  it('skips local browser binary validation for ssh endpoints', async () => {
    const store: ProfileStore = { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
      store.deviceBrowser = (meta.deviceBrowser ?? {}) as Record<string, BrowserProfileConfig>;
    });

    await createProfile({
      name: 'remote-linux-chrome',
      browser: 'custom',
      binary: '/opt/google/chrome/chrome',
      endpoints: ['ssh://linux-box?port=9222'],
    });

    expect(findBrowserPath).not.toHaveBeenCalled();
    expect(storedProfile(store, 'remote-linux-chrome').binary).toBe('/opt/google/chrome/chrome');
  });

  it('rejects shell metacharacters in browser binaries used by ssh endpoints', async () => {
    const store: ProfileStore = { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);

    await expect(
      createProfile({
        name: 'remote-bad',
        browser: 'custom',
        binary: '/Applications/Comet.app/Contents/MacOS/Comet; touch /tmp/pwned',
        endpoints: ['ssh://remote-host:9222'],
      })
    ).rejects.toThrow(/Remote browser binary contains shell metacharacters/);
  });

  it('rejects shell metacharacters in per-endpoint ssh binary overrides', async () => {
    const store: ProfileStore = { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);

    await expect(
      createProfile({
        name: 'remote-bad-override',
        browser: 'custom',
        endpoints: {
          remote: {
            target: 'ssh://remote-host:9222',
            binary: '/Applications/Comet.app/Contents/MacOS/Comet && say bad',
          },
        },
      })
    ).rejects.toThrow(/Remote browser binary contains shell metacharacters/);
  });
});

describe('ensureDefaultBrowserProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-picks the first installed browser and persists a default profile', async () => {
    const store: ProfileStore =
      { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
      store.deviceBrowser = (meta.deviceBrowser ?? {}) as Record<string, BrowserProfileConfig>;
    });
    vi.mocked(isPortInUse).mockReturnValue(false);

    const profile = await ensureDefaultBrowserProfile();

    expect(profile.name).toBe('default');
    expect(profile.browser).toBe('chrome');
    expect(profile.binary).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(profile.endpoints).toEqual(['cdp://127.0.0.1:9222']);
    // The auto default is machine-specific — an absolute binary path plus a port
    // picked by probing THIS box — so it lands in the per-machine map and never
    // in the fleet-shared one.
    expect(store.deviceBrowser!.default.browser).toBe('chrome');
    expect(store.browser.default).toBeUndefined();
  });

  it('reuses an existing default profile instead of overwriting it', async () => {
    const existing: BrowserProfileConfig = {
      browser: 'brave',
      binary: '/custom/path/to/brave',
      endpoints: ['cdp://127.0.0.1:9333'],
    };
    const store: ProfileStore = { browser: { default: existing } };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    const writeSpy = vi.mocked(writeMeta);

    const profile = await ensureDefaultBrowserProfile();

    expect(profile.browser).toBe('brave');
    expect(profile.binary).toBe('/custom/path/to/brave');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('regenerates a stale default whose binary is missing on this machine', async () => {
    // A `default` auto-created on macOS carries a /Applications/... binary that
    // doesn't exist on this (Linux) box — the top browser roadblock.
    const stale: BrowserProfileConfig = {
      browser: 'custom',
      binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      endpoints: ['cdp://127.0.0.1:9222'],
    };
    // The stale copy arrived from another machine via the SHARED map — that is
    // exactly how a macOS-written default reaches a Linux box.
    const store: ProfileStore =
      { browser: { default: stale } };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
      store.deviceBrowser = (meta.deviceBrowser ?? {}) as Record<string, BrowserProfileConfig>;
    });
    // The stale binary isn't launchable here → findBrowserPath throws for it.
    vi.mocked(findBrowserPath).mockImplementationOnce(() => {
      throw new Error('Custom binary not found: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    });

    const profile = await ensureDefaultBrowserProfile();

    // Re-detected and regenerated in place for THIS machine, not handed back broken.
    expect(profile.name).toBe('default');
    expect(profile.browser).toBe('chrome');
    expect(findFirstInstalledBrowser).toHaveBeenCalled();
    // Regenerated into THIS machine's own map. The shared copy is left alone, so
    // the two boxes stop overwriting each other's binary path on every launch.
    expect(store.deviceBrowser!.default.browser).toBe('chrome');
    expect(store.browser.default.binary).toBe(stale.binary);
  });

  it("falls back to auto-detect when the configured default can't launch here", async () => {
    const store = withDefaultProfile({
      browser: {
        'mac-chrome': {
          browser: 'custom',
          binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          endpoints: ['cdp://127.0.0.1:9333'],
        },
      },
    }, 'mac-chrome');
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
      store.deviceBrowser = (meta.deviceBrowser ?? {}) as Record<string, BrowserProfileConfig>;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(findBrowserPath).mockImplementationOnce(() => {
      throw new Error('Custom binary not found');
    });

    const profile = await ensureDefaultBrowserProfile();

    expect(profile.name).toBe('default');
    expect(profile.browser).toBe('chrome');
    expect(findFirstInstalledBrowser).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("can't launch on this"));
    warn.mockRestore();
  });

  it('reuses a remote (ssh://) configured default without a local binary check', async () => {
    // The browser lives on the far host; there is no local binary to validate.
    const store = withDefaultProfile({
      browser: {
        'zion-comet': { browser: 'comet', endpoints: ['ssh://muqsit@zion?port=9344'] },
      },
    }, 'zion-comet');
    vi.mocked(readMeta).mockImplementation(() => store as any);

    const profile = await ensureDefaultBrowserProfile();

    expect(profile.name).toBe('zion-comet');
    // Remote profiles short-circuit the local binary check entirely.
    expect(findBrowserPath).not.toHaveBeenCalled();
    expect(findFirstInstalledBrowser).not.toHaveBeenCalled();
  });

  it('throws an actionable error when no Chromium-family browser is installed', async () => {
    vi.mocked(readMeta).mockImplementation(() => ({ browser: {} }) as any);
    vi.mocked(findFirstInstalledBrowser).mockReturnValueOnce(null);

    await expect(ensureDefaultBrowserProfile()).rejects.toThrow(
      /No supported browser found.*Chrome.*Brave.*Edge/
    );
  });

  it('returns the configured default profile without auto-detecting', async () => {
    const store = withDefaultProfile({
      browser: { 'comet-local': { browser: 'comet', endpoints: ['cdp://localhost:9333'] } },
    }, 'comet-local');
    vi.mocked(readMeta).mockImplementation(() => store as any);

    const profile = await ensureDefaultBrowserProfile();

    expect(profile.name).toBe('comet-local');
    expect(profile.browser).toBe('comet');
    // The configured default short-circuits the installed-browser auto-detect.
    expect(findFirstInstalledBrowser).not.toHaveBeenCalled();
  });

  it('configured default wins over a literal default profile', async () => {
    const store = withDefaultProfile({
      browser: {
        default: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] },
        'comet-local': { browser: 'comet', endpoints: ['cdp://localhost:9333'] },
      },
    }, 'comet-local');
    vi.mocked(readMeta).mockImplementation(() => store as any);

    const profile = await ensureDefaultBrowserProfile();

    expect(profile.name).toBe('comet-local');
    expect(profile.browser).toBe('comet');
  });

  it('warns and falls back to auto-detect when the configured default is missing', async () => {
    const store = withDefaultProfile({ browser: {} }, 'ghost');
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
      store.deviceBrowser = (meta.deviceBrowser ?? {}) as Record<string, BrowserProfileConfig>;
    });
    vi.mocked(isPortInUse).mockReturnValue(false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const profile = await ensureDefaultBrowserProfile();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ghost'));
    // Fell through to the installed-browser auto-detect (Chrome in this mock).
    expect(profile.name).toBe('default');
    expect(profile.browser).toBe('chrome');
    warnSpy.mockRestore();
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
    // All OS ports are free
    vi.mocked(isPortInUse).mockReturnValue(false);

    const port = await findFreeProfilePort();
    expect(port).toBe(9226);
  });

  it('skips OS-in-use ports and returns first OS-free port', async () => {
    // No profiles
    vi.mocked(readMeta).mockReturnValue({ browser: {} } as any);
    // 9222 is bound on the OS (e.g. the user's own browser running with
    // --remote-debugging-port=9222); 9223 is free
    vi.mocked(isPortInUse).mockImplementation((port: number) => port === 9222);

    const port = await findFreeProfilePort();
    expect(port).toBe(9223);
  });

  it('treats SSH profile ports as occupied locally now that tunnels bind on the same port', async () => {
    // SSH profile points at 9222 on remote-host, but our tunnel will bind
    // local 9222 → remote-host:9222, so the local port is claimed and the
    // allocator must skip it.
    vi.mocked(readMeta).mockReturnValue({
      browser: {
        'ssh-remote': { browser: 'comet', endpoints: ['ssh://remote-host:9222'] },
      },
    } as any);
    vi.mocked(isPortInUse).mockReturnValue(false);

    const port = await findFreeProfilePort();
    expect(port).toBe(9223);
  });
});

describe('createProfile port collision (local-port-scoped)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects two local cdp:// profiles on the same port', async () => {
    const store: ProfileStore = {
      browser: {
        existing: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] },
      },
    };
    vi.mocked(readMeta).mockImplementation(() => store as any);

    await expect(
      createProfile({
        name: 'new',
        browser: 'chrome',
        endpoints: ['cdp://127.0.0.1:9222'],
      })
    ).rejects.toThrow(/Local port 9222 is already used by profile "existing"/);
  });

  it('rejects cdp://127.0.0.1:9222 against ssh://remote-host:9222 because the SSH tunnel binds locally', async () => {
    // After the SSH-tunnel-port change, ssh://host?port=N binds local N too,
    // so cdp://127.0.0.1:N and ssh://host?port=N do collide locally even
    // though their (host, port) tuples differ.
    const store: ProfileStore = {
      browser: {
        remote: { browser: 'comet', endpoints: ['ssh://remote-host:9222'] },
      },
    };
    vi.mocked(readMeta).mockImplementation(() => store as any);

    await expect(
      createProfile({
        name: 'local',
        browser: 'chrome',
        endpoints: ['cdp://127.0.0.1:9222'],
      })
    ).rejects.toThrow(/Local port 9222 is already used by profile "remote"/);
  });

  it('rejects two ssh:// profiles on the same port even across different hosts', async () => {
    // remote-host's 9222 tunnel binds local 9222; mac-studio's tunnel would
    // want local 9222 too. Local resource, single owner.
    const store: ProfileStore = {
      browser: {
        mini: { browser: 'comet', endpoints: ['ssh://remote-host:9222'] },
      },
    };
    vi.mocked(readMeta).mockImplementation(() => store as any);

    await expect(
      createProfile({
        name: 'studio',
        browser: 'comet',
        endpoints: ['ssh://mac-studio:9222'],
      })
    ).rejects.toThrow(/Local port 9222 is already used by profile "mini"/);
  });

  it('allows ssh:// profiles on different ports to the same host', async () => {
    const store: ProfileStore = {
      browser: {
        first: { browser: 'comet', endpoints: ['ssh://remote-host?port=9222'] },
      },
    };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
      store.deviceBrowser = (meta.deviceBrowser ?? {}) as Record<string, BrowserProfileConfig>;
    });

    await expect(
      createProfile({
        name: 'second',
        browser: 'comet',
        endpoints: ['ssh://remote-host?port=9300'],
      })
    ).resolves.toBeUndefined();
    expect(storedProfile(store, 'second')).toBeTruthy();
  });

  it('rejects two ssh:// profiles on the same remote host:port', async () => {
    const store: ProfileStore = {
      browser: {
        first: { browser: 'comet', endpoints: ['ssh://remote-host:9222'] },
      },
    };
    vi.mocked(readMeta).mockImplementation(() => store as any);

    await expect(
      createProfile({
        name: 'second',
        browser: 'comet',
        endpoints: ['ssh://remote-host:9222'],
      })
    ).rejects.toThrow(/Local port 9222 is already used by profile "first"/);
  });
});

describe('createProfile storage scope (RUSH-2716)', () => {
  function wire(): ProfileStore {
    const store: ProfileStore = { browser: {} };
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
    return store;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findBrowserPath).mockReturnValue(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
  });

  it('writes a NEW profile to this machine only, never the fleet-synced map', async () => {
    const store = wire();

    await createProfile({ name: 'throwaway', browser: 'chrome', endpoints: ['cdp://127.0.0.1:9401'] });

    // The whole point of RUSH-2716: an ad-hoc profile an agent mints must not
    // sync to every machine as junk.
    expect(store.deviceBrowser!['throwaway'].browser).toBe('chrome');
    expect(store.browser['throwaway']).toBeUndefined();
  });

  it('writes to the fleet-synced map when --fleet is passed', async () => {
    const store = wire();

    await createProfile(
      { name: 'shared', browser: 'chrome', endpoints: ['cdp://127.0.0.1:9402'] },
      { fleet: true },
    );

    expect(store.browser['shared'].browser).toBe('chrome');
    expect(store.deviceBrowser?.['shared']).toBeUndefined();
  });

  it('keeps the auto `default` machine-local even when --fleet is passed', async () => {
    const store = wire();

    await createProfile(
      { name: 'default', browser: 'chrome', endpoints: ['cdp://127.0.0.1:9403'] },
      { fleet: true },
    );

    // Its binary path and port are this box's; syncing it is the rewrite loop
    // RUSH-2161 fixed, so the flag must not be able to re-open that hole.
    expect(store.deviceBrowser!['default'].browser).toBe('chrome');
    expect(store.browser['default']).toBeUndefined();
  });

  it('does not migrate an EXISTING fleet profile when a new local one is added', async () => {
    const store = wire();
    store.browser = { legacy: { browser: 'brave', endpoints: ['cdp://127.0.0.1:9410'] } };

    await createProfile({ name: 'fresh', browser: 'chrome', endpoints: ['cdp://127.0.0.1:9411'] });

    expect(store.browser['legacy'].browser).toBe('brave');
    expect(store.deviceBrowser!['fresh']).toBeTruthy();
  });

  it('listProfilesWithScope reports where each profile actually lives', async () => {
    const store = wire();
    store.browser = { shared: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9420'] } };
    store.deviceBrowser = { mine: { browser: 'brave', endpoints: ['cdp://127.0.0.1:9421'] } };

    const { listProfilesWithScope } = await import('./profiles.js');
    const scoped = await listProfilesWithScope();

    expect(scoped.find((s) => s.profile.name === 'shared')!.scope).toBe('fleet');
    expect(scoped.find((s) => s.profile.name === 'mine')!.scope).toBe('local');
  });

  it('reports `local` for a name present in BOTH maps — the copy actually used', async () => {
    const store = wire();
    store.browser = { dup: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9430'] } };
    store.deviceBrowser = { dup: { browser: 'brave', endpoints: ['cdp://127.0.0.1:9431'] } };

    const { listProfilesWithScope } = await import('./profiles.js');
    const scoped = await listProfilesWithScope();

    expect(scoped).toHaveLength(1);
    expect(scoped[0].scope).toBe('local');
    expect(scoped[0].profile.browser).toBe('brave');
  });
});

describe('formatProfilesTable (RUSH-2710)', () => {
  const row = (name: string, scope: 'local' | 'fleet' = 'local', description?: string) => ({
    profile: { name, browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'], description } as BrowserProfile,
    scope,
  });

  /** Column start offsets, so alignment is asserted rather than eyeballed. */
  function browserColumnOffsets(lines: string[]): number[] {
    return lines
      .filter((l) => l.includes('chrome') || l.includes('BROWSER'))
      .map((l) => l.indexOf(l.includes('BROWSER') ? 'BROWSER' : 'chrome'));
  }

  it('keeps columns aligned when a name is far longer than the old 20-char pad', () => {
    // The exact defect: `padEnd(20)` returns a 34-char name unchanged, so every
    // later column on that row shifted right.
    const long = 'a-really-long-profile-name-here';
    expect(long.length).toBeGreaterThan(20);
    const lines = formatProfilesTable([row('short'), row(long)]);

    const offsets = browserColumnOffsets(lines);
    expect(new Set(offsets).size).toBe(1);
  });

  it('truncates a name past the column cap with an ellipsis instead of overflowing', () => {
    const huge = 'x'.repeat(60);
    const lines = formatProfilesTable([row(huge)]);
    const dataLine = lines.find((l) => l.includes('…'))!;

    expect(dataLine).toBeTruthy();
    expect(dataLine).not.toContain(huge);
    const offsets = browserColumnOffsets(lines);
    expect(new Set(offsets).size).toBe(1);
  });

  it('marks the CONFIGURED default with `*`, not by writing "default" in the row', () => {
    const lines = formatProfilesTable([row('work'), row('default')], 'work');
    const workRow = lines.find((l) => l.includes('work'))!;
    const defaultRow = lines.find((l) => / default/.test(l) && !l.includes('work'))!;

    // The marked row is the configured one...
    expect(workRow.startsWith('*')).toBe(true);
    // ...and the profile NAMED `default` is NOT marked, which is exactly the
    // ambiguity RUSH-2710 reported: the two meanings are now distinguishable.
    expect(defaultRow.startsWith('*')).toBe(false);
    expect(lines.some((l) => l.includes("this machine's default profile (work)"))).toBe(true);
  });

  it('shows no marker at all when no default is configured', () => {
    const lines = formatProfilesTable([row('work'), row('default')]);
    expect(lines.some((l) => l.startsWith('*'))).toBe(false);
  });

  it('names the store each profile lives in', () => {
    const lines = formatProfilesTable([row('mine', 'local'), row('shared', 'fleet')]);
    expect(lines.find((l) => l.includes('mine'))).toMatch(/local/);
    expect(lines.find((l) => l.includes('shared'))).toMatch(/fleet/);
  });

  it('keeps columns aligned with a description column present', () => {
    const lines = formatProfilesTable([
      row('short', 'local', 'a description'),
      row('a-really-long-profile-name-here', 'local', 'another much longer description here'),
    ]);
    const offsets = browserColumnOffsets(lines);
    expect(new Set(offsets).size).toBe(1);
  });
});

describe('padColumn', () => {
  it('pads a short value to the exact width', () => {
    expect(padColumn('ab', 5)).toBe('ab   ');
  });

  it('returns an exact-width value untouched', () => {
    expect(padColumn('abcde', 5)).toBe('abcde');
  });

  it('truncates an over-long value TO the width — padEnd alone does not', () => {
    expect(padColumn('abcdefgh', 5)).toBe('abcd…');
    expect(padColumn('abcdefgh', 5)).toHaveLength(5);
    expect('abcdefgh'.padEnd(5)).toHaveLength(8); // the bug being fixed
  });
});
