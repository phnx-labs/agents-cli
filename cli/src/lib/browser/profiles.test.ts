import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A real temp root for the device-config store: browser.profile lives in this
// machine's per-device doc (devices/<machineId()>/agents.yaml config:), read
// through the REAL lib/device-config.ts against this dir.
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-browser-profiles-test-'));

vi.mock('../state.js', () => ({
  getBrowserRuntimeDir: vi.fn(() => path.join(TEST_ROOT, 'browser-runtime')),
  readMeta: vi.fn(() => ({ browser: {} })),
  writeMeta: vi.fn(),
  // device-config.js (the browser.profile store) reads/writes through these.
  updateMeta: vi.fn(),
  // setConfigValue writes under this lock; the real one just runs fn() when
  // uncontended, which is always true in a single-process test.
  withMetaLock: vi.fn((fn: () => unknown) => fn()),
  META_HEADER: '',
  getUserAgentsDir: vi.fn(() => path.join(TEST_ROOT, '.agents')),
  getDevicesAutoLaunchPath: vi.fn(() => path.join(TEST_ROOT, 'auto-launch.json')),
  getDevicesIgnoredPath: vi.fn(() => path.join(TEST_ROOT, 'ignored.json')),
  getDevicePinsPath: vi.fn(() => path.join(TEST_ROOT, 'pins.json')),
}));

