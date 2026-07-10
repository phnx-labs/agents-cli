import { describe, expect, it } from 'vitest';
import { buildRestartTaskScript, detectImageFormat, reconcileScreenshotExt, shouldBlockOffPlatform } from './computer.js';

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
