import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildRestartTaskScript,
  detectImageFormat,
  reconcileScreenshotExt,
  shouldBlockOffPlatform,
  emitComputerRunTaskMarker,
} from './computer.js';
import { query, _resetForTest } from '../lib/feed/events.js';
import { TASK_PREVIEW_MAX_CHARS } from '../lib/computer/sessions-list.js';

// Real leading magic bytes, matching what each helper actually encodes.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // Windows helper (ImageFormat.Png)
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // macOS helper (.jpeg representation)

describe('detectImageFormat', () => {
  it('recognizes PNG from its 8-byte signature', () => {
    expect(detectImageFormat(PNG)).toBe('.png');
  });
  it('recognizes JPEG from FF D8 FF', () => {
    expect(detectImageFormat(JPEG)).toBe('.jpg');
  });
  it('returns null for unknown/empty bytes', () => {
    expect(detectImageFormat(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    expect(detectImageFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe('reconcileScreenshotExt', () => {
  it('corrects the .jpg default when the Windows helper returns PNG (issue #521)', () => {
    // The exact bug: default out is ./computer-screenshot.jpg, bytes are PNG.
    expect(reconcileScreenshotExt('/tmp/computer-screenshot.jpg', PNG)).toEqual({
      path: '/tmp/computer-screenshot.png',
      corrected: true,
    });
  });
  it('leaves a matching .jpg alone for JPEG bytes (macOS default path)', () => {
    expect(reconcileScreenshotExt('/tmp/shot.jpg', JPEG)).toEqual({ path: '/tmp/shot.jpg', corrected: false });
  });
  it('treats .jpeg as already-matching for JPEG bytes', () => {
    expect(reconcileScreenshotExt('/tmp/shot.jpeg', JPEG)).toEqual({ path: '/tmp/shot.jpeg', corrected: false });
  });
  it('appends the real extension when the path has none', () => {
    expect(reconcileScreenshotExt('/tmp/shot-test', PNG)).toEqual({ path: '/tmp/shot-test.png', corrected: true });
  });
  it('swaps a wrong .png to .jpg for JPEG bytes', () => {
    expect(reconcileScreenshotExt('/tmp/shot.png', JPEG)).toEqual({ path: '/tmp/shot.jpg', corrected: true });
  });
  it('passes unknown bytes through untouched', () => {
    const junk = Buffer.from([0x00, 0x01]);
    expect(reconcileScreenshotExt('/tmp/shot.jpg', junk)).toEqual({ path: '/tmp/shot.jpg', corrected: false });
  });
});

// The `computer` preAction hook calls process.exit(1) exactly when
// shouldBlockOffPlatform() is true. These cases pin the rule that off-macOS
// invocations are NOT blocked once a remote daemon is reachable.
describe('shouldBlockOffPlatform', () => {
  it('never blocks on macOS (local Accessibility path)', () => {
    expect(shouldBlockOffPlatform({ platform: 'darwin', tcpConfigured: false })).toBe(false);
    expect(shouldBlockOffPlatform({ platform: 'darwin', tcpConfigured: true, host: 'win-mini' })).toBe(false);
  });

  it('blocks off macOS with no remote path configured', () => {
    expect(shouldBlockOffPlatform({ platform: 'linux', tcpConfigured: false })).toBe(true);
    expect(shouldBlockOffPlatform({ platform: 'win32', tcpConfigured: false })).toBe(true);
  });

  it('does NOT block off macOS when COMPUTER_HELPER_TCP is configured', () => {
    // This is the regression the transport fix targets: a Linux host with a
    // tunnel to a Windows daemon must be allowed to drive it.
    expect(shouldBlockOffPlatform({ platform: 'linux', tcpConfigured: true })).toBe(false);
  });

  it('does NOT block off macOS when a --host remote device is given', () => {
    // The remote path resolves its own endpoint before the client opens.
    expect(shouldBlockOffPlatform({ platform: 'linux', tcpConfigured: false, host: 'win-mini' })).toBe(false);
  });
});

describe('buildRestartTaskScript', () => {
  const script = buildRestartTaskScript('AgentsComputerHelper', 'computer-helper-win.exe');

  it('kills by PROCESS name (no .exe suffix — Stop-Process -Name takes the bare name)', () => {
    expect(script).toContain(`Stop-Process -Name 'computer-helper-win' -Force`);
    expect(script).not.toContain(`'computer-helper-win.exe'`);
  });

  it('tolerates the daemon not running, but fails loud on anything else', () => {
    expect(script).toContain('-ErrorAction SilentlyContinue');
    expect(script).toContain(`$ErrorActionPreference = 'Stop'`);
  });

  it('starts the LOGON scheduled task that owns the daemon lifecycle', () => {
    expect(script).toContain(`Start-ScheduledTask -TaskName 'AgentsComputerHelper'`);
  });
});

describe('emitComputerRunTaskMarker — computer.action run marker (RUSH-2432)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    _resetForTest();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function eventsPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-computer-run-marker-'));
    tempDirs.push(dir);
    return path.join(dir, 'events.jsonl');
  }

  it('records the run verb, bundle, and host against the real event log', () => {
    _resetForTest(eventsPath());
    emitComputerRunTaskMarker({ task: 'open Notes and write a haiku', bundle: 'com.apple.notes', host: 'win-mini' });

    const recs = query({ eventTypes: ['computer.action'] });
    expect(recs).toHaveLength(1);
    expect(recs[0].command).toBe('run');
    expect(recs[0].bundle).toBe('com.apple.notes');
    expect(recs[0].host).toBe('win-mini');
    expect(recs[0].task).toBe('open Notes and write a haiku');
    expect(recs[0].invocationId).toEqual(expect.any(String));
    expect((recs[0].invocationId as string).length).toBeGreaterThan(0);
  });

  it('bounds the task text to TASK_PREVIEW_MAX_CHARS — never the raw unbounded --task string', () => {
    _resetForTest(eventsPath());
    const longTask = 'describe every window in exhaustive detail '.repeat(20);
    expect(longTask.length).toBeGreaterThan(TASK_PREVIEW_MAX_CHARS);
    emitComputerRunTaskMarker({ task: longTask });

    const rec = query({ eventTypes: ['computer.action'] })[0];
    expect((rec.task as string).length).toBeLessThanOrEqual(TASK_PREVIEW_MAX_CHARS);
    expect(JSON.stringify(rec)).not.toContain(longTask);
  });

  it('carries no target pid — the marker fires before any window is resolved', () => {
    _resetForTest(eventsPath());
    emitComputerRunTaskMarker({ task: 'x' });
    expect(query({ eventTypes: ['computer.action'] })[0].targetPid).toBeUndefined();
  });
});
