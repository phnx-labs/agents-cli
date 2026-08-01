/**
 * Durable "unlocked session" store (macOS).
 *
 * The secrets broker (agent.ts) holds unlocked bundles only in RAM, so an
 * `agents secrets unlock` grant is lost whenever that process dies: on an
 * agents-cli upgrade (the postinstall bounces the daemon) and on system SLEEP.
 * This module persists the resolved bundle+env of an unlocked bundle as a
 * NO-ACL keychain item — the `set-no-acl` write path, `kSecAttrAccessibleAfter-
 * FirstUnlockThisDeviceOnly`, whose reads never pop Touch ID — so the broker can
 * REHYDRATE it on start and reads can FALL BACK to it when the broker RAM misses.
 *
 * Split-default posture: `sleepPersist` is false by default — the item is deleted
 * on SLEEP so the bundle re-locks on sleep but survives restart/upgrade; the
 * `--durable` flag sets it true so it survives sleep too. Both expire at the TTL.
 *
 * Cross-platform: a NO-OP off macOS. Linux (secret-service) and Windows
 * (Credential Manager) have no broker and resolve secrets durably from the OS
 * store on every read with no prompt (see agent.ts:onDarwin gates) — there is no
 * ephemeral unlock to persist.
 *
 * NEVER enumerate session items: once keychain-name hashing (#316) is active a
 * `list('agents-cli.session.')` matches nothing. All I/O is by KNOWN name — one
 * fixed-name index item lists the held bundles + their metadata, and one blob per
 * bundle holds the env. Every adapter call is best-effort and never throws;
 * persistence is an optimization, not a correctness dependency.
 */

import { getKeychainToken, setKeychainToken, deleteKeychainToken, isKeychainBackendOverridden } from './index.js';
import { GLOBAL_HARNESS, bundleScopeChain } from './scope.js';
import type { SecretsBundle } from './bundles.js';

/** Prefix for all durable session items (device-local, no-ACL). */
export const SESSION_ITEM_PREFIX = 'agents-cli.session.';
/** Fixed-name index item — the ONLY thing we ever need to find without a known
 * bundle name, so it is read/written by this exact name (never enumerated). */
export const SESSION_INDEX_ITEM = 'agents-cli.session.index';

/** One persisted unlocked bundle (mirrors the broker's StoredBundle + posture). */
export interface SessionEntry {
  bundle: SecretsBundle;
  env: Record<string, string>;
  /** epoch ms; the entry is dead once Date.now() passes this. */
  expiresAt: number;
  /** true only for `--durable` unlocks — survives SLEEP. */
  sleepPersist: boolean;
  harness?: string;
}

/** Metadata for one held bundle, kept in the index so we can rehydrate / prune
 * without reading every blob. */
export interface SessionIndexMeta {
  expiresAt: number;
  sleepPersist: boolean;
  harness?: string;
}
export interface SessionIndex {
  bundles: Record<string, SessionIndexMeta>;
}

// ─── Pure core (no I/O — unit-testable on any platform) ─────────────────────

/** The bundle names in the index that are still within their TTL at `now`. */
export function selectRehydratable(index: SessionIndex, now: number): string[] {
  return Object.entries(index.bundles)
    .filter(([, m]) => now < m.expiresAt)
    .map(([name]) => name);
}

/** Split an index on a SLEEP event: keep `sleepPersist` entries, report the rest
 * (which the caller deletes from the keychain). Default entries re-lock on sleep. */
export function pruneOnSleep(index: SessionIndex): { survivors: SessionIndex; deletedNames: string[] } {
  const survivors: SessionIndex = { bundles: {} };
  const deletedNames: string[] = [];
  for (const [name, m] of Object.entries(index.bundles)) {
    if (m.sleepPersist) survivors.bundles[name] = m;
    else deletedNames.push(name);
  }
  return { survivors, deletedNames };
}

/** Drop entries past their TTL; report which were dropped so the caller can
 * delete their blobs. */
export function pruneExpired(index: SessionIndex, now: number): { survivors: SessionIndex; expiredNames: string[] } {
  const survivors: SessionIndex = { bundles: {} };
  const expiredNames: string[] = [];
  for (const [name, m] of Object.entries(index.bundles)) {
    if (now < m.expiresAt) survivors.bundles[name] = m;
    else expiredNames.push(name);
  }
  return { survivors, expiredNames };
}

/** Insert/replace one bundle in the index (pure). */
export function upsertEntry(index: SessionIndex, name: string, meta: SessionIndexMeta): SessionIndex {
  return { bundles: { ...index.bundles, [name]: meta } };
}

/** Remove one bundle from the index (pure). */
export function removeEntry(index: SessionIndex, name: string): SessionIndex {
  const { [name]: _drop, ...rest } = index.bundles;
  void _drop;
  return { bundles: rest };
}

// ─── Keychain adapter (macOS only; best-effort, never throws) ────────────────

