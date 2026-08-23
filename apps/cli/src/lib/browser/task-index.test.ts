import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-browser-task-index-'));

vi.mock('../state.js', () => ({
  getBrowserRuntimeDir: vi.fn(() => path.join(TEST_ROOT, 'browser-runtime')),
}));

vi.mock('../machine-id.js', () => ({
  machineId: vi.fn(() => 'testbox'),
}));

const {
  bindTask,
  getTaskBinding,
  listTaskBindings,
  unbindTask,
  updateTaskBinding,
  tasksForCaller,
  formatOpenTaskList,
  unknownTaskMessage,
  ambiguousTasksMessage,
  resolveTaskRoute,
  honorScreenshotOutput,
  REJECT_DEVICE_MESSAGE,
  readTaskIndex,
} = await import('./task-index.js');

beforeEach(() => {
  fs.rmSync(path.join(TEST_ROOT, 'browser-runtime'), { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(path.join(TEST_ROOT, 'browser-runtime'), { recursive: true, force: true });
});

describe('task index store', () => {
  it('binds, reads, updates, and unbinds a task on this machine', () => {
    bindTask('post', {
      device: 'zion',
      profile: 'agents',
      url: 'https://x.com/home',
      sessionId: 'sess-1',
      createdAt: 1_700_000_000_000,
    });

    expect(getTaskBinding('post')).toEqual({
      device: 'zion',
      profile: 'agents',
      url: 'https://x.com/home',
      sessionId: 'sess-1',
      createdAt: 1_700_000_000_000,
    });
    expect(listTaskBindings().map((e) => e.name)).toEqual(['post']);

    updateTaskBinding('post', { url: 'https://x.com/compose' });
    expect(getTaskBinding('post')?.url).toBe('https://x.com/compose');

    unbindTask('post');
    expect(getTaskBinding('post')).toBeUndefined();
    expect(listTaskBindings()).toEqual([]);
  });

  it('fails loud on an empty task name or missing device', () => {
    expect(() => bindTask('', { device: 'zion', createdAt: 1 })).toThrow(/empty name/);
    expect(() => bindTask('post', { device: '', createdAt: 1 })).toThrow(/without a device/);
  });

  it('fails loud when the index file is not a map', () => {
    const dir = path.join(TEST_ROOT, 'browser-runtime');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'task-index.json'), '[]\n');
    expect(() => readTaskIndex()).toThrow(/document root must be a map/);
  });
});

