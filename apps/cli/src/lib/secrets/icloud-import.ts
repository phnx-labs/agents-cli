/**
 * Recovery for LEGACY SYNCHRONIZABLE (iCloud Keychain) bundles.
 *
 * The pre-biometry helper era defaulted bundles to iCloud Keychain sync. The
 * device-local cutover (biometry ACL + kSecAttrSynchronizable false on every
 * query) orphaned those items: they still sync back via iCloud Keychain, but
 * neither `secrets list` nor `migrate-acl` can see them. This module powers
 * `agents secrets import --from icloud` — discover the orphaned bundles,
 * re-import them as normal device-local bundles, and optionally purge the
 * iCloud copies.
 *
 * The item-name scheme is the same one the modern store uses (see bundles.ts):
 * metadata under `agents-cli.bundles.<name>`, one value per key under
 * `agents-cli.secrets.<bundle>.<key>`. Env keys can never contain a dot
 * (ENV_KEY_PATTERN), so splitting a secret service at its LAST dot recovers
 * the bundle/key boundary even for dotted bundle names like `hetzner.com`.
 */

import {
  deleteSyncedKeychainItem,
  getSyncedKeychainTokens,
  listSyncedKeychainItems,
  parseBundleValue,
  secretsKeychainItem,
  serializeRef,
  SECRETS_ITEM_PREFIX,
  type BundleValue,
  type SecretRef,
} from './index.js';
import {
  BUNDLE_META_PREFIX,
  BUNDLE_NAME_PATTERN,
  ENV_KEY_PATTERN,
  bundleExists,
  bundleItemStore,
  bundlePolicy,
  isLoaderOrInterpreterEnv,
  isReservedEnvName,
  keychainRef,
  readBundle,
  writeBundle,
  type SecretsBackend,
  type SecretsBundle,
} from './bundles.js';

/** One orphaned iCloud bundle, as discovered from the synced item names. */
export interface SyncedBundleCandidate {
  /** Bundle name derived from the iCloud service names. */
  name: string;
  /** Env keys that have a per-key secret item in the iCloud keychain. */
  keys: string[];
  /** True when an `agents-cli.bundles.<name>` metadata item exists in iCloud. */
  hasMeta: boolean;
  /** Every iCloud service name belonging to this candidate (the purge set). */
  services: string[];
}

/**
 * Group raw synced service names into per-bundle candidates. Pure — separated
 * from discovery so the parsing rules are unit-testable without a keychain.
 *
 * A bundle can surface as metadata only (`agents-cli.bundles.<name>`), as
 * secret items only (`agents-cli.secrets.<bundle>.<KEY>` — metadata never
 * synced), or both; all three shapes appear in real iCloud strays, so every
 * one becomes a candidate.
 */
