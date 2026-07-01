/**
 * Tests for the passphrase policy of the shared encrypted-file store.
 *
 * The crypto round-trip and basic file-store ops are covered by
 * __tests__/linux.test.ts (which exercises the same module via the Linux
 * backend re-exports). This file pins the NEW `allowAutoProvision` seam that
 * the macOS file-backed bundle path relies on: with auto-provision OFF, a
 * missing passphrase is a hard error and NO machine-local key is written to
 * disk — so a remote/headless Mac can only decrypt with a passphrase handed in
 * per run, never one sitting next to the ciphertext.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock only spawnSync (the win32 TTY prompt path); keep execSync real so the
// POSIX TTY branch and crypto still work. Same pattern as windows.test.ts:9-13.
const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawnSync: spawnSyncMock };
});

import { fileStore, getPassphrase, _resetFileStoreForTest } from './filestore.js';

describe('filestore passphrase policy (allowAutoProvision)', () => {
  let tmpDir: string;
  let prevTty: boolean | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-filestore-'));
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    // Force the headless branch deterministically regardless of how the runner
    // was launched (a real TTY would otherwise hit the interactive prompt).
    prevTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    _resetFileStoreForTest({ fileDir: tmpDir });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevTty, configurable: true });
    _resetFileStoreForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('with allowAutoProvision:false and no passphrase, getPassphrase throws (no .passphrase written)', () => {
    expect(() => getPassphrase({ allowAutoProvision: false })).toThrow(/AGENTS_SECRETS_PASSPHRASE/);
    expect(fs.existsSync(path.join(tmpDir, '.passphrase'))).toBe(false);
  });

  it('with allowAutoProvision:false, fileStore.set refuses and writes nothing to disk', () => {
    expect(() => fileStore.set('agents-cli.secrets.b.K', 'v', { allowAutoProvision: false }))
      .toThrow(/AGENTS_SECRETS_PASSPHRASE/);
    // No ciphertext, no provisioned key — the box holds nothing decryptable.
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('with an explicit AGENTS_SECRETS_PASSPHRASE, set/get round-trips with auto-provision OFF', () => {
    process.env.AGENTS_SECRETS_PASSPHRASE = 'per-run-key';
    _resetFileStoreForTest({ fileDir: tmpDir });
    const opts = { allowAutoProvision: false } as const;
    fileStore.set('agents-cli.secrets.b.K', 'sealed', opts);
    expect(fileStore.get('agents-cli.secrets.b.K', opts)).toBe('sealed');
    // Encrypted on disk; the machine key was never provisioned.
    expect(fs.existsSync(path.join(tmpDir, '.passphrase'))).toBe(false);
    const enc = fs.readFileSync(path.join(tmpDir, 'agents-cli.secrets.b.K.enc'), 'utf8');
    expect(enc).not.toContain('sealed');
  });

  it('with the wrong passphrase, get fails the auth tag with a clear message (auto-provision OFF)', () => {
    process.env.AGENTS_SECRETS_PASSPHRASE = 'right';
    _resetFileStoreForTest({ fileDir: tmpDir });
    fileStore.set('agents-cli.secrets.b.K', 'sealed', { allowAutoProvision: false });
    process.env.AGENTS_SECRETS_PASSPHRASE = 'wrong';
    _resetFileStoreForTest({ fileDir: tmpDir });
    expect(() => fileStore.get('agents-cli.secrets.b.K', { allowAutoProvision: false }))
      .toThrow(/decrypt|passphrase/i);
  });
});

// Windows has no /dev/tty; the interactive prompt must route through PowerShell
// Read-Host instead of crashing with a raw ENOENT on fs.openSync('/dev/tty').
describe('filestore win32 interactive passphrase branch', () => {
  let tmpDir: string;
  let prevTty: boolean | undefined;
  let prevPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-filestore-win-'));
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    // Interactive (isTTY) + win32 so getPassphrase reaches the TTY prompt.
    prevTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    prevPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    spawnSyncMock.mockReset();
    _resetFileStoreForTest({ fileDir: tmpDir });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevTty, configurable: true });
    if (prevPlatform) Object.defineProperty(process, 'platform', prevPlatform);
    spawnSyncMock.mockReset();
    _resetFileStoreForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads the passphrase via PowerShell Read-Host, not /dev/tty', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe('powershell.exe');
      expect(args).toContain('-EncodedCommand');
      // -NonInteractive would suppress Read-Host, so it must be absent.
      expect(args).not.toContain('-NonInteractive');
      return { status: 0, stdout: Buffer.from('typed-pass\r\n'), stderr: Buffer.from('') };
    });
    // Round-trips a value using the prompted passphrase (proves it flows through).
    fileStore.set('agents-cli.secrets.b.K', 'sealed');
    _resetFileStoreForTest({ fileDir: tmpDir });
    spawnSyncMock.mockImplementation(() => ({
      status: 0, stdout: Buffer.from('typed-pass\n'), stderr: Buffer.from(''),
    }));
    expect(fileStore.get('agents-cli.secrets.b.K')).toBe('sealed');
  });

  it('throws an actionable error (not ENOENT) when PowerShell cannot run', () => {
    spawnSyncMock.mockImplementation(() => ({
      status: 1, stdout: Buffer.from(''), stderr: Buffer.from(''), error: new Error('spawn ENOENT'),
    }));
    expect(() => getPassphrase()).toThrow(/AGENTS_SECRETS_PASSPHRASE/);
  });
});