describe('open-task listing (RUSH-3087)', () => {
  it('shows the real URL and the device, never url=- when a URL was recorded', () => {
    const entries = [
      {
        name: 'post',
        device: 'zion',
        url: 'https://x.com/compose',
        createdAt: 1_000,
      },
      {
        name: 'mail',
        device: 'mac-mini',
        url: 'https://github.com/notifications',
        createdAt: 61_000,
      },
    ];
    const listing = formatOpenTaskList(entries, 62_000);
    expect(listing).toContain('post  url=https://x.com/compose  device=zion');
    expect(listing).toContain('mail  url=https://github.com/notifications  device=mac-mini');
    expect(listing).not.toMatch(/url=-/);
  });

  it('renders url=- only when the binding has no URL, and lists none when empty', () => {
    expect(formatOpenTaskList([])).toBe('  (no open tasks)');
    expect(
      formatOpenTaskList([{ name: 'bare', device: 'zion', createdAt: 1 }], 1),
    ).toMatch(/bare  url=-  device=zion/);
  });

  it('unknown-task message lists every open task', () => {
    bindTask('post', { device: 'zion', url: 'https://x.com/', createdAt: Date.now() });
    const message = unknownTaskMessage('missing');
    expect(message).toMatch(/Unknown browser task "missing"/);
    expect(message).toMatch(/url=https:\/\/x\.com\//);
    expect(message).toMatch(/device=zion/);
    expect(message).toMatch(/agents browser start/);
  });

  it('ambiguous-task message includes url and device so the caller can pick one', () => {
    const entries = [
      { name: 'a', device: 'zion', url: 'https://github.com', createdAt: Date.now() },
      { name: 'b', device: 'zion', url: 'https://x.com', createdAt: Date.now() },
    ];
    const message = ambiguousTasksMessage(entries);
    expect(message).toMatch(/pass --task/);
    expect(message).toMatch(/url=https:\/\/github.com/);
    expect(message).toMatch(/url=https:\/\/x.com/);
    expect(message).toMatch(/device=zion/);
  });
});

describe('resolveTaskRoute', () => {
  it('rejects --device on a page verb and points at start', () => {
    const route = resolveTaskRoute({ task: 'post', device: 'zion', self: 'testbox' });
    expect(route).toEqual({ kind: 'reject-device', message: REJECT_DEVICE_MESSAGE });
    expect(route.kind === 'reject-device' && route.message).toMatch(/agents browser start/);
  });

  it('fails loud on an unknown task and lists the open tasks', () => {
    bindTask('post', { device: 'zion', url: 'https://x.com/', createdAt: Date.now() });
    const route = resolveTaskRoute({ task: 'nope', self: 'testbox' });
    expect(route.kind).toBe('unknown');
    if (route.kind !== 'unknown') return;
    expect(route.task).toBe('nope');
    expect(route.message).toMatch(/Unknown browser task "nope"/);
    expect(route.message).toMatch(/post  url=https:\/\/x.com\//);
    expect(route.message).toMatch(/device=zion/);
  });

  it('fails after the task is unbound rather than opening a second browser', () => {
    bindTask('post', { device: 'testbox', url: 'https://example.com', createdAt: Date.now() });
    unbindTask('post');
    const route = resolveTaskRoute({ task: 'post', self: 'testbox' });
    expect(route.kind).toBe('unknown');
    if (route.kind !== 'unknown') return;
    expect(route.message).toMatch(/\(no open tasks\)/);
  });

  it('routes a named task to the device recorded at start', () => {
    bindTask('post', { device: 'zion', url: 'https://x.com/', createdAt: Date.now() });
    expect(resolveTaskRoute({ task: 'post', self: 'testbox' })).toEqual({
      kind: 'proceed',
      task: 'post',
      device: 'zion',
    });
  });

  it('uses the only task for this session when --task is omitted', () => {
    bindTask('post', {
      device: 'zion',
      sessionId: 'sess-1',
      createdAt: Date.now(),
    });
    bindTask('other', {
      device: 'mac-mini',
      sessionId: 'sess-2',
      createdAt: Date.now(),
    });
    expect(resolveTaskRoute({ sessionId: 'sess-1', self: 'testbox' })).toEqual({
      kind: 'proceed',
      task: 'post',
      device: 'zion',
    });
  });

  it('errors with url and device when this session owns 2+ tasks (RUSH-3087)', () => {
    bindTask('post', {
      device: 'zion',
      url: 'https://x.com/compose',
      sessionId: 'sess-1',
      createdAt: Date.now(),
    });
    bindTask('mail', {
      device: 'zion',
      url: 'https://github.com/notifications',
      sessionId: 'sess-1',
      createdAt: Date.now(),
    });
    const route = resolveTaskRoute({ sessionId: 'sess-1', self: 'testbox' });
    expect(route.kind).toBe('ambiguous');
    if (route.kind !== 'ambiguous') return;
    expect(route.message).toMatch(/url=https:\/\/x.com\/compose/);
    expect(route.message).toMatch(/url=https:\/\/github.com\/notifications/);
    expect(route.message).toMatch(/device=zion/);
    expect(route.message).not.toMatch(/url=-/);
  });

  it('proceeds locally with no task when the index has nothing for this caller', () => {
    expect(resolveTaskRoute({ sessionId: 'none', self: 'testbox' })).toEqual({
      kind: 'proceed',
      device: 'testbox',
    });
  });

  it('filters caller tasks by launchId as well as sessionId', () => {
    bindTask('post', {
      device: 'zion',
      launchId: 'launch-9',
      createdAt: Date.now(),
    });
    expect(tasksForCaller(undefined, 'launch-9').map((e) => e.name)).toEqual(['post']);
    expect(resolveTaskRoute({ launchId: 'launch-9', self: 'testbox' })).toEqual({
      kind: 'proceed',
      task: 'post',
      device: 'zion',
    });
  });
});

describe('honorScreenshotOutput (RUSH-3086)', () => {
  it('returns the daemon path when -o is omitted', () => {
    const daemonPath = path.join(TEST_ROOT, 'daemon', 'shot.jpg');
    expect(honorScreenshotOutput(undefined, daemonPath)).toBe(daemonPath);
  });

  it('copies the daemon file to exactly the -o path', () => {
    const daemonDir = path.join(TEST_ROOT, 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    const daemonPath = path.join(daemonDir, 'shot.jpg');
    fs.writeFileSync(daemonPath, 'jpeg-bytes');
    const dest = path.join(TEST_ROOT, 'exports', 'page.png');

    const written = honorScreenshotOutput(dest, daemonPath);

    expect(written).toBe(path.resolve(dest));
    expect(fs.readFileSync(written, 'utf8')).toBe('jpeg-bytes');
    expect(fs.readFileSync(daemonPath, 'utf8')).toBe('jpeg-bytes');
  });

  it('does not copy when -o already names the daemon path', () => {
    const daemonDir = path.join(TEST_ROOT, 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    const daemonPath = path.join(daemonDir, 'shot.jpg');
    fs.writeFileSync(daemonPath, 'jpeg-bytes');
    expect(honorScreenshotOutput(daemonPath, daemonPath)).toBe(path.resolve(daemonPath));
  });
});