export function groupSyncedServices(services: string[]): SyncedBundleCandidate[] {
  const byName = new Map<string, SyncedBundleCandidate>();
  const claim = (name: string): SyncedBundleCandidate => {
    let c = byName.get(name);
    if (!c) {
      c = { name, keys: [], hasMeta: false, services: [] };
      byName.set(name, c);
    }
    return c;
  };
  for (const svc of services) {
    if (svc.startsWith(BUNDLE_META_PREFIX)) {
      const name = svc.slice(BUNDLE_META_PREFIX.length);
      if (!BUNDLE_NAME_PATTERN.test(name)) continue;
      const c = claim(name);
      c.hasMeta = true;
      c.services.push(svc);
    } else if (svc.startsWith(SECRETS_ITEM_PREFIX)) {
      const rest = svc.slice(SECRETS_ITEM_PREFIX.length);
      const cut = rest.lastIndexOf('.');
      if (cut <= 0) continue;
      const name = rest.slice(0, cut);
      const key = rest.slice(cut + 1);
      if (!BUNDLE_NAME_PATTERN.test(name) || !ENV_KEY_PATTERN.test(key)) continue;
      const c = claim(name);
      if (!c.keys.includes(key)) c.keys.push(key);
      c.services.push(svc);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Enumerate the iCloud keychain and return every orphaned bundle candidate. */
export function discoverSyncedBundles(): SyncedBundleCandidate[] {
  return groupSyncedServices(listSyncedKeychainItems('agents-cli.'));
}

export interface ImportSyncedOptions {
  /** Overwrite keys that already exist in the local bundle. */
  force?: boolean;
  /** Store imported values as literals in the bundle metadata (no keychain items). */
  allPlaintext?: boolean;
  /** Backend for a newly created bundle (existing bundles keep theirs). */
  backend?: SecretsBackend;
  /** Delete the iCloud copies of successfully-read items after import. */
  purge?: boolean;
}

export interface ImportSyncedResult {
  name: string;
  added: number;
  skipped: number;
  /** Keys whose iCloud value could not be read (left in place, never purged). */
  missing: string[];
  /**
   * Keys the modern store refuses by policy (reserved env names like USER,
   * loader/interpreter vars like DYLD_*) — the pre-cutover store accepted
   * them. Left in iCloud, never purged: the iCloud item is the only copy.
   */
  unimportable: string[];
  purged: number;
}

/**
 * Import one discovered iCloud bundle into the local (device-local) store.
 *
 * Values come from the synced secret items; the synced metadata item, when
 * present, contributes the description, literal vars, and non-keychain refs
 * (env:/file:/exec: refs carry no stored secret, so copying the ref preserves
 * them exactly). Existing local keys are skipped unless `force`. Keys the
 * modern store refuses by policy (reserved / loader env names the pre-cutover
 * store accepted) are reported as `unimportable` instead of aborting the whole
 * bundle. With `purge`, only services whose value provably lives locally
 * (imported now, or skipped-because-present) are deleted from iCloud — an
 * unreadable or unimportable item is never destroyed.
 */
export function importSyncedBundle(
  candidate: SyncedBundleCandidate,
  opts: ImportSyncedOptions = {},
): ImportSyncedResult {
  const values = getSyncedKeychainTokens(candidate.services);

  let bundle: SecretsBundle;
  if (bundleExists(candidate.name)) {
    bundle = readBundle(candidate.name);
  } else {
    bundle = {
      name: candidate.name,
      backend: opts.backend === 'file' ? 'file' : undefined,
      vars: {},
    };
  }

  const metaService = BUNDLE_META_PREFIX + candidate.name;
  let metaVars: Record<string, BundleValue> = {};
  const metaJson = values.get(metaService);
  if (metaJson !== undefined) {
    try {
      const parsed = JSON.parse(metaJson) as { description?: unknown; vars?: unknown };
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.description === 'string' && !bundle.description) {
          bundle.description = parsed.description;
        }
        if (parsed.vars && typeof parsed.vars === 'object') {
          metaVars = parsed.vars as Record<string, BundleValue>;
        }
      }
    } catch {
      // Corrupt legacy metadata — the per-key secret items still import.
    }
  }

  const store = bundleItemStore(bundle.backend, { noAcl: bundlePolicy(bundle) === 'never' });
  let added = 0;
  let skipped = 0;
  const missing: string[] = [];
  const unimportable: string[] = [];
  // Services whose value now provably lives in the local store — imported this
  // run, or skipped because the local bundle already carries the key. Only
  // these may be purged; a missing or unimportable key's iCloud item is its
  // only copy and must survive.
  const purgeable = new Set<string>();
  const rejectedByPolicy = (key: string) => isLoaderOrInterpreterEnv(key) || isReservedEnvName(key);

  // Keys with a synced secret item: re-store the value device-locally.
  for (const key of candidate.keys) {
    // The pre-cutover store accepted keys the modern one refuses (writeBundle
    // throws) — skip them instead of aborting the whole bundle.
    if (rejectedByPolicy(key)) {
      unimportable.push(key);
      continue;
    }
    const value = values.get(secretsKeychainItem(candidate.name, key));
    if (value === undefined) {
      missing.push(key);
      continue;
    }
    if (!opts.force && key in bundle.vars) {
      skipped++;
      purgeable.add(secretsKeychainItem(candidate.name, key));
      continue;
    }
    if (opts.allPlaintext) {
      bundle.vars[key] = { value };
    } else {
      store.set(secretsKeychainItem(candidate.name, key), value);
      bundle.vars[key] = keychainRef(key);
    }
    purgeable.add(secretsKeychainItem(candidate.name, key));
    added++;
  }

  // Vars declared only in the synced metadata: literals and non-keychain refs
  // carry everything they need; a keychain ref without its synced item is
  // unrecoverable.
  for (const [key, raw] of Object.entries(metaVars)) {
    if (!ENV_KEY_PATTERN.test(key)) continue;
    if (candidate.keys.includes(key)) continue; // the secret item already covered it
    if (rejectedByPolicy(key)) {
      if (!unimportable.includes(key)) unimportable.push(key);
      continue;
    }
    let parsed: { literal: string } | { ref: SecretRef };
    try {
      parsed = parseBundleValue(raw);
    } catch {
      continue; // malformed legacy entry
    }
    if ('ref' in parsed && parsed.ref.provider === 'keychain') {
      if (!missing.includes(key)) missing.push(key);
      continue;
    }
    if (!opts.force && key in bundle.vars) {
      skipped++;
      continue;
    }
    bundle.vars[key] = 'literal' in parsed ? { value: parsed.literal } : serializeRef(parsed.ref);
    added++;
  }

  writeBundle(bundle);
  // The metadata item is only a projection of what was just written locally —
  // safe to purge once writeBundle has succeeded, UNLESS it still names keys
  // that never made it over (missing/unimportable): then it stays as the only
  // record of them.
  if (metaJson !== undefined && missing.length === 0 && unimportable.length === 0) {
    purgeable.add(metaService);
  }

  let purged = 0;
  if (opts.purge) {
    for (const svc of candidate.services) {
      if (!purgeable.has(svc)) continue;
      if (deleteSyncedKeychainItem(svc)) purged++;
    }
  }

  return { name: candidate.name, added, skipped, missing, unimportable, purged };
}
