/**
 * Tests for the Linux secret backend, focused on the encrypted-file fallback
 * that activates when the default Secret Service collection is locked.
 *
 * These tests do NOT touch libsecret / secret-tool at all — they exercise
 * the file backend directly. The preflight/secret-tool fallback wiring is
 * covered by a forced-file-fallback end-to-end test below; the live-libsecret
 * path is platform-gated and verified by the e2e smoke run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  encryptForFallback,
  decryptForFallback,
  fileBackend,
  linuxBackend,
  _resetForTest,
} from '../linux.js';

describe('encryptForFallback / decryptForFallback', () => {
  it('roundtrips plaintext with the correct passphrase', () => {
    const plaintext = 'sk-live-abc123-xyz';
    const enc = encryptForFallback(plaintext, 'correct horse battery staple');
    expect(enc.salt).toMatch(/^[0-9a-f]{32}$/);     // 16-byte hex salt
    expect(enc.iv).toMatch(/^[0-9a-f]{24}$/);       // 12-byte hex IV
    expect(enc.authTag).toMatch(/^[0-9a-f]{32}$/);  // 16-byte hex GCM tag
    expect(enc.ciphertext).not.toContain(plaintext);
    const out = decryptForFallback(enc, 'correct horse battery staple');
    expect(out).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext (random salt + IV)', () => {
    const a = encryptForFallback('hello', 'pw');
    const b = encryptForFallback('hello', 'pw');
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('throws when decrypting with the wrong passphrase', () => {
    const enc = encryptForFallback('secret', 'right');
    expect(() => decryptForFallback(enc, 'wrong')).toThrow();
  });

  it('throws when ciphertext bytes are tampered (GCM auth-tag mismatch)', () => {
    const enc = encryptForFallback('payload', 'pw');
    // Flip a single byte in the ciphertext.
    const tampered = {
      ...enc,
      ciphertext: enc.ciphertext.slice(0, -2) +
        (enc.ciphertext.slice(-2) === '00' ? '01' : '00'),
    };
    expect(() => decryptForFallback(tampered, 'pw')).toThrow();
  });

  it('throws when the auth tag is tampered', () => {
    const enc = encryptForFallback('payload', 'pw');
    const tampered = {
      ...enc,
      authTag: enc.authTag.slice(0, -2) +
        (enc.authTag.slice(-2) === '00' ? '01' : '00'),
    };
    expect(() => decryptForFallback(tampered, 'pw')).toThrow();
  });
});

describe('fileBackend (encrypted-file store)', () => {
  let tmpDir: string;
  const PASS = 'test-passphrase';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-test-'));
    process.env.AGENTS_SECRETS_PASSPHRASE = PASS;
    _resetForTest({ fileDir: tmpDir, passphrase: PASS });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    _resetForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips set / get for a single item', () => {
    fileBackend.set('agents-cli.bundles.work', '{"keys":["FOO"]}');
    expect(fileBackend.has('agents-cli.bundles.work')).toBe(true);
    expect(fileBackend.get('agents-cli.bundles.work')).toBe('{"keys":["FOO"]}');
    // File should exist on disk, mode 600, and contain ciphertext (not plaintext).
    const fp = path.join(tmpDir, 'agents-cli.bundles.work.enc');
    expect(fs.existsSync(fp)).toBe(true);
    const stat = fs.statSync(fp);
    expect(stat.mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(fp, 'utf8');
    expect(raw).not.toContain('FOO');
  });

  it('returns false from has() for missing items, throws on get()', () => {
    expect(fileBackend.has('agents-cli.bundles.missing')).toBe(false);
    expect(() => fileBackend.get('agents-cli.bundles.missing')).toThrow(/not found/i);
  });

  it('list() returns only items matching the prefix', () => {
    fileBackend.set('agents-cli.secrets.work.A', 'a');
    fileBackend.set('agents-cli.secrets.work.B', 'b');
    fileBackend.set('agents-cli.secrets.home.A', 'c');
    fileBackend.set('agents-cli.bundles.work', '{}');
    const work = fileBackend.list('agents-cli.secrets.work.').sort();
    expect(work).toEqual([
      'agents-cli.secrets.work.A',
      'agents-cli.secrets.work.B',
    ]);
    const bundles = fileBackend.list('agents-cli.bundles.');
    expect(bundles).toEqual(['agents-cli.bundles.work']);
  });

  it('delete() removes the file and is idempotent', () => {
    fileBackend.set('agents-cli.bundles.tmp', 'x');
    expect(fileBackend.has('agents-cli.bundles.tmp')).toBe(true);
    expect(fileBackend.delete('agents-cli.bundles.tmp')).toBe(true);
    expect(fileBackend.has('agents-cli.bundles.tmp')).toBe(false);
    // Deleting again is a no-op success, matching `secret-tool clear`.
    expect(fileBackend.delete('agents-cli.bundles.tmp')).toBe(true);
  });

  it('overwrites cleanly on repeated set()', () => {
    fileBackend.set('agents-cli.secrets.work.K', 'v1');
    fileBackend.set('agents-cli.secrets.work.K', 'v2');
    expect(fileBackend.get('agents-cli.secrets.work.K')).toBe('v2');
  });

  it('get() throws with a clear message when the passphrase changes mid-process', () => {
    fileBackend.set('agents-cli.secrets.work.K', 'v');
    // Simulate a stale passphrase by resetting and pointing at a different one.
    _resetForTest({ fileDir: tmpDir, passphrase: 'different' });
    process.env.AGENTS_SECRETS_PASSPHRASE = 'different';
    expect(() => fileBackend.get('agents-cli.secrets.work.K')).toThrow(/decrypt|passphrase/i);
  });
});

describe('linuxBackend (via forced file fallback)', () => {
  // Force the file fallback so the public linuxBackend.set/get/delete/list
  // path is exercised without needing a real secret-tool. This is the
  // closest unit-level proxy for "headless Linux with locked collection".
  let tmpDir: string;
  const PASS = 'e2e-pass';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-e2e-'));
    process.env.AGENTS_SECRETS_PASSPHRASE = PASS;
    _resetForTest({ fileDir: tmpDir, forceFileFallback: true, passphrase: PASS });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    _resetForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('set / has / get / list / delete all route through the file fallback', () => {
    linuxBackend.set('agents-cli.bundles.probe', '{}');
    linuxBackend.set('agents-cli.secrets.probe.FOO', 'hello');
    linuxBackend.set('agents-cli.secrets.probe.BAR', 'world');

    expect(linuxBackend.has('agents-cli.secrets.probe.FOO')).toBe(true);
    expect(linuxBackend.has('agents-cli.secrets.probe.MISSING')).toBe(false);

    expect(linuxBackend.get('agents-cli.secrets.probe.FOO')).toBe('hello');
    expect(linuxBackend.get('agents-cli.secrets.probe.BAR')).toBe('world');

    const items = linuxBackend.list('agents-cli.secrets.probe.').sort();
    expect(items).toEqual([
      'agents-cli.secrets.probe.BAR',
      'agents-cli.secrets.probe.FOO',
    ]);

    expect(linuxBackend.delete('agents-cli.secrets.probe.FOO')).toBe(true);
    expect(linuxBackend.has('agents-cli.secrets.probe.FOO')).toBe(false);
    expect(linuxBackend.list('agents-cli.secrets.probe.')).toEqual([
      'agents-cli.secrets.probe.BAR',
    ]);
  });

  it('refuses empty values (matches secret-tool behavior)', () => {
    expect(() => linuxBackend.set('agents-cli.bundles.x', '')).toThrow(/empty/i);
    expect(() => linuxBackend.set('agents-cli.bundles.x', '   ')).toThrow(/empty/i);
  });

  it('a fresh process discovers existing .enc files and stays in file mode', () => {
    // Simulate process #1: write a value via the linuxBackend with file
    // fallback forced.
    linuxBackend.set('agents-cli.bundles.persisted-probe', '{}');
    linuxBackend.set('agents-cli.secrets.persisted-probe.API_KEY', 'kept-across-processes');

    // Simulate process #2: fresh state. `useFileFallback` defaults to false,
    // `forceFileFallback` is NOT passed — the same code path the real CLI hits
    // when the second `agents secrets ...` Node invocation starts up. Only
    // `fileDir` is preserved so we read the same on-disk store, like real
    // life uses ~/.agents/.cache/secrets/.
    _resetForTest({ fileDir: tmpDir, passphrase: PASS });

    // Without the preflight `.enc`-file probe, `list` and `get` would hit
    // secret-tool (or throw if it's not installed) and miss the on-disk items.
    expect(linuxBackend.has('agents-cli.secrets.persisted-probe.API_KEY')).toBe(true);
    expect(linuxBackend.get('agents-cli.secrets.persisted-probe.API_KEY')).toBe('kept-across-processes');
    expect(linuxBackend.list('agents-cli.bundles.')).toEqual(['agents-cli.bundles.persisted-probe']);
    expect(linuxBackend.list('agents-cli.secrets.persisted-probe.')).toEqual(['agents-cli.secrets.persisted-probe.API_KEY']);
  });
});

/**
 * The reported bug (#371): on a headless box the keyring is locked AND no
 * AGENTS_SECRETS_PASSPHRASE is set, so the file fallback's getPassphrase() used
 * to hard-throw — `agents secrets` was unusable out of the box. The fix
 * auto-provisions a machine-local passphrase (0600 file) instead.
 *
 * isTTY is stubbed false so these are deterministic regardless of how the test
 * runner is launched (a real TTY would otherwise hit the interactive prompt).
 */
