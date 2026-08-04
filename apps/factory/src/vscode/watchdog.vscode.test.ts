import { describe, test, expect, beforeEach, mock } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { EditorTerminal } from './terminals.vscode';

// Minimal vscode mock — the tick reads config, window focus state, and shows
// status-bar messages; the toggle command writes config.
const configStore = new Map<string, unknown>([
  ['enabled', true],
  ['autoRotate', true],
  ['rotateCooldownSeconds', 120],
  ['tickSeconds', 120],
]);
const statusMessages: string[] = [];

mock.module('vscode', () => ({
  window: {
    state: { focused: true },
    setStatusBarMessage: (msg: string) => {
      statusMessages.push(msg);
      return { dispose: () => {} };
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, def: unknown) =>
        configStore.has(key) ? configStore.get(key) : def,
      update: (key: string, value: unknown) => {
        configStore.set(key, value);
        return Promise.resolve();
      },
    }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
}));

const watchdog = await import('./watchdog.vscode');
const { parseEvents } = await import('../core/watchdogLog');

// The contract error text the CLI's `agents run auto` fails with (RUSH-2132).
const CONTRACT_ERROR =
  "agents: no healthy claude account under strategy 'balanced' — excluded: a@x.com (weekly); " +
  'earliest window resets 7am (America/Los_Angeles). Use --strategy pinned to force the default.';

function fakeEntry(over: Partial<EditorTerminal> = {}): EditorTerminal {
  return {
    id: 'T1',
    sessionId: 'sess-1',
    agentType: 'claude',
    ...over,
  } as unknown as EditorTerminal;
}

let logPath: string;

beforeEach(() => {
  watchdog.__clearNoHealthyStateForTests();
  statusMessages.length = 0;
  logPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-test-')),
    'watchdog.log',
  );
  watchdog.__setWatchdogLogPathForTests(logPath);
});

describe('watchdog tick — no healthy suppression', () => {
  test('tail with the CLI contract error → no rotate, ONE skip event per window', async () => {
    let rotations = 0;
    const deps = {
      listTerminals: () => [fakeEntry()],
      readTail: () => Promise.resolve(CONTRACT_ERROR),
      rotateTerminal: () => {
        rotations++;
        return Promise.resolve({ status: 'rotated', newSessionId: 'new-1' } as const);
      },
    };
    const lastRotateMs = new Map<string, number>();

    await watchdog.tick(lastRotateMs, deps);
    expect(rotations).toBe(0);

    // Real log writer, temp path: exactly one rotate skip event.
    const events = parseEvents(fs.readFileSync(logPath, 'utf8'));
    const skips = events.filter((e) => e.kind === 'rotate');
    expect(skips.length).toBe(1);
    expect(skips[0].message).toContain('skip');
    expect(skips[0].reason).toContain('no healthy account');

    // Subsequent ticks in the same suppression window: still no rotate, and
    // NO further skip events (one per window, not per tick).
    await watchdog.tick(lastRotateMs, deps);
    await watchdog.tick(lastRotateMs, deps);
    expect(rotations).toBe(0);
    const events2 = parseEvents(fs.readFileSync(logPath, 'utf8'));
    expect(events2.filter((e) => e.kind === 'rotate').length).toBe(1);
  });

  test('suppression recorded by the rotate path also blocks the tick', async () => {
    let rotations = 0;
    watchdog.recordNoHealthyRotateFailure(undefined, Date.now() + 60_000);
    const deps = {
      listTerminals: () => [fakeEntry()],
      readTail: () => Promise.resolve("You've hit your weekly limit"),
      rotateTerminal: () => {
        rotations++;
        return Promise.resolve({ status: 'rotated', newSessionId: 'new-1' } as const);
      },
    };
    await watchdog.tick(new Map(), deps);
    expect(rotations).toBe(0);
  });

  test('rate-limited tail → rotates and logs the rotate event', async () => {
    let rotations = 0;
    const deps = {
      listTerminals: () => [fakeEntry()],
      readTail: () => Promise.resolve('{"text":"You\'ve hit your weekly limit. Resets 7am"}'),
      rotateTerminal: () => {
        rotations++;
        return Promise.resolve({ status: 'rotated', newSessionId: 'new-session-9' } as const);
      },
    };
    await watchdog.tick(new Map(), deps);
    expect(rotations).toBe(1);
    const events = parseEvents(fs.readFileSync(logPath, 'utf8'));
    const rotates = events.filter((e) => e.kind === 'rotate');
    expect(rotates.length).toBe(1);
    expect(rotates[0].message).toContain('agents run auto');
  });

  test('clean tail → no rotate, no log', async () => {
    let rotations = 0;
    const deps = {
      listTerminals: () => [fakeEntry()],
      readTail: () => Promise.resolve('{"type":"assistant","text":"working on it"}'),
      rotateTerminal: () => {
        rotations++;
        return Promise.resolve({ status: 'rotated', newSessionId: 'new-1' } as const);
      },
    };
    await watchdog.tick(new Map(), deps);
    expect(rotations).toBe(0);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  test('rotate cooldown suppresses a second rotation for the same terminal', async () => {
    let rotations = 0;
    const deps = {
      listTerminals: () => [fakeEntry()],
      readTail: () => Promise.resolve("You've hit your weekly limit"),
      rotateTerminal: () => {
        rotations++;
        return Promise.resolve({ status: 'rotated', newSessionId: 'new-1' } as const);
      },
    };
    const lastRotateMs = new Map<string, number>();
    await watchdog.tick(lastRotateMs, deps);
    await watchdog.tick(lastRotateMs, deps);
    expect(rotations).toBe(1);
  });
});

describe('Agents: Toggle Watchdog Auto-Rotate', () => {
  test('command registration flips agents.watchdog.autoRotate and confirms', async () => {
    configStore.set('autoRotate', true);
    const registered = new Map<string, () => Promise<void>>();
    const disposable = watchdog.registerToggleAutoRotateCommand(
      ((id: string, handler: () => Promise<void>) => {
        registered.set(id, handler);
        return { dispose: () => {} };
      }) as never,
    );
    expect(disposable).toBeDefined();
    const handler = registered.get('agents.toggleWatchdogAutoRotate');
    expect(handler).toBeDefined();

    await handler!();
    expect(configStore.get('autoRotate')).toBe(false);
    expect(statusMessages.at(-1)).toContain('OFF');

    await handler!();
    expect(configStore.get('autoRotate')).toBe(true);
    expect(statusMessages.at(-1)).toContain('ON');
  });
});
