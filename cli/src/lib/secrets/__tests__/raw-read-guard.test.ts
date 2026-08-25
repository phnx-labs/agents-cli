import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getKeychainToken,
  getKeychainTokens,
  setKeychainHeadlessDetectorForTest,
} from '../index.js';
import {
  KEYCHAIN_READ_BACKOFF_TTL_MS,
  clearKeychainReadBackoff,
  isKeychainReadBackedOff,
  noteKeychainReadFailure,
  setKeychainReadBackoffDirForTest,
} from '../read-backoff.js';

/**
 * The raw-read storm guard (index.ts `assertRawKeychainReadAllowed`) — the fix
 * for background processes (AGI EXT host's `agents view` poll,
 * daemons, cron) raising Touch ID sheets on the interactive user's screen:
 * 167 sheets in one day, each one a TTY-less keychain read nobody could answer.
 *
 * These tests install NO keychain backend, so the guard sits directly on the
 * path under test; the headless detector is stubbed via its sanctioned seam
 * (the real detector self-gates to darwin, which would make the throw
 * unreachable from a Linux CI run — the same parameterization argument as the
 * injected env/platform/tty on isHeadlessSecretsContext).
 *
 * The guard fires BEFORE any platform branch or helper spawn, so a throw here
 * proves no keychain process was ever launched.
 */

const HEADLESS = /non-interactive/;
const BACKOFF = /back-off/;

describe('raw keychain read storm guard', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-read-guard-'));
    setKeychainReadBackoffDirForTest(dir);
  });

  afterEach(() => {
    setKeychainHeadlessDetectorForTest(null);
    setKeychainReadBackoffDirForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a headless single read fails fast, naming the item and the fix — never spawning the helper', () => {
    setKeychainHeadlessDetectorForTest(() => true);
    expect(() => getKeychainToken('agents-cli.guard-test.token')).toThrow(HEADLESS);
    expect(() => getKeychainToken('agents-cli.guard-test.token')).toThrow(/agents-cli\.guard-test\.token/);
    expect(() => getKeychainToken('agents-cli.guard-test.token')).toThrow(/interactive terminal/);
  });

  it('a headless BATCH read fails fast too — bundles reach the helper only through here', () => {
    setKeychainHeadlessDetectorForTest(() => true);
    expect(() => getKeychainTokens(['agents-cli.bundles.prod', 'agents-cli.secrets.prod.KEY'])).toThrow(HEADLESS);
  });

  it('the batch error points at agents secrets unlock when a bundle triggered the read', () => {
    setKeychainHeadlessDetectorForTest(() => true);
    expect(() =>
      getKeychainTokens(['agents-cli.bundles.prod'], { bundle: 'prod' }),
    ).toThrow(/agents secrets unlock prod/);
  });

  it('silentNoAcl attestation bypasses the guard — a no-ACL read is prompt-free even headless', () => {
    setKeychainHeadlessDetectorForTest(() => true);
    // Past the guard the read reaches the real platform path and fails there
    // (no helper in a source checkout / no such item) — crucially NOT with the
    // headless error. This is what keeps session-store / vault / usage-cache
    // headless reads working.
    try {
      getKeychainToken('agents-cli.guard-test.noacl', { silentNoAcl: true });
    } catch (err) {
      expect((err as Error).message).not.toMatch(HEADLESS);
      return;
    }
    // A value coming back is fine too (item exists on a dev machine): the
    // assertion is only that the guard did not throw.
  });

  it('a non-headless context is NOT blocked by the guard', () => {
    setKeychainHeadlessDetectorForTest(() => false);
    try {
      getKeychainToken('agents-cli.guard-test.interactive');
    } catch (err) {
      expect((err as Error).message).not.toMatch(HEADLESS);
      expect((err as Error).message).not.toMatch(BACKOFF);
    }
  });

  it('a backed-off item fails fast with the back-off error instead of re-prompting', () => {
    setKeychainHeadlessDetectorForTest(() => false);
    noteKeychainReadFailure('agents-cli.guard-test.cancelled');
    expect(() => getKeychainToken('agents-cli.guard-test.cancelled')).toThrow(BACKOFF);
    expect(() => getKeychainToken('agents-cli.guard-test.cancelled')).toThrow(/agents-cli\.guard-test\.cancelled/);
  });

  it('the headless fail-fast wins over an open back-off (the more actionable error)', () => {
    setKeychainHeadlessDetectorForTest(() => true);
    noteKeychainReadFailure('agents-cli.guard-test.both');
    expect(() => getKeychainToken('agents-cli.guard-test.both')).toThrow(HEADLESS);
  });

  it('silentNoAcl bypasses an open back-off — a no-ACL read never prompted, so there is nothing to suppress', () => {
    setKeychainHeadlessDetectorForTest(() => false);
    noteKeychainReadFailure('agents-cli.guard-test.noacl-bo');
    try {
      getKeychainToken('agents-cli.guard-test.noacl-bo', { silentNoAcl: true });
    } catch (err) {
      expect((err as Error).message).not.toMatch(BACKOFF);
    }
  });

  it('a backed-off batch fails fast', () => {
    setKeychainHeadlessDetectorForTest(() => false);
    noteKeychainReadFailure('batch:a\nb');
    expect(() => getKeychainTokens(['a', 'b'])).toThrow(BACKOFF);
  });
});

describe('keychain read back-off memo', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-read-backoff-'));
    setKeychainReadBackoffDirForTest(dir);
  });

  afterEach(() => {
    setKeychainReadBackoffDirForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('no memo → not backed off', () => {
    expect(isKeychainReadBackedOff('never-failed')).toBe(false);
  });

  it('a recorded failure backs the item off within the TTL', () => {
    noteKeychainReadFailure('item-x');
    expect(isKeychainReadBackedOff('item-x')).toBe(true);
    // ...but not a different item.
    expect(isKeychainReadBackedOff('item-y')).toBe(false);
  });

  it('expires after the TTL', () => {
    const past = Date.now() - KEYCHAIN_READ_BACKOFF_TTL_MS - 1000;
    noteKeychainReadFailure('item-old', past);
    expect(isKeychainReadBackedOff('item-old')).toBe(false);
  });

  it('clear drops the memo (a successful read/write resets the back-off)', () => {
    noteKeychainReadFailure('item-z');
    clearKeychainReadBackoff('item-z');
    expect(isKeychainReadBackedOff('item-z')).toBe(false);
  });

  it('a malformed memo file means no back-off (regenerable state, never a read blocker)', () => {
    noteKeychainReadFailure('item-m');
    const file = fs.readdirSync(dir)[0];
    fs.writeFileSync(path.join(dir, file), 'not json');
    expect(isKeychainReadBackedOff('item-m')).toBe(false);
  });

  it('the memo carries no secret material — only the item name and a deadline', () => {
    noteKeychainReadFailure('item-plain');
    const file = fs.readdirSync(dir)[0];
    const stored = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['item', 'until']);
  });
});
