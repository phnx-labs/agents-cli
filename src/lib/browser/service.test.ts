import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import * as yaml from 'yaml';
import * as state from '../state.js';

const { TEST_HOME, TEST_AGENTS_DIR, TEST_BROWSER_DIR } = vi.hoisted(() => {
  const nodeOs = require('os');
  const nodePath = require('path');
  const testHome = nodePath.join(nodeOs.tmpdir(), 'agents-cli-browser-service-test');
  const testAgentsDir = nodePath.join(testHome, '.agents');
  return {
    TEST_HOME: testHome,
    TEST_AGENTS_DIR: testAgentsDir,
    TEST_BROWSER_DIR: nodePath.join(testAgentsDir, 'browser'),
  };
});

vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(TEST_AGENTS_DIR);
vi.spyOn(state, 'getAgentsDir').mockReturnValue(TEST_AGENTS_DIR);
vi.spyOn(state, 'getBrowserRuntimeDir').mockReturnValue(TEST_BROWSER_DIR);

// Mock profiles module so listProfiles, getProfile, and getProfileRuntimeDir use the test dir.
vi.mock('./profiles.js', async (importOriginal) => {
  const nodeFs = require('fs');
  const nodePath = require('path');
  const nodeYaml = require('yaml');
  const nodeOs = require('os');
  const testHome = nodePath.join(nodeOs.tmpdir(), 'agents-cli-browser-service-test');
  const testAgentsDir = nodePath.join(testHome, '.agents');
  const testBrowserDir = nodePath.join(testAgentsDir, 'browser');

  function readProfileYaml(name: string) {
    const profilePath = nodePath.join(testBrowserDir, 'profiles', `${name}.yaml`);
    if (!nodeFs.existsSync(profilePath)) return null;
    const raw = nodeYaml.parse(nodeFs.readFileSync(profilePath, 'utf-8')) as {
      name: string;
      browser: string;
      endpoints: string[];
    };
    return { name: raw.name, browser: raw.browser, endpoints: raw.endpoints };
  }

  const actual = await importOriginal<typeof import('./profiles.js')>();
  return {
    ...actual,
    getBrowserRuntimeDir: () => testBrowserDir,
    getProfileRuntimeDir: (name: string) => nodePath.join(testBrowserDir, name),
    listProfiles: async () => {
      const profilesDir = nodePath.join(testBrowserDir, 'profiles');
      if (!nodeFs.existsSync(profilesDir)) return [];
      return nodeFs
        .readdirSync(profilesDir)
        .filter((f: string) => f.endsWith('.yaml'))
        .map((f: string) => readProfileYaml(nodePath.basename(f, '.yaml')))
        .filter(Boolean);
    },
    getProfile: async (name: string) => readProfileYaml(name),
  };
});

const { BrowserService } = await import('./service.js');

function reset() {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // ignore
  }
  fs.mkdirSync(TEST_AGENTS_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_AGENTS_DIR, 'browser', 'profiles'), { recursive: true });
}

function writeProfile(name: string, endpoints: string[], browserType = 'chrome'): void {
  const profile = { name, browser: browserType, endpoints };
  fs.writeFileSync(
    path.join(TEST_AGENTS_DIR, 'browser', 'profiles', `${name}.yaml`),
    yaml.stringify(profile)
  );
}

function writeRunningChrome(profileName: string, port: number, pid: number): void {
  const runtimeDir = path.join(TEST_AGENTS_DIR, 'browser', profileName);
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'pid'), String(pid));
  fs.writeFileSync(path.join(runtimeDir, 'port'), String(port));
}

function writeTaskState(
  profileName: string,
  tasks: Array<{ id: string; tabIds: string[]; createdAt: number }>
): void {
  const runtimeDir = path.join(TEST_AGENTS_DIR, 'browser', profileName);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const state: Record<string, unknown> = {};
  for (const t of tasks) {
    state[t.id] = {
      id: t.id,
      profile: profileName,
      tabIds: t.tabIds,
      createdAt: t.createdAt,
      pid: 0,
    };
  }
  fs.writeFileSync(path.join(runtimeDir, 'tasks.json'), JSON.stringify(state));
}

