/**
 * Real-path tests for identity-based task resolution, labels, profile bare-name
 * matching, and disk rehydration — no mocks of the service internals.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import * as yaml from 'yaml';
import * as state from '../state.js';
import * as profiles from './profiles.js';

const TEST_HOME = path.join(tmpdir(), `agents-cli-browser-resolve-${process.pid}`);
const TEST_AGENTS_DIR = path.join(TEST_HOME, '.agents');
const TEST_BROWSER_DIR = path.join(TEST_AGENTS_DIR, 'browser');

vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(TEST_AGENTS_DIR);
vi.spyOn(state, 'getAgentsDir').mockReturnValue(TEST_AGENTS_DIR);
vi.spyOn(state, 'getBrowserRuntimeDir').mockReturnValue(TEST_BROWSER_DIR);

function readProfileYaml(name: string): { name: string; browser: string; endpoints: string[] } | null {
  const profilePath = path.join(TEST_BROWSER_DIR, 'profiles', `${name}.yaml`);
  if (!fs.existsSync(profilePath)) return null;
  const raw = yaml.parse(fs.readFileSync(profilePath, 'utf-8')) as {
    name: string;
    browser: string;
    endpoints: string[];
  };
  return { name: raw.name, browser: raw.browser, endpoints: raw.endpoints };
}

vi.spyOn(profiles, 'getBrowserRuntimeDir').mockReturnValue(TEST_BROWSER_DIR);
vi.spyOn(profiles, 'getProfileRuntimeDir').mockImplementation(
  (name: string) => path.join(TEST_BROWSER_DIR, name),
);
vi.spyOn(profiles, 'listProfiles').mockImplementation(async () => {
  const profilesDir = path.join(TEST_BROWSER_DIR, 'profiles');
  if (!fs.existsSync(profilesDir)) return [];
  return fs
    .readdirSync(profilesDir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => readProfileYaml(path.basename(f, '.yaml')))
    .filter((p): p is { name: string; browser: string; endpoints: string[] } => p !== null);
});
vi.spyOn(profiles, 'getProfile').mockImplementation(async (name: string) => readProfileYaml(name));

const {
  BrowserService,
  deriveTaskLabel,
  connectionKeyMatchesProfile,
  actionable,
} = await import('./service.js');

function reset() {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  fs.mkdirSync(path.join(TEST_AGENTS_DIR, 'browser', 'profiles'), { recursive: true });
}

function writeProfile(name: string, endpoints: string[] = ['cdp://127.0.0.1:9333']): void {
  fs.writeFileSync(
    path.join(TEST_BROWSER_DIR, 'profiles', `${name}.yaml`),
    yaml.stringify({ name, browser: 'chrome', endpoints }),
  );
}

function stubConn(
  service: BrowserService,
  key: string,
  tasks: Array<Record<string, unknown>>,
  bareName?: string,
): void {
  const map = new Map();
  for (const t of tasks) {
    const name = String(t.name);
    map.set(name, {
      id: t.id ?? name,
      name,
      label: t.label ?? name,
      profile: key,
      tabs: t.tabs ?? {},
      currentTabId: t.currentTabId,
      createdAt: t.createdAt ?? Date.now(),
      lastActionAt: t.lastActionAt ?? Date.now(),
      pid: 0,
      sessionId: t.sessionId,
      launchId: t.launchId,
      owner: t.owner,
    });
  }
  (service as unknown as { connections: Map<string, unknown> }).connections.set(key, {
    cdp: { send: async () => ({ targetInfos: [] }), close: () => {} },
    port: 9333,
    pid: 1,
    tasks: map,
    sessionCache: new Map(),
    profileName: key,
    bareName: bareName ?? key.split('@')[0],
  });
}

beforeEach(reset);
afterEach(() => {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('deriveTaskLabel', () => {
  it('prefers an explicit title', () => {
    expect(deriveTaskLabel({ title: 'PR 911', url: 'https://example.com' })).toBe('PR 911');
  });

  it('uses the host of the first navigated URL', () => {
    expect(deriveTaskLabel({ url: 'https://www.github.com/org/repo' })).toBe('github.com');
  });

  it('falls back to untitled', () => {
    expect(deriveTaskLabel({})).toBe('untitled');
  });

  it('keeps an existing non-untitled label', () => {
    expect(deriveTaskLabel({ existing: 'github.com', url: 'https://example.com' })).toBe('github.com');
  });
});

describe('connectionKeyMatchesProfile', () => {
  it('matches bare name to composite endpoint and fork keys', () => {
    expect(connectionKeyMatchesProfile('comet-local', 'comet-local')).toBe(true);
    expect(connectionKeyMatchesProfile('comet-local@endpoint-0', 'comet-local')).toBe(true);
    expect(connectionKeyMatchesProfile('comet-local.2', 'comet-local')).toBe(true);
    expect(connectionKeyMatchesProfile('comet-other@endpoint-0', 'comet-local')).toBe(false);
  });
});

describe('actionable', () => {
  it('joins non-empty lines', () => {
    expect(actionable('a', '', 'b')).toBe('a\nb');
  });
});

describe('resolveOrCreateTask — identity', () => {
  it('uses the single live task for this caller silently', async () => {
    const service = new BrowserService();
    stubConn(service, 'work@endpoint-0', [
      {
        id: 'aaaa',
        name: 'aaaa',
        label: 'example.com',
        sessionId: 'sess-1',
        createdAt: Date.now() - 60_000,
      },
    ]);

    const resolved = await service.resolveOrCreateTask({
      sessionId: 'sess-1',
      createIfMissing: false,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.task.name).toBe('aaaa');
    expect(resolved!.created).toBe(false);
  });

  it('lists every matching task when the caller has more than one', async () => {
    const service = new BrowserService();
    stubConn(service, 'work@endpoint-0', [
      {
        id: 't1',
        name: 't1',
        label: 'github.com',
        sessionId: 'sess-1',
        createdAt: Date.now() - 120_000,
      },
      {
        id: 't2',
        name: 't2',
        label: 'example.com',
        sessionId: 'sess-1',
        createdAt: Date.now() - 30_000,
      },
    ]);

    await expect(
      service.resolveOrCreateTask({ sessionId: 'sess-1', createIfMissing: false }),
    ).rejects.toThrow(/Multiple browser tasks/);
    await expect(
      service.resolveOrCreateTask({ sessionId: 'sess-1', createIfMissing: false }),
    ).rejects.toThrow(/--task/);
    await expect(
      service.resolveOrCreateTask({ sessionId: 'sess-1', createIfMissing: false }),
    ).rejects.toThrow(/github\.com/);
  });

  it('returns null for done/stop when the caller has no task (never creates)', async () => {
    const service = new BrowserService();
    const resolved = await service.resolveOrCreateTask({
      sessionId: 'sess-none',
      createIfMissing: false,
    });
    expect(resolved).toBeNull();
  });
});

describe('status — bare profile name', () => {
  it('lists composite-key tasks under a bare --profile name', async () => {
    writeProfile('comet-local');
    const service = new BrowserService();
    stubConn(
      service,
      'comet-local@endpoint-0',
      [
        {
          id: 'bbbb',
          name: 'bbbb',
          label: 'github.com',
          sessionId: 's',
          tabs: { tab1: 'cdp-1' },
        },
      ],
      'comet-local',
    );

    const bare = await service.status('comet-local');
    const full = await service.status();
    expect(bare.length).toBeGreaterThan(0);
    expect(bare[0]!.tasks.map((t) => t.name)).toEqual(
      full.flatMap((p) => p.tasks.map((t) => t.name)).filter((n) => n === 'bbbb'),
    );
    expect(bare[0]!.tasks[0]!.label).toBe('github.com');
  });
});

describe('disk task state + identity', () => {
  it('loadTaskState preserves sessionId so identity match works after rehydrate', async () => {
    writeProfile('work');
    const runtimeKey = 'work@endpoint-0';
    const runtimeDir = path.join(TEST_BROWSER_DIR, runtimeKey);
    fs.mkdirSync(runtimeDir, { recursive: true });
    const taskName = 'rehydrate-me';
    fs.writeFileSync(
      path.join(runtimeDir, 'tasks.json'),
      JSON.stringify({
        [taskName]: {
          id: 'rh01',
          name: taskName,
          label: 'example.com',
          profile: runtimeKey,
          tabs: { tab1: 'cdp-target-1' },
          currentTabId: 'tab1',
          createdAt: Date.now(),
          lastActionAt: Date.now(),
          pid: 0,
          sessionId: 'sess-rh',
          launchId: 'launch-rh',
        },
      }),
    );

    const service = new BrowserService();
    // Simulate post-rehydrate: connection holds the tasks that were on disk.
    const loaded = (
      service as unknown as { loadTaskState: (n: string) => Map<string, Record<string, unknown>> }
    ).loadTaskState(runtimeKey);
    expect(loaded.get(taskName)?.sessionId).toBe('sess-rh');

    stubConn(
      service,
      runtimeKey,
      [
        {
          id: 'rh01',
          name: taskName,
          label: 'example.com',
          sessionId: 'sess-rh',
          launchId: 'launch-rh',
          tabs: { tab1: 'cdp-1' },
        },
      ],
      'work',
    );

    const resolved = await service.resolveOrCreateTask({
      sessionId: 'sess-rh',
      createIfMissing: false,
    });
    expect(resolved?.task.name).toBe(taskName);
    expect(resolved?.created).toBe(false);
  });
});
