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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
