import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'node:events';
import * as yaml from 'yaml';
import * as state from '../state.js';
import * as profiles from './profiles.js';

const TEST_HOME = path.join(tmpdir(), 'agents-cli-browser-service-test');
const TEST_AGENTS_DIR = path.join(TEST_HOME, '.agents');
const TEST_BROWSER_DIR = path.join(TEST_AGENTS_DIR, 'browser');

vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(TEST_AGENTS_DIR);
vi.spyOn(state, 'getAgentsDir').mockReturnValue(TEST_AGENTS_DIR);
vi.spyOn(state, 'getBrowserRuntimeDir').mockReturnValue(TEST_BROWSER_DIR);

// Override the four profiles.js exports the test needs via vi.spyOn instead
// of a full vi.mock factory — keeps every other export real and avoids
// needing vi.hoisted / vi.importActual, neither of which Bun's native test
// runner supports.
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

const { BrowserService, resolveScreenshotOutputPath } = await import('./service.js');

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

describe('resolveScreenshotOutputPath', () => {
  it('uses the runtime autopath when a requested output path is outside browser runtime', () => {
    const automaticPath = path.join(TEST_BROWSER_DIR, 'sessions', 'task', '1.jpg');
    const outsidePath = path.join(tmpdir(), 'outside-browser-runtime.jpg');

    expect(resolveScreenshotOutputPath(outsidePath, automaticPath)).toBe(automaticPath);
  });

  it('allows requested output paths inside browser runtime', () => {
    const automaticPath = path.join(TEST_BROWSER_DIR, 'sessions', 'task', '1.jpg');
    const requestedPath = path.join(TEST_BROWSER_DIR, 'exports', 'shot.jpg');
    const resolved = resolveScreenshotOutputPath(requestedPath, automaticPath);

    expect(resolved.endsWith(path.join('exports', 'shot.jpg'))).toBe(true);
    expect(resolved).not.toBe(automaticPath);
  });
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

// -----------------------------------------------------------------------------
// recordStop ffmpeg-exit handling (#560)
//
// Before the fix, recordStop's 5s wait only RESOLVED the promise — it never
// killed a hung ffmpeg and never inspected the exit code, so a failed encode
// (bad codec, missing encoder, corrupt output) reported success with a
// silently-empty .webm. We inject a fake ffmpeg + recording state straight into
// the private `recordings` map so the finalize path runs without spawning real
// ffmpeg or CDP.
// -----------------------------------------------------------------------------
function fakeFfmpeg() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { end: () => void };
    kill: (sig?: string) => void;
  };
  child.stdin = { end: () => {} };
  child.kill = () => {};
  return child;
}

function injectRecording(
  svc: InstanceType<typeof BrowserService>,
  taskId: string,
  overrides: {
    outputPath?: string;
    ffmpeg?: ReturnType<typeof fakeFfmpeg>;
    ffmpegStderr?: () => string;
  } = {}
): ReturnType<typeof fakeFfmpeg> {
  const ffmpeg = overrides.ffmpeg ?? fakeFfmpeg();
  const durationTimer = setTimeout(() => {}, 1_000_000);
  const sizeCheckInterval = setInterval(() => {}, 1_000_000);
  (svc as unknown as { recordings: Map<string, unknown> }).recordings.set(taskId, {
    outputPath: overrides.outputPath ?? path.join(tmpdir(), 'rec-missing.webm'),
    startedAt: Date.now() - 1000,
    fps: 5,
    maxBytes: 25 * 1024 * 1024,
    durationMs: 60_000,
    ffmpeg,
    ffmpegStderr: overrides.ffmpegStderr ?? (() => ''),
    sessionId: 'sess-1',
    conn: { cdp: { off: () => {}, send: async () => {} } },
    frameHandler: () => {},
    durationTimer,
    sizeCheckInterval,
  });
  return ffmpeg;
}