describe('headless auto-provisioned passphrase (no env, locked keyring)', () => {
  let tmpDir: string;
  let prevTty: boolean | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-autopass-'));
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    prevTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    // No `passphrase` passed → cachedPassphrase stays null, forcing the real
    // getPassphrase() resolution path. Force the file fallback so we don't need
    // a real secret-tool (the closest proxy for "headless, locked collection").
    _resetForTest({ fileDir: tmpDir, forceFileFallback: true });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevTty, configurable: true });
    _resetForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('set/get works without env or keyring, and writes a 0600 .passphrase', () => {
    // Previously this threw "no AGENTS_SECRETS_PASSPHRASE is set".
    linuxBackend.set('agents-cli.secrets.work.API_KEY', 'sk-headless-123');
    expect(linuxBackend.get('agents-cli.secrets.work.API_KEY')).toBe('sk-headless-123');

    const passFp = path.join(tmpDir, '.passphrase');
    expect(fs.existsSync(passFp)).toBe(true);
    expect(fs.statSync(passFp).mode & 0o777).toBe(0o600);
    // The on-disk item is ciphertext, not the plaintext value.
    const enc = fs.readFileSync(path.join(tmpDir, 'agents-cli.secrets.work.API_KEY.enc'), 'utf8');
    expect(enc).not.toContain('sk-headless-123');
  });

  it('the .passphrase file is stable across processes (decrypts later)', () => {
    linuxBackend.set('agents-cli.secrets.work.API_KEY', 'persisted');
    const provisioned = fs.readFileSync(path.join(tmpDir, '.passphrase'), 'utf8');

    // Fresh process: clear in-memory cache, keep the same store dir.
    _resetForTest({ fileDir: tmpDir, forceFileFallback: true });
    expect(linuxBackend.get('agents-cli.secrets.work.API_KEY')).toBe('persisted');
    // Same passphrase reused, not regenerated.
    expect(fs.readFileSync(path.join(tmpDir, '.passphrase'), 'utf8')).toBe(provisioned);
  });

  it('.passphrase is not surfaced as a secret item', () => {
    linuxBackend.set('agents-cli.secrets.work.A', 'a');
    expect(linuxBackend.list('').filter((n) => n.includes('passphrase'))).toEqual([]);
    expect(linuxBackend.has('.passphrase')).toBe(false);
  });

  it('AGENTS_SECRETS_PASSPHRASE still takes precedence over a provisioned file', () => {
    // Provision a machine-local passphrase by writing under no env.
    linuxBackend.set('agents-cli.secrets.work.A', 'under-machine-pass');
    // Now a process with an explicit env passphrase must use THAT, so it cannot
    // decrypt the item written under the machine passphrase.
    process.env.AGENTS_SECRETS_PASSPHRASE = 'explicit-different-pass';
    _resetForTest({ fileDir: tmpDir, forceFileFallback: true });
    expect(() => linuxBackend.get('agents-cli.secrets.work.A')).toThrow(/decrypt|passphrase/i);
  });
});