/** Whether to actually persist. macOS in production; also whenever a test
 * keychain backend is installed, so the adapter is exercisable on Linux CI
 * against an in-memory store (mirrors the broker's hermetic-test gating). In real
 * Linux/Windows production this is false — secrets already persist in the OS store
 * with no broker, so there is nothing to mirror. */
function shouldPersist(): boolean {
  return process.platform === 'darwin' || isKeychainBackendOverridden();
}

function sessionBlobItem(name: string, harness: string): string {
  return `${SESSION_ITEM_PREFIX}${harness}.${name}`;
}

/** Read the session index by its fixed name. `{bundles:{}}` when absent/unreadable. */
export function readIndex(): SessionIndex {
  try {
    const raw = getKeychainToken(SESSION_INDEX_ITEM);
    const parsed = JSON.parse(raw) as SessionIndex;
    if (parsed && typeof parsed === 'object' && parsed.bundles) return parsed;
  } catch {
    /* absent or malformed → empty */
  }
  return { bundles: {} };
}

/** Persist the index as a no-ACL item. Deletes the item when empty (tidy). */
export function writeIndex(index: SessionIndex): void {
  try {
    if (Object.keys(index.bundles).length === 0) {
      deleteKeychainToken(SESSION_INDEX_ITEM);
      return;
    }
    setKeychainToken(SESSION_INDEX_ITEM, JSON.stringify(index), { noAcl: true });
  } catch {
    /* best-effort */
  }
}

/** Persist one unlocked bundle: write its blob no-ACL and record it in the index. */
export function saveSession(name: string, entry: SessionEntry): void {
  if (!shouldPersist()) return;
  try {
    const harness = entry.harness || GLOBAL_HARNESS;
    const key = `${harness}:${name}`;
    setKeychainToken(sessionBlobItem(name, harness), JSON.stringify({ ...entry, harness }), { noAcl: true });
    writeIndex(upsertEntry(readIndex(), key, { expiresAt: entry.expiresAt, sleepPersist: entry.sleepPersist, harness }));
  } catch {
    /* best-effort — persistence is an optimization */
  }
}

/**
 * Read a session honoring the scope chain: the caller's own harness first, then
 * the global grant (see bundleScopeChain in scope.ts). This is the durable-store
 * twin of the broker's `get` — both must resolve identically, or a bundle would
 * be readable from RAM but not after a restart.
 */
export function resolveSession(
  name: string,
  now: number = Date.now(),
  harness: string = GLOBAL_HARNESS,
): { entry: SessionEntry; harness: string } | null {
  for (const scope of bundleScopeChain(harness)) {
    const entry = loadSession(name, now, scope);
    if (entry) return { entry, harness: scope };
  }
  return null;
}

