import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../state.js', () => ({
  getBrowserRuntimeDir: vi.fn(() => '/tmp/agents-browser-test'),
  readMeta: vi.fn(() => ({ browser: {} })),
  writeMeta: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('./chrome.js', () => ({
  findBrowserPath: vi.fn(() => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  findFirstInstalledBrowser: vi.fn(() => ({
    browserType: 'chrome',
    binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  })),
}));

import {
  extractConfiguredPort,
  extractConfiguredEndpoint,
  findFreeProfilePort,
  createProfile,
  ensureDefaultBrowserProfile,
} from './profiles.js';
import { findFirstInstalledBrowser } from './chrome.js';
import type { BrowserProfile } from './types.js';
import type { BrowserProfileConfig } from '../types.js';
import { readMeta, writeMeta } from '../state.js';
import { execFileSync } from 'child_process';

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
    expect(extractConfiguredEndpoint(profile(['ssh://mac-mini:9222']))).toEqual({
      host: 'mac-mini',
      port: 9222,
    });
  });

  it('strips username from ssh://user@host:port', () => {
    expect(extractConfiguredEndpoint(profile(['ssh://user@mac-mini:9222']))).toEqual({
      host: 'mac-mini',
      port: 9222,
    });
  });

  it('defaults port to 9222 when omitted for cdp:// and ssh://', () => {
    expect(extractConfiguredEndpoint(profile(['cdp://localhost']))).toEqual({
      host: '127.0.0.1',
      port: 9222,
    });
    expect(extractConfiguredEndpoint(profile(['ssh://mac-mini']))).toEqual({
      host: 'mac-mini',
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
            remote: { target: 'ssh://mac-mini:9222' },
          },
          'remote'
        )
      )
    ).toEqual({ host: 'mac-mini', port: 9222 });
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
      extractConfiguredEndpoint(profile(['ssh://mac-mini?port=18805']))
    ).toEqual({ host: 'mac-mini', port: 18805 });
  });

  it('reads ssh://user@host?port=N (query-string form with username)', () => {
    expect(
      extractConfiguredEndpoint(profile(['ssh://user@mac-mini?port=18805']))
    ).toEqual({ host: 'mac-mini', port: 18805 });
  });

  it('prefers explicit :port over ?port= when both are present', () => {
    expect(
      extractConfiguredEndpoint(profile(['ssh://mac-mini:9300?port=18805']))
    ).toEqual({ host: 'mac-mini', port: 9300 });
  });

  it('rejects non-numeric ?port= value and falls back to ssh default', () => {
    expect(
      extractConfiguredEndpoint(profile(['ssh://mac-mini?port=abc']))
    ).toEqual({ host: 'mac-mini', port: 9222 });
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

  it('allows spaces in browser binaries used by ssh endpoints', async () => {
    const store: { browser: Record<string, BrowserProfileConfig> } = { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
    });

    await expect(
      createProfile({
        name: 'remote-comet',
        browser: 'custom',
        binary: '/Applications/Comet Beta.app/Contents/MacOS/Comet Beta',
        endpoints: ['ssh://mac-mini:9222'],
      })
    ).resolves.toBeUndefined();
    expect(store.browser['remote-comet'].binary).toBe('/Applications/Comet Beta.app/Contents/MacOS/Comet Beta');
  });

  it('rejects shell metacharacters in browser binaries used by ssh endpoints', async () => {
    const store: { browser: Record<string, BrowserProfileConfig> } = { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);

    await expect(
      createProfile({
        name: 'remote-bad',
        browser: 'custom',
        binary: '/Applications/Comet.app/Contents/MacOS/Comet; touch /tmp/pwned',
        endpoints: ['ssh://mac-mini:9222'],
      })
    ).rejects.toThrow(/Remote browser binary contains shell metacharacters/);
  });

  it('rejects shell metacharacters in per-endpoint ssh binary overrides', async () => {
    const store: { browser: Record<string, BrowserProfileConfig> } = { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);

    await expect(
      createProfile({
        name: 'remote-bad-override',
        browser: 'custom',
        endpoints: {
          remote: {
            target: 'ssh://mac-mini:9222',
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
    const store: { browser: Record<string, BrowserProfileConfig> } = { browser: {} };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('free port');
    });

    const profile = await ensureDefaultBrowserProfile();

    expect(profile.name).toBe('default');
    expect(profile.browser).toBe('chrome');
    expect(profile.binary).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(profile.endpoints).toEqual(['cdp://127.0.0.1:9222']);
    expect(store.browser.default.browser).toBe('chrome');
  });

  it('reuses an existing default profile instead of overwriting it', async () => {
    const existing: BrowserProfileConfig = {
      browser: 'brave',
      binary: '/custom/path/to/brave',
      endpoints: ['cdp://127.0.0.1:9333'],
    };
    const store: { browser: Record<string, BrowserProfileConfig> } = { browser: { default: existing } };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    const writeSpy = vi.mocked(writeMeta);

    const profile = await ensureDefaultBrowserProfile();

    expect(profile.browser).toBe('brave');
    expect(profile.binary).toBe('/custom/path/to/brave');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('throws an actionable error when no Chromium-family browser is installed', async () => {
    vi.mocked(readMeta).mockImplementation(() => ({ browser: {} }) as any);
    vi.mocked(findFirstInstalledBrowser).mockReturnValueOnce(null);

    await expect(ensureDefaultBrowserProfile()).rejects.toThrow(
      /No supported browser found.*Chrome.*Brave.*Edge/
    );
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
    // All OS ports are free (execFileSync throws = nothing listening)
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('no process'); });

    const port = await findFreeProfilePort();
    expect(port).toBe(9226);
  });

  it('skips OS-in-use ports and returns first OS-free port', async () => {
    // No profiles
    vi.mocked(readMeta).mockReturnValue({ browser: {} } as any);
    // 9222 is in use on the OS (execFileSync succeeds = something listening)
    // 9223 is free (execFileSync throws)
    vi.mocked(execFileSync).mockImplementation((_cmd: any, args: any) => {
      if (Array.isArray(args) && args.includes(':9222')) return '' as any;
      throw new Error('no process');
    });

    const port = await findFreeProfilePort();
    expect(port).toBe(9223);
  });

  it('treats SSH profile ports as occupied locally now that tunnels bind on the same port', async () => {
    // SSH profile points at 9222 on mac-mini, but our tunnel will bind
    // local 9222 → mac-mini:9222, so the local port is claimed and the
    // allocator must skip it.
    vi.mocked(readMeta).mockReturnValue({
      browser: {
        'ssh-remote': { browser: 'comet', endpoints: ['ssh://mac-mini:9222'] },
      },
    } as any);
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('no process'); });

    const port = await findFreeProfilePort();
    expect(port).toBe(9223);
  });
});

