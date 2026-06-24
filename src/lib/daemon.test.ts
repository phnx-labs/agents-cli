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
} from './daemon.js';
import {
  secretsKeychainItem,
  setKeychainBackendForTest,
  type KeychainBackend,
} from './secrets/index.js';

const OAUTH_ITEM = secretsKeychainItem('claude', 'CLAUDE_CODE_OAUTH_TOKEN');

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

let restore: KeychainBackend | null = null;
let store: Map<string, string>;

beforeEach(() => {
  const m = makeMemoryBackend();
  store = m.store;
  restore = setKeychainBackendForTest(m.backend);
});

afterEach(() => {
  setKeychainBackendForTest(restore);
});

describe('readDaemonClaudeOAuthToken', () => {
  it('returns null when no token is configured', () => {
    expect(readDaemonClaudeOAuthToken()).toBeNull();
  });

  it('returns the stored token', () => {
    store.set(OAUTH_ITEM, 'sk-ant-oat01-abc123');
    expect(readDaemonClaudeOAuthToken()).toBe('sk-ant-oat01-abc123');
  });

  it('trims surrounding whitespace from the stored token', () => {
    store.set(OAUTH_ITEM, '  sk-ant-oat01-abc123\n');
    expect(readDaemonClaudeOAuthToken()).toBe('sk-ant-oat01-abc123');
  });

  it('treats an empty/whitespace-only token as absent', () => {
    store.set(OAUTH_ITEM, '   ');
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
    store.set(OAUTH_ITEM, 'sk-ant-oat01-abc123');
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
    store.set(OAUTH_ITEM, 'tok&en<x>');
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
    store.set(OAUTH_ITEM, 'sk-ant-oat01-abc123');
    expect(generateSystemdUnit()).toContain(
      'Environment=CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc123',
    );
  });
});
