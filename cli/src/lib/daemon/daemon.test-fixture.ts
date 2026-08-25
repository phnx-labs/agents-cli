import { beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { setKeychainBackendForTest, type KeychainBackend } from '../secrets/index.js';
import { deleteBundle } from '../secrets/bundles.js';

/**
 * Shared fixture for the daemon.*.test.ts suite slices (RUSH-2819).
 *
 * daemon.test.ts was a single 2201-line file (88 tests, ~112s in CI) — the
 * slowest file in the daemon test-ownership group, serializing an entire
 * vitest fork while every other selected file finished. The suite is split
 * into topical slices so per-file fork parallelism can spread the
 * process-spawning / real-daemon integration tests across workers; the
 * helpers shared by more than one slice live here.
 */

/** An in-memory KeychainBackend stand-in, so a test never touches the real OS keychain. */
export function makeMemoryBackend(): { backend: KeychainBackend; store: Map<string, string> } {
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

/**
 * Registers the keychain-backend swap + AGENTS_SECRETS_NO_AGENT hermeticity
 * beforeEach/afterEach every slice of the original daemon.test.ts ran under,
 * verbatim. Call once at the top level of each slice file.
 */
export function installKeychainHermeticity(): void {
  let restore: KeychainBackend | null = null;
  let prevNoAgent: string | undefined;

  beforeEach(() => {
    const m = makeMemoryBackend();
    restore = setKeychainBackendForTest(m.backend);
    // Hermeticity: readAndResolveBundleEnv consults the running secrets-agent
    // (bundles.ts agentGetSync fast-path) BEFORE the injected keychain backend.
    // On a dev machine where the agent is live and the real `claude` bundle is
    // unlocked, that returns the machine's real CLAUDE_CODE_OAUTH_TOKEN and this
    // test reads a live credential instead of the seeded value (CI has no agent,
    // so it only bites locally). Disable the agent so the read falls through to
    // the in-memory backend above — hermetic regardless of host state.
    prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
    process.env.AGENTS_SECRETS_NO_AGENT = '1';
  });

  afterEach(() => {
    try { deleteBundle('claude'); } catch { /* not created */ }
    setKeychainBackendForTest(restore);
    if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
    else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
  });
}

// The real compiled CLI entry, shared by every slice that drives an actual
// `__daemon-run` subprocess (lifecycle/registry/stop). Computed relative to
// this file's own location, which stays in src/lib/daemon/ alongside every
// slice, so the path math is unaffected by the split.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