/** Read one session blob by known name. Null when absent/expired/malformed. */
export function loadSession(name: string, now: number = Date.now(), harness: string = GLOBAL_HARNESS): SessionEntry | null {
  if (!shouldPersist()) return null;
  try {
    const raw = getKeychainToken(sessionBlobItem(name, harness));
    const entry = JSON.parse(raw) as SessionEntry;
    if (!entry || typeof entry !== 'object' || !entry.bundle || !entry.env) return null;
    if (now >= entry.expiresAt) {
      deleteSession(name, harness); // drop expired on read
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

/** Remove every persisted harness grant for one bundle. */
export function deleteBundleSessions(name: string): void {
  if (!shouldPersist()) return;
  const index = readIndex();
  let next = index;
  for (const [key, meta] of Object.entries(index.bundles)) {
    const scopedName = key.includes(':') ? key.split(':').slice(1).join(':') : key;
    if (scopedName !== name) continue;
    const harness = meta.harness || GLOBAL_HARNESS;
    try { deleteKeychainToken(key.includes(':') ? sessionBlobItem(name, harness) : `${SESSION_ITEM_PREFIX}${name}`); } catch { /* keep going */ }
    next = removeEntry(next, key);
  }
  writeIndex(next);
}

/** Delete one bundle's session blob and prune it from the index. */
export function deleteSession(name: string, harness: string = GLOBAL_HARNESS): void {
  if (!shouldPersist()) return;
  try {
    deleteKeychainToken(sessionBlobItem(name, harness));
    writeIndex(removeEntry(readIndex(), `${harness}:${name}`));
  } catch {
    /* best-effort */
  }
}

/** Delete every session blob + the index (for `secrets lock --all`). */
export function deleteAllSessions(): void {
  if (!shouldPersist()) return;
  try {
    for (const name of Object.keys(readIndex().bundles)) {
      const meta = readIndex().bundles[name];
      const bundleName = name.includes(':') ? name.split(':').slice(1).join(':') : name;
      try {
        deleteKeychainToken(name.includes(':')
          ? sessionBlobItem(bundleName, meta.harness || GLOBAL_HARNESS)
          : `${SESSION_ITEM_PREFIX}${bundleName}`);
      } catch { /* keep going */ }
    }
    deleteKeychainToken(SESSION_INDEX_ITEM);
  } catch {
    /* best-effort */
  }
}

/** Rehydrate every unexpired session into `[name, entry]` pairs for the broker to
 * load on start; prunes expired index entries + blobs as a side effect. Survives
 * upgrade/restart. Empty off darwin or when nothing is held. */
export function rehydrateSessions(now: number = Date.now()): Array<{ name: string; entry: SessionEntry }> {
  if (!shouldPersist()) return [];
  const out: Array<{ name: string; entry: SessionEntry }> = [];
  try {
    const index = readIndex();
    // One-time source migration from the pre-harness layout. Move each legacy
    // bundle-name index/blob to the explicit cli scope, then delete the old blob.
    let migratedIndex = index;
    for (const [key, meta] of Object.entries(index.bundles)) {
      if (key.includes(':')) continue;
      try {
        const raw = getKeychainToken(`${SESSION_ITEM_PREFIX}${key}`);
        const legacy = JSON.parse(raw) as SessionEntry;
        setKeychainToken(sessionBlobItem(key, GLOBAL_HARNESS), JSON.stringify({ ...legacy, harness: GLOBAL_HARNESS }), { noAcl: true });
        deleteKeychainToken(`${SESSION_ITEM_PREFIX}${key}`);
        migratedIndex = upsertEntry(removeEntry(migratedIndex, key), `${GLOBAL_HARNESS}:${key}`, {
          expiresAt: meta.expiresAt,
          sleepPersist: meta.sleepPersist,
          harness: GLOBAL_HARNESS,
        });
      } catch { /* malformed/absent legacy entry is pruned below */ }
    }
    // Second source migration: `cli`-scoped grants predate the global scope. `cli`
    // was never a harness — it was the default when no AGENTS_AGENT_NAME was set,
    // i.e. "unlocked from a terminal for general use", which is exactly the global
    // grant. Rewriting them means an unlock a user already paid Touch ID for keeps
    // working after upgrade instead of silently becoming unreadable to every agent.
    for (const [key, meta] of Object.entries(migratedIndex.bundles)) {
      if (!key.startsWith('cli:')) continue;
      const bundleName = key.slice('cli:'.length);
      const globalKey = `${GLOBAL_HARNESS}:${bundleName}`;
      // A global grant for this bundle can already exist: the user re-runs
      // `unlock` on the new code (which writes the global scope) before the
      // broker restarts to run this migration. The existing global grant is the
      // NEWER one, so the stale `cli` entry is discarded, never merged over it —
      // overwriting would restore a superseded token and, if the stale entry had
      // expired, hand its expiry to the fresh grant so the prune below deletes a
      // valid unlock outright.
      if (migratedIndex.bundles[globalKey]) {
        try { deleteKeychainToken(sessionBlobItem(bundleName, 'cli')); } catch { /* already gone */ }
        migratedIndex = removeEntry(migratedIndex, key);
        continue;
      }
      try {
        const raw = getKeychainToken(sessionBlobItem(bundleName, 'cli'));
        const legacy = JSON.parse(raw) as SessionEntry;
        setKeychainToken(sessionBlobItem(bundleName, GLOBAL_HARNESS), JSON.stringify({ ...legacy, harness: GLOBAL_HARNESS }), { noAcl: true });
        deleteKeychainToken(sessionBlobItem(bundleName, 'cli'));
        migratedIndex = upsertEntry(removeEntry(migratedIndex, key), globalKey, {
          expiresAt: meta.expiresAt,
          sleepPersist: meta.sleepPersist,
          harness: GLOBAL_HARNESS,
        });
      } catch { /* malformed/absent entry is pruned below */ }
    }
    writeIndex(migratedIndex);
    index.bundles = migratedIndex.bundles;
    const { survivors, expiredNames } = pruneExpired(index, now);
    for (const name of expiredNames) {
      const meta = index.bundles[name]; try { deleteKeychainToken(sessionBlobItem(name.split(':').slice(1).join(':'), meta.harness || GLOBAL_HARNESS)); } catch { /* keep going */ }
    }
    if (expiredNames.length) writeIndex(survivors);
    for (const name of selectRehydratable(survivors, now)) {
      const meta = survivors.bundles[name]; const bundleName = name.split(':').slice(1).join(':');
      const entry = loadSession(bundleName, now, meta.harness || GLOBAL_HARNESS);
      if (entry) out.push({ name: bundleName, entry });
    }
  } catch {
    /* best-effort */
  }
  return out;
}

/** On a SLEEP event: delete every non-`--durable` session (blob + index entry),
 * keep the durable ones. Default bundles thus re-lock on sleep. */
export function pruneSessionsOnSleep(): void {
  if (!shouldPersist()) return;
  try {
    const { survivors, deletedNames } = pruneOnSleep(readIndex());
    for (const name of deletedNames) {
      const meta = readIndex().bundles[name];
      try { deleteKeychainToken(sessionBlobItem(name.split(':').slice(1).join(':'), meta.harness || GLOBAL_HARNESS)); } catch { /* keep going */ }
    }
    writeIndex(survivors);
  } catch {
    /* best-effort */
  }
}