describe('recordStop ffmpeg exit handling (#560)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('surfaces a non-zero ffmpeg exit as failure (not silent success)', async () => {
    const svc = new BrowserService();
    const ffmpeg = fakeFfmpeg();
    // Closing stdin makes a broken ffmpeg flush and exit non-zero.
    ffmpeg.stdin.end = () => setImmediate(() => ffmpeg.emit('exit', 1));
    injectRecording(svc, 'task-fail', {
      ffmpeg,
      ffmpegStderr: () => '[libvpx-vp9] failed to encode frame',
    });

    await expect(svc.recordStop('task-fail')).rejects.toThrow(/exited abnormally \(code 1\)/);
  });

  it('includes ffmpeg stderr in the failure so the encode error is diagnosable', async () => {
    const svc = new BrowserService();
    const ffmpeg = fakeFfmpeg();
    ffmpeg.stdin.end = () => setImmediate(() => ffmpeg.emit('exit', 234));
    injectRecording(svc, 'task-diag', {
      ffmpeg,
      ffmpegStderr: () => 'Unknown encoder libvpx-vp9',
    });

    await expect(svc.recordStop('task-diag')).rejects.toThrow(/Unknown encoder libvpx-vp9/);
  });

  it('drops the recording from the map even when finalize fails', async () => {
    const svc = new BrowserService();
    const ffmpeg = fakeFfmpeg();
    ffmpeg.stdin.end = () => setImmediate(() => ffmpeg.emit('exit', 1));
    injectRecording(svc, 'task-clean', { ffmpeg });

    await expect(svc.recordStop('task-clean')).rejects.toThrow();
    const recordings = (svc as unknown as { recordings: Map<string, unknown> }).recordings;
    expect(recordings.has('task-clean')).toBe(false);
  });

  it('kills a hung ffmpeg on the 5s timeout and reports failure', async () => {
    vi.useFakeTimers();
    const svc = new BrowserService();
    const kill = vi.fn();
    const ffmpeg = fakeFfmpeg();
    ffmpeg.kill = kill;
    ffmpeg.stdin.end = () => {}; // never emits 'exit' — ffmpeg is hung
    injectRecording(svc, 'task-hang', { ffmpeg });

    const p = svc.recordStop('task-hang');
    const assertion = expect(p).rejects.toThrow(/did not exit within 5s/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('returns success with a real byte count on a clean (exit 0) finalize', async () => {
    const svc = new BrowserService();
    const outputPath = path.join(tmpdir(), `rec-ok-${process.pid}-${Date.now()}.webm`);
    fs.writeFileSync(outputPath, Buffer.alloc(2048, 7));
    try {
      const ffmpeg = fakeFfmpeg();
      ffmpeg.stdin.end = () => setImmediate(() => ffmpeg.emit('exit', 0));
      injectRecording(svc, 'task-ok', { ffmpeg, outputPath });

      const res = await svc.recordStop('task-ok');
      expect(res.path).toBe(outputPath);
      expect(res.bytes).toBe(2048);
      expect(res.reason).toBe('manual');
    } finally {
      fs.rmSync(outputPath, { force: true });
    }
  });
});

describe('BrowserService.stopProfile — composite-key cleanup (#559)', () => {
  it('cleans up a connection stored under the composite `<profile>@<endpoint>` when called with the bare profile name', async () => {
    writeProfile('winmini', ['ssh://muqsit@win-mini?port=9222&os=windows'], 'edge');
    const service = new BrowserService();

    const cleanup = vi.fn();
    const fakeConn = {
      cdp: { close: vi.fn() },
      pid: 2_000_000_000, // non-existent → killChrome's process.kill throws ESRCH (caught)
      cleanup,
      tasks: new Map(),
      sessionCache: new Map(),
    };
    // start() keys the map on the composite, not the bare name.
    const conns = (service as unknown as { connections: Map<string, unknown> }).connections;
    conns.set('winmini@win-mini', fakeConn);

    await service.stopProfile('winmini');

    // Before the fix, get('winmini') missed the composite key and cleanup never ran.
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fakeConn.cdp.close).toHaveBeenCalledTimes(1);
    expect(conns.has('winmini@win-mini')).toBe(false);
  });

  it('does not touch a different profile that happens to share a name prefix', async () => {
    const service = new BrowserService();
    const conns = (service as unknown as { connections: Map<string, unknown> }).connections;
    const otherCleanup = vi.fn();
    conns.set('winmini2@ep', { cdp: { close: vi.fn() }, pid: 2_000_000_000, cleanup: otherCleanup, tasks: new Map() });

    await service.stopProfile('winmini');

    // "winmini2@ep" must NOT match the "winmini" stop (prefix must be `winmini@`).
    expect(otherCleanup).not.toHaveBeenCalled();
    expect(conns.has('winmini2@ep')).toBe(true);
  });
});
