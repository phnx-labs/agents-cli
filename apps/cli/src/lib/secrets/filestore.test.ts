/**
 * Tests for the passphrase policy of the shared encrypted-file store.
 *
 * The crypto round-trip and basic file-store ops are covered by
 * __tests__/linux.test.ts (which exercises the same module via the Linux
 * backend re-exports). This file pins the policy: the file store silently
 * auto-provisions a machine-local key on EVERY platform (no passphrase to set,
 * type, or remember, no prompt, no Touch ID), and an explicit
 * AGENTS_SECRETS_PASSPHRASE takes precedence and provisions no on-disk key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { fileStore, getPassphrase, _resetFileStoreForTest } from './filestore.js';

describe('filestore passphrase policy (silent auto-provision)', () => {
  let tmpRoot: string;
  let storeDir: string;
  let keyDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-filestore-'));
    storeDir = path.join(tmpRoot, 'store');
    keyDir = path.join(tmpRoot, 'key');
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    _resetFileStoreForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('with no passphrase, getPassphrase silently auto-provisions instead of throwing', () => {
    // The whole point of this change: the file store must work with no
    // AGENTS_SECRETS_PASSPHRASE and no prompt, on every platform.
    expect(() => getPassphrase()).not.toThrow();
    expect(fs.existsSync(path.join(keyDir, 'passphrase'))).toBe(true);
  });

  it('an explicit AGENTS_SECRETS_PASSPHRASE takes precedence and provisions no machine key', () => {
    process.env.AGENTS_SECRETS_PASSPHRASE = 'per-run-key';
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    fileStore.set('agents-cli.secrets.b.K', 'sealed');
    expect(fileStore.get('agents-cli.secrets.b.K')).toBe('sealed');
    // Encrypted on disk; the machine key was never provisioned.
    expect(fs.existsSync(path.join(keyDir, 'passphrase'))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, '.passphrase'))).toBe(false);
    const enc = fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.b.K.enc'), 'utf8');
    expect(enc).not.toContain('sealed');
  });

  it('with the wrong passphrase, get fails the auth tag with a clear message', () => {
    process.env.AGENTS_SECRETS_PASSPHRASE = 'right';
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    fileStore.set('agents-cli.secrets.b.K', 'sealed');
    process.env.AGENTS_SECRETS_PASSPHRASE = 'wrong';
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    expect(() => fileStore.get('agents-cli.secrets.b.K'))
      .toThrow(/decrypt|passphrase/i);
  });

  it('auto-provisions the passphrase outside the encrypted store dir (#479)', () => {
    fileStore.set('agents-cli.secrets.b.K', 'sealed');
    const storeEntries = fs.readdirSync(storeDir);
    expect(storeEntries).toContain('agents-cli.secrets.b.K.enc');
    expect(storeEntries).not.toContain('.passphrase');
    expect(storeEntries).not.toContain('passphrase');
    expect(fs.existsSync(path.join(keyDir, 'passphrase'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(keyDir, 'passphrase')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(keyDir).mode & 0o777).toBe(0o700);
    }
  });
});