vi.mock('./chrome.js', () => ({
  findBrowserPath: vi.fn(() => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  findFirstInstalledBrowser: vi.fn(() => ({
    browserType: 'chrome',
    binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  })),
  isPortInUse: vi.fn(() => false),
}));

// Legacy unit cases in this file isolate browser discovery and persistence.
// The registry itself is exercised against real device YAML in registry.test.ts.
vi.mock('./registry.js', async () => {
  const state = await import('../state.js');
  const { machineId } = await import('../machine-id.js');
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

import {
  extractConfiguredPort,
  extractConfiguredEndpoint,
  findFreeProfilePort,
  createProfile,
  ensureDefaultBrowserProfile,
  resolveProfileRef,
  resolveProfileRefForStart,
  getAutoDetectedProfile,
  DEFAULT_BROWSER_PROFILE_NAME,
  DEFAULT_PROFILE_ALIAS,
  formatProfilesTable,
  padColumn,
  editProfile,
  renameProfile,
  assertRegistrableProfileName,
  assertLocalPortFree,
  shouldAutoClaimCentralProfile,
  hasSshEndpoint,
} from './profiles.js';
import { findBrowserPath, findFirstInstalledBrowser, isPortInUse } from './chrome.js';
import type { BrowserProfile } from './types.js';
import type { BrowserProfileConfig } from '../types.js';
import { readMeta, writeMeta, updateMeta } from '../state.js';
import { machineId } from '../machine-id.js';

/** Write this machine's per-device doc with the given default browser profile —
 * where browser.profile really lives (lib/device-config.ts). */
function writeDeviceDefaultProfile(name: string): void {
  const dir = path.join(TEST_ROOT, '.agents', 'devices', machineId());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.yaml'), `config:\n  defaultBrowserProfile: ${name}\n`);
}

/** The configured default profile: the doc fixture + the in-memory store. */
function withDefaultProfile(store: { browser: Record<string, BrowserProfileConfig> }, name: string) {
  writeDeviceDefaultProfile(name);
  return store;
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
    // No carried-over device default between tests.
    fs.rmSync(path.join(TEST_ROOT, '.agents', 'devices'), { recursive: true, force: true });
  });

  it('throws instead of auto-creating when nothing is configured and no launchable profile exists', async () => {
    // PHNX-3296: the silent auto-detect+create is gone. With no configured
    // default and no existing profile, a bare start must stop and guide the
    // user — never mint a logged-out `auto-chrome` behind their back.
    const store: ProfileStore = { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    const writeSpy = vi.mocked(writeMeta);

    const err = await ensureDefaultBrowserProfile().catch((e) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/No default browser is configured on this machine/);
    // The guidance points at both the interactive fix and the headless one.
    expect(err.message).toMatch(/agents setup/);
    expect(err.message).toMatch(/fleet hub/);
    // Nothing was persisted, and it never even probed the installed browsers.
    expect(writeSpy).not.toHaveBeenCalled();
    expect(findFirstInstalledBrowser).not.toHaveBeenCalled();
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

  it('throws rather than regenerating a stale default whose binary is missing here', async () => {
    // Pre-PHNX-3296 this re-detected a browser and rewrote the profile in place.
    // A stale `default` auto-created on macOS carries a /Applications/... binary
    // that doesn't exist on this (Linux) box. Now an unlaunchable existing
    // default is NOT silently repaired — the user is told to pick a browser, and
    // the stale record is left exactly as it was.
    const stale: BrowserProfileConfig = {
      browser: 'custom',
      binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      endpoints: ['cdp://127.0.0.1:9222'],
    };
    const store: ProfileStore = { browser: { default: stale } };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    const writeSpy = vi.mocked(writeMeta);
    // The stale binary isn't launchable here → findBrowserPath throws for it.
    vi.mocked(findBrowserPath).mockImplementationOnce(() => {
      throw new Error('Custom binary not found: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    });

    await expect(ensureDefaultBrowserProfile()).rejects.toThrow(
      /No default browser is configured on this machine/,
    );
    expect(writeSpy).not.toHaveBeenCalled();
    // The stale record is untouched.
    expect(store.browser.default.binary).toBe(stale.binary);
  });

  it("warns, then throws, when the configured default can't launch here and nothing else does", async () => {
    // A declared-but-unlaunchable configured default still warns (missing binary
    // on this box), but there is no auto-detect fallback anymore — it throws.
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
    const writeSpy = vi.mocked(writeMeta);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(findBrowserPath).mockImplementationOnce(() => {
      throw new Error('Custom binary not found');
    });

    await expect(ensureDefaultBrowserProfile()).rejects.toThrow(
      /No default browser is configured on this machine/,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("can't launch on this"));
    expect(writeSpy).not.toHaveBeenCalled();
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

  it('throws the same guidance even when a supported browser IS installed (never auto-creates)', async () => {
    // The crux of PHNX-3296: a browser being available is NOT consent to drive
    // it. `findFirstInstalledBrowser` is wired to chrome in this suite, yet with
    // nothing configured we must still refuse to mint a profile.
    vi.mocked(readMeta).mockImplementation(() => ({ browser: {} }) as any);
    const writeSpy = vi.mocked(writeMeta);

    await expect(ensureDefaultBrowserProfile()).rejects.toThrow(
      /Run `agents setup`.*pick the browser/s,
    );
    expect(writeSpy).not.toHaveBeenCalled();
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

  it('throws rather than creating auto-chrome when the configured default is undeclared', async () => {
    const store = withDefaultProfile({ browser: {} }, 'ghost');
    vi.mocked(readMeta).mockImplementation(() => store as any);
    const writeSpy = vi.mocked(writeMeta);

    await expect(ensureDefaultBrowserProfile()).rejects.toThrow(
      /configured default browser profile "ghost" is not declared by any device/,
    );
    expect(writeSpy).not.toHaveBeenCalled();
    expect(findFirstInstalledBrowser).not.toHaveBeenCalled();
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

describe('createProfile device declaration', () => {
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

});

describe('formatProfilesTable (RUSH-2710)', () => {
  const row = (name: string, devices: string[] = ['zion'], description?: string) => ({
    name,
    browser: 'chrome' as const,
    endpoints: ['cdp://127.0.0.1:9222'],
    description,
    devices,
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

  it('names every device declaring each profile', () => {
    const lines = formatProfilesTable([row('mine'), row('shared', ['zion', 'yosemite-s0'])]);
    expect(lines.find((l) => l.includes('mine'))).toMatch(/zion/);
    expect(lines.find((l) => l.includes('shared'))).toMatch(/zion, yosemite-s0/);
  });

  it('keeps columns aligned with a description column present', () => {
    const lines = formatProfilesTable([
      row('short', ['zion'], 'a description'),
      row('a-really-long-profile-name-here', ['zion'], 'another much longer description here'),
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

/**
 * RUSH-2709: `default` used to name BOTH the auto-detected profile and the
 * "whatever the user configured" alias, and only `start` honored the alias — so
 * `--profile default` meant a different profile in start / stop / status /
 * navigate. `resolveProfileRef` is now the single resolver every command calls.
 */
describe('resolveProfileRef — the one `default` rule (RUSH-2709)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(path.join(TEST_ROOT, '.agents', 'devices'), { recursive: true, force: true });
  });

  function withStore(profiles: Record<string, BrowserProfileConfig>): ProfileStore {
    const store: ProfileStore = { browser: profiles };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    return store;
  }

  const chrome: BrowserProfileConfig = { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] };

  it('resolves the `default` ALIAS to the configured profile', async () => {
    withStore({ 'comet-local': chrome });
    writeDeviceDefaultProfile('comet-local');

    expect(await resolveProfileRef(DEFAULT_PROFILE_ALIAS)).toBe('comet-local');
    // …and a bare invocation (no --profile) resolves identically. That identity
    // is the whole fix: every command asks this one function.
    expect(await resolveProfileRef(undefined)).toBe('comet-local');
  });

  it('back-compat: a `browser.profile` of `default` resolves to the auto-detected profile', async () => {
    // An existing config written before the rename literally says `default`.
    withStore({ [DEFAULT_BROWSER_PROFILE_NAME]: chrome });
    writeDeviceDefaultProfile(DEFAULT_PROFILE_ALIAS);

    expect(await resolveProfileRef(DEFAULT_PROFILE_ALIAS)).toBe(DEFAULT_BROWSER_PROFILE_NAME);
    expect(await resolveProfileRef(undefined)).toBe(DEFAULT_BROWSER_PROFILE_NAME);
  });

  it('back-compat: a profile literally NAMED `default` resolves to itself', async () => {
    // The pre-rename auto-detected profile, still on this machine. Resolving it
    // to anything else would orphan its running browser and runtime dirs.
    withStore({ default: { browser: 'brave', endpoints: ['cdp://127.0.0.1:9333'] } });

    expect(await resolveProfileRef('default')).toBe('default');
    expect(await resolveProfileRef(undefined)).toBe('default');
    expect((await getAutoDetectedProfile())?.name).toBe('default');
  });

  it('a literal `default` profile outranks the configured default for `--profile default`', async () => {
    // Precedence: a real profile named `default` wins the explicit reference, so
    // a user who named one is never silently redirected somewhere else.
    withStore({ default: chrome, 'comet-local': chrome });
    writeDeviceDefaultProfile('comet-local');

    expect(await resolveProfileRef('default')).toBe('default');
    // No argument still means "the configured default".
    expect(await resolveProfileRef(undefined)).toBe('comet-local');
  });

  it('an ABSENT ref stays absent for a filter — resolveProfileRef(undefined) is never forced', async () => {
    // `--profile` is a FILTER on status / tasks / navigate: omitting it means
    // "no filter". Those call sites therefore must not call this with
    // `undefined` — it resolves to the configured default, which would silently
    // turn `agents browser status` into `status --profile <default>` and hide
    // every other running browser. Pinned here so the contract is explicit:
    withStore({ 'comet-local': chrome, other: chrome });
    writeDeviceDefaultProfile('comet-local');

    expect(await resolveProfileRef(undefined)).toBe('comet-local');
    // …hence the guard the callers use.
    const asFilter = (ref?: string) => (ref ? resolveProfileRef(ref) : undefined);
    expect(await asFilter(undefined)).toBeUndefined();
    expect(await asFilter('other')).toBe('other');
  });

  it('passes an ordinary name straight through, including an unknown one', async () => {
    withStore({ work: chrome });
    expect(await resolveProfileRef('work')).toBe('work');
    // Unknown names are returned unchanged so the caller reports its own
    // `Profile "x" not found` with the name the user typed.
    expect(await resolveProfileRef('nope')).toBe('nope');
  });
});

/**
 * `start` is the only command that launches, so it is the only one that even
 * warns about a default that cannot run on this machine. Before PHNX-3296 it
 * also silently regenerated one; now it throws instead. Routing it through the
 * plain (filter) resolver would skip both the warn and that throw.
 */
describe('resolveProfileRefForStart — no silent repair (RUSH-2709, PHNX-3296)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(path.join(TEST_ROOT, '.agents', 'devices'), { recursive: true, force: true });
  });

  it('throws (no silent repair) when the configured default cannot launch here', async () => {
    const store: ProfileStore = {
      browser: {
        'mac-chrome': {
          browser: 'custom',
          binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          endpoints: ['cdp://127.0.0.1:9333'],
        },
      },
    };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    const writeSpy = vi.mocked(writeMeta);
    writeDeviceDefaultProfile('mac-chrome');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(findBrowserPath).mockImplementationOnce(() => {
      throw new Error('Custom binary not found');
    });

    // The filter resolver still hands back the unlaunchable profile, by design.
    expect(await resolveProfileRef(undefined)).toBe('mac-chrome');
    // `start` must not silently repair it — it warns and then throws.
    await expect(resolveProfileRefForStart(undefined)).rejects.toThrow(
      /No default browser is configured on this machine/,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("can't launch on this"));
    expect(writeSpy).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns an explicit name unchanged, and honors a literal `default` profile', async () => {
    const store: ProfileStore = { browser: { work: chromeCfg(), default: chromeCfg() } };
    vi.mocked(readMeta).mockImplementation(() => store as any);

    expect(await resolveProfileRefForStart('work')).toBe('work');
    expect(await resolveProfileRefForStart('default')).toBe('default');
  });
});

function chromeCfg(): BrowserProfileConfig {
  return { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] };
}

describe('editProfile', () => {
  beforeEach(() => {
    vi.mocked(updateMeta).mockImplementation((updates: any) => {
      const meta = vi.mocked(readMeta)() as any;
      const next = typeof updates === 'function' ? updates(meta) : { ...meta, ...updates };
      vi.mocked(writeMeta)(next);
      return next;
    });
    vi.clearAllMocks();
  });

  function wire(store: ProfileStore) {
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
      store.deviceBrowser = (meta.deviceBrowser ?? {}) as Record<string, BrowserProfileConfig>;
    });
  }

  it('writes an edited declaration to this device', async () => {
    const store: ProfileStore = {
      browser: { shared: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9401'] } },
    };
    wire(store);

    const res = await editProfile('shared', { description: 'the shared one' });

    expect(res.devices).toEqual([machineId()]);
    expect(res.changed).toEqual(['description']);
    expect(store.deviceBrowser!.shared.description).toBe('the shared one');
  });

  it('keeps a machine-local profile in the device store', async () => {
    const store: ProfileStore = {
      browser: {},
      deviceBrowser: { mine: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9402'] } },
    };
    wire(store);

    const res = await editProfile('mine', { description: 'local only' });

    expect(res.devices).toEqual([machineId()]);
    expect(store.deviceBrowser!.mine.description).toBe('local only');
    expect(store.browser?.mine).toBeUndefined();
  });

  it('keeps every untouched field through a description-only edit', async () => {
    const store: ProfileStore = { browser: {} };
    wire(store);
    await createProfile({
      name: 'rich',
      browser: 'custom',
      binary: '/Applications/Canva.app/Contents/MacOS/Canva',
      electron: true,
      targetFilter: 'url:https://www.canva.com/',
      endpoints: ['cdp://127.0.0.1:9404'],
      secrets: 'canva-creds',
      viewport: { width: 1512, height: 982, x: 80, y: 80 },
    });

    const before = storedProfile(store, 'rich');
    await editProfile('rich', { description: 'now described' });
    const after = storedProfile(store, 'rich');

    expect(after.description).toBe('now described');
    expect(after.binary).toBe(before.binary);
    expect(after.electron).toBe(before.electron);
    expect(after.targetFilter).toBe(before.targetFilter);
    expect(after.secrets).toBe(before.secrets);
    expect(after.endpoints).toEqual(before.endpoints);
    expect(after.viewport).toEqual({ width: 1512, height: 982, x: 80, y: 80 });
  });

  it('does not treat the profile own port as a collision', async () => {
    // Without the `ignore` argument every edit collides with itself, because the
    // stored copy still owns the port being kept.
    const store: ProfileStore = {
      browser: { solo: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9405'] } },
    };
    wire(store);

    await expect(
      editProfile('solo', { endpoints: ['cdp://127.0.0.1:9405'], description: 'same port' })
    ).resolves.toMatchObject({ devices: [machineId()] });
  });

  it('refuses an endpoint whose local port another profile owns', async () => {
    const store: ProfileStore = {
      browser: {
        a: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9406'] },
        b: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9407'] },
      },
    };
    wire(store);

    await expect(editProfile('a', { endpoints: ['cdp://127.0.0.1:9407'] })).rejects.toThrow(/"b"/);
  });

  it('refuses a target filter once electron is turned off in the same edit', async () => {
    const store: ProfileStore = {
      browser: {
        app: {
          browser: 'custom',
          binary: '/Applications/Canva.app/Contents/MacOS/Canva',
          electron: true,
          targetFilter: 'url:https://www.canva.com/',
          endpoints: ['cdp://127.0.0.1:9408'],
        },
      },
    };
    wire(store);

    await expect(editProfile('app', { electron: undefined })).rejects.toThrow(/--target-filter/);
  });

  it('clears the description when passed undefined', async () => {
    const store: ProfileStore = {
      browser: { desc: { browser: 'chrome', description: 'old', endpoints: ['cdp://127.0.0.1:9409'] } },
    };
    wire(store);

    await editProfile('desc', { description: undefined });

    expect(store.deviceBrowser!.desc.description).toBeUndefined();
  });

  it('rejects an unknown profile', async () => {
    const store: ProfileStore = { browser: {} };
    wire(store);
    await expect(editProfile('ghost', { description: 'x' })).rejects.toThrow(/not declared/);
  });
});

describe('assertLocalPortFree', () => {
  beforeEach(() => {
    vi.mocked(updateMeta).mockImplementation((updates: any) => {
      const meta = vi.mocked(readMeta)() as any;
      const next = typeof updates === 'function' ? updates(meta) : { ...meta, ...updates };
      vi.mocked(writeMeta)(next);
      return next;
    });
    vi.clearAllMocks();
  });

  it('names the profile already holding the port', () => {
    const store: ProfileStore = {
      browser: { holder: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9412'] } },
    };
    vi.mocked(readMeta).mockImplementation(() => store as any);

    expect(() =>
      assertLocalPortFree({ name: 'newcomer', browser: 'chrome', endpoints: ['cdp://127.0.0.1:9412'] })
    ).toThrow(/"holder"/);
  });

  it('an SSH endpoint binds its configured port locally too, so it still collides', () => {
    const store: ProfileStore = {
      browser: { local: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9300'] } },
    };
    vi.mocked(readMeta).mockImplementation(() => store as any);

    expect(() =>
      assertLocalPortFree({ name: 'remote', browser: 'custom', endpoints: ['ssh://muqsit@mac-mini?port=9300'] })
    ).toThrow(/9300/);
  });
});

describe('renameProfile', () => {
  beforeEach(() => {
    vi.mocked(updateMeta).mockImplementation((updates: any) => {
      const meta = vi.mocked(readMeta)() as any;
      const next = typeof updates === 'function' ? updates(meta) : { ...meta, ...updates };
      vi.mocked(writeMeta)(next);
      return next;
    });
    vi.clearAllMocks();
  });

  function wire(store: ProfileStore) {
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
      store.deviceBrowser = (meta.deviceBrowser ?? {}) as Record<string, BrowserProfileConfig>;
    });
  }

  it('carries the browser data dir across, so logins survive', async () => {
    // The whole reason this exists. Delete-and-recreate — the only route before
    // — abandons the --user-data-dir, which on a real agent browser is every
    // account it has ever signed into.
    const store: ProfileStore = {
      browser: { 'comet-local': { browser: 'comet', endpoints: ['cdp://localhost:9333'] } },
    };
    wire(store);

    const { getBrowserRuntimeDir } = await import('./profiles.js');
    const root = getBrowserRuntimeDir();
    const oldDir = path.join(root, 'comet-local@endpoint-0');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'Cookies'), 'pretend-session');

    const res = await renameProfile('comet-local', 'agents');

    expect(res.devices).toEqual([machineId()]);
    expect(fs.existsSync(oldDir)).toBe(false);
    const newDir = path.join(root, 'agents@endpoint-0');
    expect(fs.readFileSync(path.join(newDir, 'Cookies'), 'utf8')).toBe('pretend-session');
    expect(store.deviceBrowser!.agents).toBeDefined();
    expect(store.deviceBrowser!['comet-local']).toBeUndefined();
  });

  it('repoints browser.profile, or the next browser start falls back to auto-detect', async () => {
    // #2962 added two tests for browser.viewer while the sibling repoint three
    // lines up had none — deleting it broke nothing.
    const store: ProfileStore = {
      browser: { old: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9540'] } },
    };
    wire(store);
    const { setConfigValue, getConfigValue } = await import('../device-config.js');
    setConfigValue('browser.profile', 'old');

    const res = await renameProfile('old', 'fresh');

    expect(res.repointedDefault).toBe(true);
    expect(getConfigValue('browser.profile').value).toBe('fresh');
  });

  it('repoints browser.viewer too, or artifacts silently go back to the OS browser', async () => {
    // The gap this closes: `browser.viewer` is a separate key from
    // `browser.profile`. Left dangling, resolveViewer falls back to the OS
    // default handler — the exact bug the viewer seam was built to fix,
    // reintroduced by a rename.
    const store: ProfileStore = {
      browser: { old: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9520'] } },
    };
    wire(store);
    const { setConfigValue, getConfigValue } = await import('../device-config.js');
    setConfigValue('browser.viewer', 'old');

    const res = await renameProfile('old', 'fresh');

    expect(res.repointedViewer).toBe(true);
    expect(getConfigValue('browser.viewer').value).toBe('fresh');
  });

  it('leaves browser.viewer alone when it points somewhere else', async () => {
    const store: ProfileStore = {
      browser: {
        old: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9521'] },
        other: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9522'] },
      },
    };
    wire(store);
    const { setConfigValue, getConfigValue } = await import('../device-config.js');
    setConfigValue('browser.viewer', 'other');

    const res = await renameProfile('old', 'fresh');

    expect(res.repointedViewer).toBe(false);
    expect(getConfigValue('browser.viewer').value).toBe('other');
  });

  it('refuses while the profile is in use, so a live browser keeps its data dir', async () => {
    // The guard that prevents actual corruption, and it had no test: moving a
    // --user-data-dir out from under a running browser corrupts it. Driven
    // through the real isProfileInUse, which counts a profile in use when its
    // tasks.json is non-empty.
    const store: ProfileStore = {
      browser: { live: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9534'] } },
    };
    wire(store);
    const { getBrowserRuntimeDir } = await import('./profiles.js');
    const dir = path.join(getBrowserRuntimeDir(), 'live@endpoint-0');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Cookies'), 'live-session');
    fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(['a-running-task']));

    await expect(renameProfile('live', 'renamed')).rejects.toThrow(/in use/);

    // Nothing moved, config untouched.
    expect(fs.readFileSync(path.join(dir, 'Cookies'), 'utf8')).toBe('live-session');
    expect(store.browser!.live).toBeDefined();
  });

  it('moves NOTHING when any destination dir is taken', async () => {
    // The stranding bug: the dest check used to sit inside the move loop, so
    // dir N was validated only after dirs 0..N-1 had moved. A collision on the
    // second endpoint left the first one's logins under a name with no config
    // entry, and the error named only the squatter.
    const store: ProfileStore = {
      browser: { multi: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9530'] } },
    };
    wire(store);
    const { getBrowserRuntimeDir } = await import('./profiles.js');
    const root = getBrowserRuntimeDir();
    for (const d of ['multi@endpoint-0', 'multi@endpoint-1', 'target@endpoint-1']) {
      fs.mkdirSync(path.join(root, d), { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'multi@endpoint-0', 'Cookies'), 'keep-me');

    await expect(renameProfile('multi', 'target')).rejects.toThrow(/Nothing was moved/);

    // The first dir must still be where it started, with its data.
    expect(fs.readFileSync(path.join(root, 'multi@endpoint-0', 'Cookies'), 'utf8')).toBe('keep-me');
    expect(fs.existsSync(path.join(root, 'target@endpoint-0'))).toBe(false);
    expect(store.browser!.multi).toBeDefined();
  });

  it('refuses `os`, the reserved browser.viewer value', async () => {
    const store: ProfileStore = {
      browser: { a: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9533'] } },
    };
    wire(store);
    await expect(renameProfile('a', 'os')).rejects.toThrow(/reserved browser\.viewer value/);
  });

  it('keeps a local profile local', async () => {
    const store: ProfileStore = {
      browser: {},
      deviceBrowser: { mine: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9501'] } },
    };
    wire(store);

    const res = await renameProfile('mine', 'yours');

    expect(res.devices).toEqual([machineId()]);
    expect(store.deviceBrowser!.yours).toBeDefined();
    expect(store.browser?.yours).toBeUndefined();
  });

  it('refuses a name that already exists', async () => {
    const store: ProfileStore = {
      browser: {
        a: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9502'] },
        b: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9503'] },
      },
    };
    wire(store);
    await expect(renameProfile('a', 'b')).rejects.toThrow(/already exists/);
  });

  it('refuses an unknown profile, and a no-op rename', async () => {
    const store: ProfileStore = {
      browser: { a: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9504'] } },
    };
    wire(store);
    await expect(renameProfile('ghost', 'x')).rejects.toThrow(/not declared/);
    await expect(renameProfile('a', 'a')).rejects.toThrow(/already its own name/);
  });

  it('refuses the reserved `default` alias as a target', async () => {
    const store: ProfileStore = {
      browser: { a: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9505'] } },
    };
    wire(store);
    await expect(renameProfile('a', 'default')).rejects.toThrow(/reserved alias/);
  });
});

describe('assertRegistrableProfileName', () => {
  it('accepts the shape profiles create accepts, and rejects the rest', () => {
    for (const ok of ['agents', 'comet-local', 'a1', 'x-y-z']) {
      expect(() => assertRegistrableProfileName(ok), ok).not.toThrow();
    }
    for (const bad of ['Agents', '1agent', 'my profile', 'agent_x', '-lead', '']) {
      expect(() => assertRegistrableProfileName(bad), bad).toThrow(/Invalid profile name/);
    }
  });
});

describe('shouldAutoClaimCentralProfile (PHNX-3315 auto-drain safety)', () => {
  // The safety-critical property: a local/cdp tombstone is NEVER auto-claimed,
  // regardless of what browsers are installed here. "browser installed here" is
  // not "I hold this profile's session", so auto-claiming a cdp profile would let
  // two boxes flip a credentialed profile identity->fungible fleet-wide. This
  // assertion is machine-independent (it short-circuits before any binary probe).
  it('never auto-claims a local/cdp profile', () => {
    expect(
      shouldAutoClaimCentralProfile({
        browser: 'comet',
        endpoints: ['cdp://localhost:9333'],
      } as BrowserProfileConfig),
    ).toBe(false);
    expect(
      shouldAutoClaimCentralProfile({
        browser: 'chrome',
        endpoints: ['cdp://127.0.0.1:9222'],
      } as BrowserProfileConfig),
    ).toBe(false);
  });

  it('gates on ssh:// ownership — a remote endpoint passes the gate, a cdp one does not', () => {
    // ssh:// is fungible by design: the endpoint names the host, so a concurrent
    // cross-machine double-claim is harmless. The final claim still requires
    // launchability here, but the ownership gate itself must accept ssh://.
    expect(hasSshEndpoint(['ssh://user@mac-mini?port=9333'])).toBe(true);
    expect(hasSshEndpoint(['cdp://localhost:9333'])).toBe(false);
  });
});
