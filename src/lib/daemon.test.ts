/**
 * Daemon service-manifest generation.
 *
 * The load-bearing behavior under test: a long-lived Claude OAuth token stored
 * in the `claude` secrets bundle is baked into the launchd plist / systemd unit
 * environment, so headless routine runs stop depending on the short-lived
 * interactive Keychain OAuth session. The Keychain itself is swapped for an
 * in-memory backend via setKeychainBackendForTest — the contract here is the
 * generator, not the Keychain wiring (that rides the e2e smoke run).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  readDaemonClaudeOAuthToken,
  buildDetachedDaemonEnv,
} from './daemon.js';
import {
  secretsKeychainItem,
  setKeychainToken,
  setKeychainBackendForTest,
  type KeychainBackend,
} from './secrets/index.js';
import { writeBundle, deleteBundle } from './secrets/bundles.js';

function makeMemoryBackend(): { backend: KeychainBackend; store: Map<string, string> } {
  const store = new Map<string, string>();
  const backend: KeychainBackend = {
    has: (item) => store.has(item),
    get: (item) => {
      const v = store.get(item);
      if (v === undefined) throw new Error(`Keychain item '${item}' not found.`);
      return v;
    },
    set: (item, value) => { store.set(item, value); },
    delete: (item) => store.delete(item),
    list: (prefix) => Array.from(store.keys()).filter((k) => k.startsWith(prefix)),
  };
  return { backend, store };
}

/** Seed the `claude` bundle with a keychain-backed CLAUDE_CODE_OAUTH_TOKEN. */
function seedKeychainBacked(value: string): void {
  writeBundle({ name: 'claude', vars: { CLAUDE_CODE_OAUTH_TOKEN: 'keychain:CLAUDE_CODE_OAUTH_TOKEN' } });
  setKeychainToken(secretsKeychainItem('claude', 'CLAUDE_CODE_OAUTH_TOKEN'), value);
}

/** Seed the `claude` bundle with a literal CLAUDE_CODE_OAUTH_TOKEN. */
function seedLiteral(value: string): void {
  writeBundle({ name: 'claude', vars: { CLAUDE_CODE_OAUTH_TOKEN: value } });
}

let restore: KeychainBackend | null = null;

beforeEach(() => {
  const m = makeMemoryBackend();
  restore = setKeychainBackendForTest(m.backend);
});

afterEach(() => {
  try { deleteBundle('claude'); } catch { /* not created */ }
  setKeychainBackendForTest(restore);
});

describe('readDaemonClaudeOAuthToken', () => {
  it('returns null when the bundle does not exist', () => {
    expect(readDaemonClaudeOAuthToken()).toBeNull();
  });

  it('returns a keychain-backed token', () => {
    seedKeychainBacked('sk-ant-oat01-abc123');
    expect(readDaemonClaudeOAuthToken()).toBe('sk-ant-oat01-abc123');
  });

  it('returns a token stored as a literal (the no-op footgun fix)', () => {
    seedLiteral('sk-ant-oat01-literal');
    expect(readDaemonClaudeOAuthToken()).toBe('sk-ant-oat01-literal');
  });

  it('trims surrounding whitespace from the stored token', () => {
    seedKeychainBacked('  sk-ant-oat01-abc123\n');
    expect(readDaemonClaudeOAuthToken()).toBe('sk-ant-oat01-abc123');
  });

  it('treats an empty/whitespace-only token as absent', () => {
    seedKeychainBacked('   ');
    expect(readDaemonClaudeOAuthToken()).toBeNull();
  });
});

describe('generateLaunchdPlist', () => {
  it('omits CLAUDE_CODE_OAUTH_TOKEN when none is configured', () => {
    const plist = generateLaunchdPlist();
    expect(plist).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    // The PATH entry is always present so EnvironmentVariables is never empty.
    expect(plist).toContain('<key>PATH</key>');
  });

  it('injects the token into EnvironmentVariables when configured', () => {
    seedKeychainBacked('sk-ant-oat01-abc123');
    const plist = generateLaunchdPlist();
    expect(plist).toContain('<key>CLAUDE_CODE_OAUTH_TOKEN</key>');
    expect(plist).toContain('<string>sk-ant-oat01-abc123</string>');
    // Must sit inside the EnvironmentVariables dict, after PATH.
    const envIdx = plist.indexOf('<key>EnvironmentVariables</key>');
    const tokenIdx = plist.indexOf('<key>CLAUDE_CODE_OAUTH_TOKEN</key>');
    expect(envIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeGreaterThan(envIdx);
  });

  it('XML-escapes special characters in the token value', () => {
    seedKeychainBacked('tok&en<x>');
    const plist = generateLaunchdPlist();
    expect(plist).toContain('<string>tok&amp;en&lt;x&gt;</string>');
    expect(plist).not.toContain('<string>tok&en<x></string>');
  });
});

describe('generateSystemdUnit', () => {
  it('omits the token Environment line when none is configured', () => {
    expect(generateSystemdUnit()).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('adds an Environment line for the token when configured', () => {
    seedKeychainBacked('sk-ant-oat01-abc123');
    expect(generateSystemdUnit()).toContain(
      'Environment=CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc123',
    );
  });
});

describe('buildDetachedDaemonEnv', () => {
  it('injects the token when configured and absent from the base env', () => {
    seedKeychainBacked('sk-ant-oat01-detached');
    const env = buildDetachedDaemonEnv({ PATH: '/usr/bin' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-detached');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('leaves an already-set token untouched (launchd-provided wins)', () => {
    seedKeychainBacked('sk-ant-oat01-fromKeychain');
    const env = buildDetachedDaemonEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fromEnv' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-fromEnv');
  });

  it('adds no token key when none is configured', () => {
    const env = buildDetachedDaemonEnv({ PATH: '/usr/bin' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