beforeEach(reset);
afterEach(() => {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('BrowserService.status — disk reconciliation (Issue #6)', () => {
  it('returns empty when no profiles exist', async () => {
    const service = new BrowserService();
    const result = await service.status();
    expect(result).toEqual([]);
  });

  it('reconciles a profile whose pid is alive but daemon has no in-memory connection', async () => {
    writeProfile('rush-mini', ['cdp://localhost:9222']);
    writeRunningChrome('rush-mini', 9222, process.pid); // process.pid is guaranteed alive
    writeTaskState('rush-mini', [{ id: 'work', tabIds: ['tab1', 'tab2'], createdAt: 100 }]);

    const service = new BrowserService();
    const result = await service.status();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'rush-mini',
      running: true,
      port: 9222,
      pid: process.pid,
    });
    expect(result[0].tasks).toHaveLength(1);
    expect(result[0].tasks[0]).toMatchObject({ id: 'work', tabCount: 2, createdAt: 100 });
  });

  it('drops profiles whose pid is no longer alive (stale pid file)', async () => {
    writeProfile('dead-profile', ['cdp://localhost:9222']);
    writeRunningChrome('dead-profile', 9222, 999_999); // unlikely to be alive

    const service = new BrowserService();
    const result = await service.status();

    expect(result).toHaveLength(0);

    // getRunningChromeInfo should have cleaned up the stale files
    const runtimeDir = path.join(TEST_AGENTS_DIR, 'browser', 'dead-profile');
    expect(fs.existsSync(path.join(runtimeDir, 'pid'))).toBe(false);
    expect(fs.existsSync(path.join(runtimeDir, 'port'))).toBe(false);
  });

  it('surfaces configured-vs-running port when they differ (Loop C residual)', async () => {
    writeProfile('drift', ['cdp://localhost:9222']);
    writeRunningChrome('drift', 9200, process.pid); // configured 9222, running 9200

    const service = new BrowserService();
    const result = await service.status();

    expect(result).toHaveLength(1);
    expect(result[0].port).toBe(9200);
    expect(result[0].configuredPort).toBe(9222);
  });

  it('omits configuredPort when configured matches running', async () => {
    writeProfile('match', ['cdp://localhost:9222']);
    writeRunningChrome('match', 9222, process.pid);

    const service = new BrowserService();
    const result = await service.status();

    expect(result).toHaveLength(1);
    expect(result[0].port).toBe(9222);
    expect(result[0].configuredPort).toBeUndefined();
  });

  it('filters by profile name when one is provided', async () => {
    writeProfile('a', ['cdp://localhost:9222']);
    writeProfile('b', ['cdp://localhost:9223']);
    writeRunningChrome('a', 9222, process.pid);
    writeRunningChrome('b', 9223, process.pid);

    const service = new BrowserService();
    const result = await service.status('a');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('a');
  });
});

// -----------------------------------------------------------------------------
// pickWindowTarget / parseTargetFilter
//
// These helpers exist because Electron apps frequently expose multiple
// `type: 'page'` CDP targets per process: the visible window plus invisible
// helpers (background services, OAuth windows, file:// shells). Without these,
// `agents browser start` against an Electron app silently latches onto whatever
// target is enumerated first by CDP — almost always wrong, with no signal to
// the user other than blank screenshots.
// -----------------------------------------------------------------------------
describe('parseTargetFilter', () => {
  it('parses url:<substring>', async () => {
    const { parseTargetFilter } = await import('./service.js');
    expect(parseTargetFilter('url:https://www.canva.com/')).toEqual({
      kind: 'url',
      value: 'https://www.canva.com/',
    });
  });

  it('parses title:<substring>', async () => {
    const { parseTargetFilter } = await import('./service.js');
    expect(parseTargetFilter('title:Home - Canva')).toEqual({
      kind: 'title',
      value: 'Home - Canva',
    });
  });

  it('treats kind as case-insensitive', async () => {
    const { parseTargetFilter } = await import('./service.js');
    expect(parseTargetFilter('URL:foo')?.kind).toBe('url');
    expect(parseTargetFilter('Title:bar')?.kind).toBe('title');
  });

  it('returns null for unknown kind, missing colon, empty value, or undefined', async () => {
    const { parseTargetFilter } = await import('./service.js');
    expect(parseTargetFilter('hostname:foo')).toBeNull();
    expect(parseTargetFilter('foobar')).toBeNull();
    expect(parseTargetFilter('url:')).toBeNull();
    expect(parseTargetFilter('')).toBeNull();
    expect(parseTargetFilter(undefined)).toBeNull();
  });

  it('trims whitespace around the value (copy-paste safety)', async () => {
    // `url: https://x` (space after colon) used to parse to value=' https://x',
    // which silently never matched any real URL. Strip both sides.
    const { parseTargetFilter } = await import('./service.js');
    expect(parseTargetFilter('url: https://www.canva.com/ ')).toEqual({
      kind: 'url',
      value: 'https://www.canva.com/',
    });
    // Whitespace-only value is equivalent to empty value.
    expect(parseTargetFilter('url:   ')).toBeNull();
  });
});

