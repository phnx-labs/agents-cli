import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'node:events';
import * as yaml from 'yaml';
import * as state from '../state.js';
import * as profiles from './profiles.js';
import { query, _resetForTest } from '../feed/events.js';

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

const { BrowserService, resolveScreenshotOutputPath, resolveTaskIdentity, arcNotDrivableError } = await import('./service.js');

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

describe('resolveTaskIdentity — task owner/launchId attribution', () => {
  it('stamps the forwarded actor + launchId verbatim and never re-resolves', () => {
    let localCalled = false;
    const id = resolveTaskIdentity(
      { actor: 'agent:kimi-run-7', launchId: 'launch-abc' },
      () => {
        localCalled = true;
        return 'daemon-owner';
      }
    );
    expect(id).toEqual({ owner: 'agent:kimi-run-7', launchId: 'launch-abc' });
    // The daemon must NOT re-resolve when the caller forwarded an actor — that
    // was the RUSH-2020 bug (every task attributed to the daemon's own actor).
    expect(localCalled).toBe(false);
  });

  it('falls back to the local actor only when none was forwarded (pre-field CLI)', () => {
    const id = resolveTaskIdentity({ launchId: 'launch-xyz' }, () => 'muqsit');
    expect(id).toEqual({ owner: 'muqsit', launchId: 'launch-xyz' });
  });

  it('carries an undefined launchId through untouched', () => {
    const id = resolveTaskIdentity({ actor: 'muqsit' }, () => 'unused');
    expect(id.owner).toBe('muqsit');
    expect(id.launchId).toBeUndefined();
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

  // Regression: soft rehydrate must not clearProfileRuntime (CI shard 2).
  it('status still reconciles from disk when CDP is unreachable (no clear of pid files)', async () => {
    // Port with nothing listening — soft rehydrate must not clear pid/port
    // (connectProfile used to, which made status return [] on CI).
    const deadPort = 19_987;
    writeProfile('disk-only', [`cdp://localhost:${deadPort}`]);
    writeRunningChrome('disk-only', deadPort, process.pid);
    writeTaskState('disk-only', [{ id: 'orphan', tabIds: ['t1'], createdAt: 50 }]);

    const service = new BrowserService();
    const result = await service.status();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'disk-only',
      running: true,
      port: deadPort,
      pid: process.pid,
    });
    expect(result[0].tasks).toHaveLength(1);
    expect(result[0].tasks[0]).toMatchObject({ id: 'orphan', tabCount: 1 });

    // Runtime files must survive the failed soft attach.
    const runtimeDir = path.join(TEST_AGENTS_DIR, 'browser', 'disk-only');
    expect(fs.existsSync(path.join(runtimeDir, 'pid'))).toBe(true);
    expect(fs.existsSync(path.join(runtimeDir, 'port'))).toBe(true);
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

describe('navigate/screenshot — emit typed events (#11)', () => {
  afterEach(() => {
    _resetForTest();
  });

  function eventsPath(): string {
    return path.join(
      TEST_HOME,
      `events-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
    );
  }

  // Minimal-but-valid PNG header: signature + IHDR length/type + width/height.
  // readPngDimensions() only inspects these 24 bytes, so this is a real decode,
  // not a canned dimension value.
  function fakePngBase64(width: number, height: number): string {
    const buf = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return buf.toString('base64');
  }

  function makeFakeConn(taskName: string, tabId: string) {
    const tasks = new Map();
    tasks.set(taskName, {
      id: taskName,
      name: taskName,
      profile: 'evprofile',
      tabs: { [tabId]: 'cdp-target-1' },
      currentTabId: tabId,
      createdAt: Date.now(),
      pid: 123,
    });
    const conn = {
      cdp: {
        send: vi.fn(async (method: string) => {
          switch (method) {
            case 'Target.attachToTarget':
              return { sessionId: 'sess-1' };
            case 'Page.navigate':
              return {};
            case 'Target.getTargets':
              return { targetInfos: [{ targetId: 'cdp-target-1', url: 'https://example.com', title: 'Example' }] };
            case 'Page.captureScreenshot':
              return { data: fakePngBase64(10, 5) };
            default:
              throw new Error(`unexpected CDP call in test: ${method}`);
          }
        }),
      },
      port: 9333,
      pid: 123,
      tasks,
      sessionCache: new Map(),
    };
    return conn;
  }

  it('navigate() reusing the current tab emits browser.navigate with profile/task/url', async () => {
    _resetForTest(eventsPath());
    const service = new BrowserService();
    const conn = makeFakeConn('evtask', 'tab0001');
    (service as unknown as { connections: Map<string, unknown> }).connections.set('evprofile', conn);

    const result = await service.navigate('evtask', 'https://example.com/page');

    expect(result).toEqual({ tabId: 'tab0001', url: 'https://example.com/page', created: false });
    const recs = query({ eventTypes: ['browser.navigate'] });
    expect(recs).toHaveLength(1);
    expect(recs[0].profile).toBe('evprofile');
    expect(recs[0].task).toBe('evtask');
    expect(recs[0].url).toBe('https://example.com/page');
    expect(recs[0].created).toBe(false);
  });

  it('screenshot() emits browser.screenshot with the real path/bytes/dimensions', async () => {
    _resetForTest(eventsPath());
    const service = new BrowserService();
    const conn = makeFakeConn('evtask2', 'tab0002');
    (service as unknown as { connections: Map<string, unknown> }).connections.set('evprofile2', conn);
    (conn as unknown as { tasks: Map<string, { profile: string }> }).tasks.get('evtask2')!.profile = 'evprofile2';

    const result = await service.screenshot('evtask2', undefined, undefined, 'raw');

    expect(result.width).toBe(10);
    expect(result.height).toBe(5);
    expect(fs.existsSync(result.path)).toBe(true);

    const recs = query({ eventTypes: ['browser.screenshot'] });
    expect(recs).toHaveLength(1);
    expect(recs[0].profile).toBe('evprofile2');
    expect(recs[0].task).toBe('evtask2');
    expect(recs[0].path).toBe(result.path);
    expect(recs[0].bytes).toBe(result.bytes);
    expect(recs[0].width).toBe(10);
    expect(recs[0].height).toBe(5);
    expect(recs[0].quality).toBe('raw');
  });
});

// ─── RUSH-2622: leftover tabs ────────────────────────────────────────────────
//
// Three leaks fed the pile-up, each covered below: the startup about:blank was
// never registered on the task (so `done` could not close it), a repeat `start`
// on the same URL always opened another copy of the page, and nothing ever
// stopped a task whose agent had exited.

/** A CDP double backed by a real target list that create/close actually mutate. */
function makeTargetedConn(
  profile: string,
  opts: { pages?: Array<{ targetId: string; url: string }>; browser?: string } = {},
) {
  const targets: Array<{ targetId: string; type: string; url: string; title: string }> = (
    opts.pages ?? []
  ).map((p) => ({ targetId: p.targetId, type: 'page', url: p.url, title: p.url }));
  let seq = 0;
  const calls: Array<{ method: string; params: any }> = [];

  const conn = {
    cdp: {
      isOpen: true,
      close: vi.fn(),
      send: vi.fn(async (method: string, params: any = {}) => {
        calls.push({ method, params });
        switch (method) {
          case 'Browser.getVersion':
            return {};
          case 'Target.getTargets':
            return { targetInfos: targets.map((t) => ({ ...t })) };
          case 'Target.createTarget': {
            const targetId = `created-${++seq}`;
            targets.push({ targetId, type: 'page', url: params.url, title: params.url });
            return { targetId };
          }
          case 'Target.closeTarget': {
            const i = targets.findIndex((t) => t.targetId === params.targetId);
            if (i >= 0) targets.splice(i, 1);
            return {};
          }
          case 'Target.activateTarget':
            return {};
          case 'Target.attachToTarget':
            return { sessionId: `sess-${params.targetId}` };
          case 'Page.navigate':
            return {};
          default:
            throw new Error(`unexpected CDP call in test: ${method}`);
        }
      }),
    },
    port: 9222,
    pid: 4242,
    profileName: profile,
    browserType: opts.browser,
    tasks: new Map(),
    sessionCache: new Map(),
  };
  return { conn, targets, calls };
}

/** Seed a live connection so `start` reuses it instead of launching a browser. */
function attach(service: any, profile: string, conn: unknown): void {
  (service as { connections: Map<string, unknown> }).connections.set(`${profile}@endpoint-0`, conn);
}

function createTargetCount(calls: Array<{ method: string }>): number {
  return calls.filter((c) => c.method === 'Target.createTarget').length;
}

describe('BrowserService.start — the startup about:blank is a task tab (RUSH-2622)', () => {
  it('registers the blank tab it opens, so `done` can close it', async () => {
    writeProfile('blankp', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('blankp@endpoint-0');
    attach(service, 'blankp', conn);

    const started = await service.start('blankp');

    // The daemon opened exactly one page and it belongs to the task — before
    // the fix `task.tabs` was `{}` and this tab outlived every `done`.
    expect(targets).toHaveLength(1);
    const task = conn.tasks.get(started.name)!;
    expect(Object.values(task.tabs)).toEqual([targets[0].targetId]);
    expect(task.currentTabId).toBeDefined();

    await service.done(started.name);

    expect(targets).toHaveLength(0);
    expect(calls.some((c) => c.method === 'Target.closeTarget')).toBe(true);
    expect(conn.tasks.has(started.name)).toBe(false);
  });

  it('leaves a page the daemon did not open alone', async () => {
    writeProfile('blankp2', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('blankp2@endpoint-0', {
      pages: [{ targetId: 'users-own-tab', url: 'https://news.example/' }],
    });
    attach(service, 'blankp2', conn);

    const started = await service.start('blankp2');

    // A page target already exists, so no blank is opened and nothing the user
    // opened is adopted — `done` must never close somebody else's tab.
    expect(createTargetCount(calls)).toBe(0);
    expect(conn.tasks.get(started.name)!.tabs).toEqual({});

    await service.done(started.name);
    expect(targets.map((t) => t.targetId)).toEqual(['users-own-tab']);
  });
});

describe('BrowserService — Arc is not CDP-drivable (never Target.createTarget)', () => {
  // Arc answers Browser.getVersion (so the connection succeeds) but exposes zero
  // page targets and CRASHES on Target.createTarget (verified, PR #2778). Every
  // tab-creating path must refuse with a clear error instead of crashing Arc.
  it('start with a url throws the clear error and never creates a target', async () => {
    writeProfile('arcp', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = makeTargetedConn('arcp@endpoint-0', { browser: 'arc' });
    attach(service, 'arcp', conn);

    await expect(service.start('arcp', { url: 'https://example.com' })).rejects.toThrow(
      /not drivable/,
    );
    // The whole point: not one Target.createTarget reached Arc.
    expect(createTargetCount(calls)).toBe(0);
  });

  it('bare start (startup blank window) throws instead of createTarget', async () => {
    writeProfile('arcp2', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = makeTargetedConn('arcp2@endpoint-0', { browser: 'arc' });
    attach(service, 'arcp2', conn);

    await expect(service.start('arcp2')).rejects.toThrow(/Comet, Chrome, Chromium, or Brave/);
    expect(createTargetCount(calls)).toBe(0);
  });

  it('the error names the offending profile and points at a drivable browser', () => {
    const msg = arcNotDrivableError('arc-local').message;
    expect(msg).toContain('arc-local');
    expect(msg).toContain('--browser comet');
  });
});

describe('BrowserService.navigate — Arc reuses a tab rather than refusing (#2786)', () => {
  // Arc crashes on Target.createTarget (#2778) but DOES expose page targets and
  // honors Page.navigate on them -- measured against a live Arc: 33 targets,
  // navigate reused one, tab count unchanged. Refusing every navigate left the
  // doc unshown and callers back on raw `open`, i.e. the tab-spam #2779 was
  // meant to end. Reuse is deliberately narrow: only a tab already showing the
  // requested URL, or an empty new-tab page.
  function arcConnWithEmptyTask(profile: string, pages: Array<{ targetId: string; url: string }>) {
    const { conn, calls, targets } = makeTargetedConn(`${profile}@endpoint-0`, { browser: 'arc', pages });
    (conn as unknown as { tasks: Map<string, unknown> }).tasks.set('arctask', {
      id: 'arctask',
      name: 'arctask',
      profile,
      tabs: {},
      currentTabId: undefined,
      createdAt: Date.now(),
      pid: 4242,
    });
    return { conn, calls, targets };
  }

  it('navigates a tab already showing that url, and never calls createTarget', async () => {
    writeProfile('arcnav', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = arcConnWithEmptyTask('arcnav', [
      { targetId: 'doc-tab', url: 'file:///tmp/plan.html' },
    ]);
    attach(service, 'arcnav', conn);

    const r = await service.navigate('arctask', 'file:///tmp/plan.html', 'arcnav');

    expect(r.created).toBe(false);
    expect(createTargetCount(calls)).toBe(0);
    expect(calls.filter((c) => c.method === 'Page.navigate')).toHaveLength(1);
  });

  it('reuses an empty new-tab page when no tab shows the url yet', async () => {
    writeProfile('arcblank', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = arcConnWithEmptyTask('arcblank', [
      { targetId: 'blank-tab', url: 'about:blank' },
    ]);
    attach(service, 'arcblank', conn);

    const r = await service.navigate('arctask', 'file:///tmp/plan.html', 'arcblank');

    expect(r.created).toBe(false);
    expect(createTargetCount(calls)).toBe(0);
    expect(calls.filter((c) => c.method === 'Page.navigate')).toHaveLength(1);
  });

  it("reuses the user's own tab showing that url — but done() must NOT close it", async () => {
    // The reviewer's scenario for the first attempt at this fix: a tab the USER
    // opened, showing the url a task navigates to, was claimed and then closed by
    // that task's done(). Reuse is still correct here (re-showing the same
    // document in place is the whole point), but the tab must outlive the task.
    writeProfile('arcborrow', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = arcConnWithEmptyTask('arcborrow', [
      { targetId: 'users-own-tab', url: 'file:///tmp/plan.html' },
    ]);
    attach(service, 'arcborrow', conn);

    await service.navigate('arctask', 'file:///tmp/plan.html', 'arcborrow');
    const task = (conn as unknown as { tasks: Map<string, any> }).tasks.get('arctask');
    expect(Object.values(task.tabs)).toContain('users-own-tab');
    expect(task.borrowedTabs).toHaveLength(1);

    await service.done('arctask');

    // The user's tab is still there — never closed, and no close was attempted.
    expect(targets.map((t) => t.targetId)).toContain('users-own-tab');
    expect(calls.filter((c) => c.method === 'Target.closeTarget')).toHaveLength(0);
    expect(createTargetCount(calls)).toBe(0);
  });

  it('refuses rather than hijacking a page the user is reading', async () => {
    writeProfile('arcsafe', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = arcConnWithEmptyTask('arcsafe', [
      { targetId: 'users-article', url: 'https://news.example.com/story' },
    ]);
    attach(service, 'arcsafe', conn);

    await expect(service.navigate('arctask', 'file:///tmp/plan.html', 'arcsafe')).rejects.toThrow(
      /Comet, Chrome, Chromium, or Brave/,
    );
    expect(createTargetCount(calls)).toBe(0);
    expect(calls.filter((c) => c.method === 'Page.navigate')).toHaveLength(0);
  });
});

describe('BrowserService.start — URL reclaim (RUSH-2622)', () => {
  // A UUID no live process carries, so the real liveness predicate (registry +
  // process table) proves this task's owner gone without any injection.
  const GONE_SESSION = '33333333-3333-4333-8333-333333333333';

  it('reclaims the tab an abandoned task is still holding on that URL', async () => {
    writeProfile('reclaim', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('reclaim@endpoint-0');
    attach(service, 'reclaim', conn);

    const abandoned = await service.start('reclaim', {
      url: 'https://example.com/docs',
      sessionId: GONE_SESSION,
    });
    const next = await service.start('reclaim', { url: 'https://example.com/docs' });

    // One page, one create — the second start reclaimed the orphan's tab.
    expect(targets).toHaveLength(1);
    expect(createTargetCount(calls)).toBe(1);

    // Reclaim TRANSFERS rather than shares: two tasks pointing at one targetId
    // would mean the first `done` closes the other's tab.
    expect(conn.tasks.get(abandoned.name)!.tabs).toEqual({});
    expect(conn.tasks.get(abandoned.name)!.currentTabId).toBeUndefined();
    expect(Object.values(conn.tasks.get(next.name)!.tabs)).toEqual([targets[0].targetId]);
  });

  it('two concurrent starts never end up owning the same reclaimed tab', async () => {
    writeProfile('reclaimrace', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reclaimrace@endpoint-0');
    attach(service, 'reclaimrace', conn);

    await service.start('reclaimrace', {
      url: 'https://example.com/docs',
      sessionId: GONE_SESSION,
    });

    // Nothing serializes IPC requests, so both starts suspend on the same
    // liveness await and race for the one abandoned tab. Without the
    // post-await re-check both would return it, and the first `done` would
    // then close the other task's tab.
    const [a, b] = await Promise.all([
      service.start('reclaimrace', { url: 'https://example.com/docs' }),
      service.start('reclaimrace', { url: 'https://example.com/docs' }),
    ]);

    const owners = [a, b].map((s) => Object.values(conn.tasks.get(s.name)!.tabs)[0]);
    expect(owners[0]).not.toBe(owners[1]);
    expect(new Set(owners).size).toBe(2);
    // The loser opened its own tab rather than sharing.
    expect(targets).toHaveLength(2);
  });

  it('never takes a tab from a task whose owner cannot be proven gone', async () => {
    writeProfile('nosteal', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('nosteal@endpoint-0');
    attach(service, 'nosteal', conn);

    // No sessionId, so the owner can never be proven gone — the ordinary case
    // for a non-Claude harness. Stealing here would leave the first agent's
    // next `click`/`screenshot` throwing "No tabs open for this task".
    const live = await service.start('nosteal', { url: 'https://example.com/docs' });
    const other = await service.start('nosteal', { url: 'https://example.com/docs' });

    expect(createTargetCount(calls)).toBe(2);
    expect(targets).toHaveLength(2);
    expect(Object.values(conn.tasks.get(live.name)!.tabs)).toHaveLength(1);
    expect(Object.values(conn.tasks.get(other.name)!.tabs)).toHaveLength(1);
  });

  it('never adopts an unowned tab — that is the user\'s own tab', async () => {
    writeProfile('usertab', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('usertab@endpoint-0', {
      pages: [{ targetId: 'users-own-tab', url: 'https://example.com/docs' }],
    });
    attach(service, 'usertab', conn);

    const started = await service.start('usertab', { url: 'https://example.com/docs' });

    // Adopting it would make this task's `done` close a tab the user opened.
    expect(createTargetCount(calls)).toBe(1);
    expect(targets).toHaveLength(2);
    expect(Object.values(conn.tasks.get(started.name)!.tabs)).not.toContain('users-own-tab');

    await service.done(started.name);
    expect(targets.map((t) => t.targetId)).toEqual(['users-own-tab']);
  });

  it('never reclaims from an abandoned task that is mid-recording', async () => {
    writeProfile('recl-rec', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('recl-rec@endpoint-0');
    attach(service, 'recl-rec', conn);

    const abandoned = await service.start('recl-rec', {
      url: 'https://example.com/docs',
      sessionId: GONE_SESSION,
    });
    (service as unknown as { recordings: Map<string, unknown> }).recordings.set(abandoned.name, {
      outputPath: '/tmp/x.mp4',
      startedAt: Date.now(),
    });

    await service.start('recl-rec', { url: 'https://example.com/docs' });

    // Taking the recorded target would truncate the capture on the next `done`.
    expect(createTargetCount(calls)).toBe(2);
    expect(targets).toHaveLength(2);
    expect(Object.values(conn.tasks.get(abandoned.name)!.tabs)).toHaveLength(1);
  });

  it('matches a bare origin against the trailing-slash form Chrome reports', async () => {
    writeProfile('dedupurl', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, calls } = makeTargetedConn('dedupurl@endpoint-0');
    attach(service, 'dedupurl', conn);

    const abandoned = await service.start('dedupurl', {
      url: 'https://example.com/',
      sessionId: GONE_SESSION,
    });
    const reclaimed = Object.values(conn.tasks.get(abandoned.name)!.tabs)[0];

    // Requested bare, reported with the trailing slash — raw string compare
    // would miss every bare-origin match.
    const next = await service.start('dedupurl', { url: 'https://example.com' });

    expect(createTargetCount(calls)).toBe(1);
    expect(Object.values(conn.tasks.get(next.name)!.tabs)).toEqual([reclaimed]);
  });

  it('does not reclaim a different URL', async () => {
    writeProfile('dedupmiss', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('dedupmiss@endpoint-0');
    attach(service, 'dedupmiss', conn);

    await service.start('dedupmiss', { url: 'https://example.com/a', sessionId: GONE_SESSION });
    await service.start('dedupmiss', { url: 'https://example.com/b' });

    expect(createTargetCount(calls)).toBe(2);
    expect(targets).toHaveLength(2);
  });

  it('--fresh skips the reclaim even when an abandoned task holds that URL', async () => {
    writeProfile('freshp', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('freshp@endpoint-0');
    attach(service, 'freshp', conn);

    const abandoned = await service.start('freshp', {
      url: 'https://example.com/docs',
      sessionId: GONE_SESSION,
    });
    const second = await service.start('freshp', { url: 'https://example.com/docs', fresh: true });

    expect(createTargetCount(calls)).toBe(2);
    expect(targets).toHaveLength(2);
    expect(Object.values(conn.tasks.get(abandoned.name)!.tabs)).toHaveLength(1);
    expect(Object.values(conn.tasks.get(second.name)!.tabs)).toHaveLength(1);
  });
});

describe('Task.lastActionAt — activity stamp (RUSH-2622)', () => {
  it('starts equal to createdAt and advances on a task-scoped action', async () => {
    writeProfile('stampp', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn } = makeTargetedConn('stampp@endpoint-0');
    attach(service, 'stampp', conn);

    const started = await service.start('stampp', { url: 'https://example.com/one' });
    const task = conn.tasks.get(started.name)!;
    expect(task.lastActionAt).toBe(task.createdAt);

    const before = task.lastActionAt;
    await new Promise((r) => setTimeout(r, 5));
    await service.navigate(started.name, 'https://example.com/two');

    // navigate resolves through findTask, which is where the stamp is applied —
    // so every task-scoped action gets it without its own call site.
    expect(task.lastActionAt).toBeGreaterThan(before);
  });

  it('persists the stamp to tasks.json and normalizes a pre-RUSH-2622 task on read', async () => {
    writeProfile('loadp', ['cdp://localhost:9222']);
    const service = new BrowserService() as any;

    // A task written before the field existed.
    const runtimeDir = path.join(TEST_BROWSER_DIR, 'loadp');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, 'tasks.json'),
      JSON.stringify({
        legacy: { id: 'legacy', name: 'legacy', profile: 'loadp', tabs: {}, createdAt: 1000, pid: 0 },
      })
    );

    const loaded = service.loadTaskState('loadp') as Map<string, { lastActionAt: number }>;
    expect(loaded.get('legacy')!.lastActionAt).toBe(1000);
  });
});

describe('BrowserService.reapAbandoned — abandoned-task reaper (RUSH-2622)', () => {
  const LIVE_SESSION = '11111111-1111-4111-8111-111111111111';
  const DEAD_SESSION = '22222222-2222-4222-8222-222222222222';

  /** Only LIVE_SESSION resolves; nothing is live on the process table. */
  const deps = {
    listEntries: () => [
      { pid: 111, agent: 'claude', sessionId: LIVE_SESSION, launchId: 'launch-live', startedAtMs: 1 },
      { pid: 222, agent: 'claude', sessionId: DEAD_SESSION, launchId: 'launch-dead', startedAtMs: 1 },
    ],
    pidAlive: (pid: number) => pid === 111,
    sessionIdOfPid: () => undefined,
    sessionLiveOnProcessTable: async () => false,
  };

  async function startTask(
    service: any,
    profile: string,
    identity: { sessionId?: string; launchId?: string }
  ) {
    return service.start(profile, { url: `https://example.com/${Math.random()}`, ...identity });
  }

  it('stops a task whose agent session is gone and leaves a live one alone', async () => {
    writeProfile('reap1', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap1@endpoint-0');
    attach(service, 'reap1', conn);

    const dead = await startTask(service, 'reap1', { sessionId: DEAD_SESSION, launchId: 'launch-dead' });
    const live = await startTask(service, 'reap1', { sessionId: LIVE_SESSION, launchId: 'launch-live' });
    expect(targets).toHaveLength(2);

    const result = await service.reapAbandoned({ deps });

    expect(result.closed).toEqual([
      { task: dead.name, profile: 'reap1@endpoint-0', reason: 'session-dead' },
    ]);
    expect(result.skipped).toBe(1);
    expect(conn.tasks.has(dead.name)).toBe(false);
    expect(conn.tasks.has(live.name)).toBe(true);
    // The dead task's tab is gone; the live task's is untouched.
    expect(targets).toHaveLength(1);
    expect(Object.values(conn.tasks.get(live.name)!.tabs)).toEqual([targets[0].targetId]);
  });

  it('never session-reaps a task that carries no identity at all', async () => {
    writeProfile('reap2', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap2@endpoint-0');
    attach(service, 'reap2', conn);

    // A human running `agents browser start` by hand: no session, no launch.
    await startTask(service, 'reap2', {});

    const result = await service.reapAbandoned({ deps });

    expect(result.closed).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(targets).toHaveLength(1);
  });

  it('never session-reaps a launchId-only task — the registry is its only witness', async () => {
    writeProfile('reap2b', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap2b@endpoint-0');
    attach(service, 'reap2b', conn);

    // Every `agents run` mints a launchId, but AGENT_SESSION_ID is Claude-only
    // and skipped on resume — so this is a live codex/droid/grok run whose
    // launch pid has already exited and been pruned from the registry. Only a
    // sessionId has a second witness (the process table); treating a missing
    // registry entry as proof of death here would close a working agent's tabs.
    const t = await startTask(service, 'reap2b', { launchId: 'launch-dead' });

    const result = await service.reapAbandoned({ deps });

    expect(result.closed).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(conn.tasks.has(t.name)).toBe(true);
    expect(targets).toHaveLength(1);
  });

  it('rejects a non-positive or non-numeric idle window instead of reaping everything', async () => {
    writeProfile('reap9', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap9@endpoint-0');
    attach(service, 'reap9', conn);
    const fresh = await startTask(service, 'reap9', {});

    // `0` survives `??` and would close a task created a millisecond ago; NaN
    // makes every comparison false and silently disables idle reaping.
    await expect(service.reapAbandoned({ deps, idleMs: 0 })).rejects.toThrow(/positive number/);
    await expect(service.reapAbandoned({ deps, idleMs: NaN })).rejects.toThrow(/positive number/);

    expect(conn.tasks.has(fresh.name)).toBe(true);
    expect(targets).toHaveLength(1);
  });

  it('keeps a task whose launchId is still live even when its sessionId is not', async () => {
    writeProfile('reap3', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn } = makeTargetedConn('reap3@endpoint-0');
    attach(service, 'reap3', conn);

    // Half-resolved identity is not proof of death.
    const t = await startTask(service, 'reap3', { sessionId: DEAD_SESSION, launchId: 'launch-live' });

    const result = await service.reapAbandoned({ deps });

    expect(result.closed).toEqual([]);
    expect(conn.tasks.has(t.name)).toBe(true);
  });

  it('keeps a session the registry missed but the process table can still see', async () => {
    writeProfile('reap4', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn } = makeTargetedConn('reap4@endpoint-0');
    attach(service, 'reap4', conn);

    const t = await startTask(service, 'reap4', { sessionId: DEAD_SESSION });

    // RUSH-2384: the by-pid registry is often empty mid-run, so a live process
    // carrying --session-id is the authoritative second opinion.
    const result = await service.reapAbandoned({
      deps: { ...deps, listEntries: () => [], sessionLiveOnProcessTable: async () => true },
    });

    expect(result.closed).toEqual([]);
    expect(conn.tasks.has(t.name)).toBe(true);
  });

  it('reaps a task idle past the window and keeps one inside it', async () => {
    writeProfile('reap5', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap5@endpoint-0');
    attach(service, 'reap5', conn);

    const stale = await startTask(service, 'reap5', {});
    const recent = await startTask(service, 'reap5', {});
    const now = Date.now();
    conn.tasks.get(stale.name)!.lastActionAt = now - 31 * 60_000;
    conn.tasks.get(recent.name)!.lastActionAt = now - 5 * 60_000;

    const result = await service.reapAbandoned({ deps, now });

    expect(result.closed).toEqual([
      { task: stale.name, profile: 'reap5@endpoint-0', reason: 'idle' },
    ]);
    expect(result.skipped).toBe(1);
    expect(conn.tasks.has(recent.name)).toBe(true);
    expect(targets).toHaveLength(1);
  });

  it('closes only the reaped task\'s own tabs — never a stray tab or the browser', async () => {
    writeProfile('reap6', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets, calls } = makeTargetedConn('reap6@endpoint-0', {
      pages: [{ targetId: 'stray', url: 'https://someone-else.example/' }],
    });
    attach(service, 'reap6', conn);

    const stale = await startTask(service, 'reap6', {});
    const now = Date.now();
    conn.tasks.get(stale.name)!.lastActionAt = now - 31 * 60_000;

    await service.reapAbandoned({ deps, now });

    expect(targets.map((t) => t.targetId)).toEqual(['stray']);
    expect(calls.filter((c) => c.method === 'Target.closeTarget')).toHaveLength(1);
    // The shared profile window / browser process is not ours to kill.
    expect(conn.cdp.close).not.toHaveBeenCalled();
    expect((service as unknown as { connections: Map<string, unknown> }).connections.size).toBe(1);
  });

  it('dryRun reports what it would close without closing it', async () => {
    writeProfile('reap7', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap7@endpoint-0');
    attach(service, 'reap7', conn);

    const stale = await startTask(service, 'reap7', {});
    const now = Date.now();
    conn.tasks.get(stale.name)!.lastActionAt = now - 31 * 60_000;

    const result = await service.reapAbandoned({ deps, now, dryRun: true });

    expect(result.closed).toEqual([
      { task: stale.name, profile: 'reap7@endpoint-0', reason: 'idle' },
    ]);
    expect(conn.tasks.has(stale.name)).toBe(true);
    expect(targets).toHaveLength(1);
  });

  it('leaves a recording task alone even when it is past the idle window', async () => {
    writeProfile('reap8', ['cdp://localhost:9222']);
    const service = new BrowserService();
    const { conn, targets } = makeTargetedConn('reap8@endpoint-0');
    attach(service, 'reap8', conn);

    const stale = await startTask(service, 'reap8', {});
    const now = Date.now();
    conn.tasks.get(stale.name)!.lastActionAt = now - 31 * 60_000;
    // Reaping mid-capture would truncate a recording the user asked for.
    (service as unknown as { recordings: Map<string, unknown> }).recordings.set(stale.name, {
      outputPath: '/tmp/x.mp4',
      startedAt: now,
    });

    const result = await service.reapAbandoned({ deps, now });

    expect(result.closed).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(targets).toHaveLength(1);
  });
});