describe('createProfile port collision (local-port-scoped)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects two local cdp:// profiles on the same port', async () => {
    const store: { browser: Record<string, BrowserProfileConfig> } = {
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

  it('rejects cdp://127.0.0.1:9222 against ssh://mac-mini:9222 because the SSH tunnel binds locally', async () => {
    // After the SSH-tunnel-port change, ssh://host?port=N binds local N too,
    // so cdp://127.0.0.1:N and ssh://host?port=N do collide locally even
    // though their (host, port) tuples differ.
    const store: { browser: Record<string, BrowserProfileConfig> } = {
      browser: {
        remote: { browser: 'comet', endpoints: ['ssh://mac-mini:9222'] },
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
    // mac-mini's 9222 tunnel binds local 9222; mac-studio's tunnel would
    // want local 9222 too. Local resource, single owner.
    const store: { browser: Record<string, BrowserProfileConfig> } = {
      browser: {
        mini: { browser: 'comet', endpoints: ['ssh://mac-mini:9222'] },
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
    const store: { browser: Record<string, BrowserProfileConfig> } = {
      browser: {
        first: { browser: 'comet', endpoints: ['ssh://mac-mini?port=9222'] },
      },
    };
    vi.mocked(readMeta).mockImplementation(() => store as any);
    vi.mocked(writeMeta).mockImplementation((meta: any) => {
      store.browser = (meta.browser ?? {}) as Record<string, BrowserProfileConfig>;
    });

    await expect(
      createProfile({
        name: 'second',
        browser: 'comet',
        endpoints: ['ssh://mac-mini?port=9300'],
      })
    ).resolves.toBeUndefined();
    expect(store.browser['second']).toBeTruthy();
  });

  it('rejects two ssh:// profiles on the same remote host:port', async () => {
    const store: { browser: Record<string, BrowserProfileConfig> } = {
      browser: {
        first: { browser: 'comet', endpoints: ['ssh://mac-mini:9222'] },
      },
    };
    vi.mocked(readMeta).mockImplementation(() => store as any);

    await expect(
      createProfile({
        name: 'second',
        browser: 'comet',
        endpoints: ['ssh://mac-mini:9222'],
      })
    ).rejects.toThrow(/Local port 9222 is already used by profile "first"/);
  });
});