describe('pickWindowTarget', () => {
  // Canonical Canva target list captured live against `:9201/json`.
  // The first page is the invisible Desktop Background Service — the bug
  // we're fixing is that the original `find(t.type === 'page')` returns
  // this target and screenshots come back blank.
  const canvaTargets = [
    {
      targetId: 'C1AEAD00',
      type: 'page',
      url: 'https://www.canva.com/_desktop-background-service',
      title: 'Desktop Background Service',
    },
    {
      targetId: 'B351F950',
      type: 'page',
      url: 'https://www.canva.com/',
      title: 'Home - Canva',
    },
    {
      targetId: 'FBBCAA2F',
      type: 'page',
      url: 'file:///Applications/Canva.app/Contents/Resources/app.asar/dist/index.dynamic_locale.html',
      title: 'index.dynamic_locale.html',
    },
    { targetId: 'SW1', type: 'service_worker', url: 'https://www.canva.com/sw.js' },
  ];

  it('explicit url filter wins over enumeration order', async () => {
    const { pickWindowTarget } = await import('./service.js');
    const hit = pickWindowTarget(canvaTargets, 'url:https://www.canva.com/');
    expect(hit?.targetId).toBe('B351F950');
  });

  it('explicit title filter wins over enumeration order', async () => {
    const { pickWindowTarget } = await import('./service.js');
    const hit = pickWindowTarget(canvaTargets, 'title:Home - Canva');
    expect(hit?.targetId).toBe('B351F950');
  });

  it('substring match is case-insensitive on both haystack and needle', async () => {
    const { pickWindowTarget } = await import('./service.js');
    const hit = pickWindowTarget(canvaTargets, 'title:HOME');
    expect(hit?.targetId).toBe('B351F950');
  });

  it('explicit filter that misses returns undefined — caller must surface the failure', async () => {
    const { pickWindowTarget } = await import('./service.js');
    // The caller (getOrCreateWindow) turns this into a thrown error listing
    // the candidates. Returning undefined here keeps the helper pure.
    expect(pickWindowTarget(canvaTargets, 'url:does-not-exist')).toBeUndefined();
  });

  it('with no filter, skips _desktop-background-service and file:// shells', async () => {
    const { pickWindowTarget } = await import('./service.js');
    const hit = pickWindowTarget(canvaTargets, undefined);
    expect(hit?.targetId).toBe('B351F950');
  });

  it('with no filter and no visible candidate, falls back to first page target', async () => {
    const { pickWindowTarget } = await import('./service.js');
    const allInvisible = [
      { targetId: 'A', type: 'page', url: 'about:blank' },
      { targetId: 'B', type: 'page', url: 'file:///x' },
    ];
    const hit = pickWindowTarget(allInvisible, undefined);
    expect(hit?.targetId).toBe('A');
  });

  it('returns undefined when no page targets exist at all', async () => {
    const { pickWindowTarget } = await import('./service.js');
    const workerOnly = [{ targetId: 'SW', type: 'service_worker', url: 'sw.js' }];
    expect(pickWindowTarget(workerOnly, undefined)).toBeUndefined();
  });

  it('malformed filter falls back to heuristic instead of throwing', async () => {
    const { pickWindowTarget } = await import('./service.js');
    // Garbage filter should not crash; treat as if absent.
    const hit = pickWindowTarget(canvaTargets, 'not-a-valid-filter');
    expect(hit?.targetId).toBe('B351F950');
  });

  it('explicit filter, all matches invisible — returns first match (documented fallback)', async () => {
    // If every match is invisible, the helper still returns *something* rather
    // than `undefined`. The caller can decide to surface a warning if needed.
    // Caught here so a future refactor doesn't accidentally drop the `?? matches[0]`.
    const { pickWindowTarget } = await import('./service.js');
    const invisibleMatches = [
      {
        targetId: 'BG1',
        type: 'page',
        url: 'https://www.canva.com/_desktop-background-service',
        title: 'Desktop Background Service',
      },
      {
        targetId: 'BG2',
        type: 'page',
        url: 'https://www.canva.com/_internal',
        title: 'Internal',
      },
    ];
    const hit = pickWindowTarget(invisibleMatches, 'url:canva.com');
    expect(hit?.targetId).toBe('BG1');
  });
});
