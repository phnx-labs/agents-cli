/**
 * Canonical audit emitter for every `agents secrets` lifecycle/access event.
 *
 * This is the ONE write path for secret events. Every path that creates,
 * imports, exports, views, reads a VALUE from, or unlocks a bundle funnels its
 * audit through here, so the operational event stream — `agents events`, backed
 * by the dated append-only `~/.agents/.history/events/` audit log — carries a uniform,
 * value-free provenance record: bundle, key NAMES, the resolving agent/harness
 * identity, operation, source, status. The ts / host / session / caller fields
 * are filled in by `emit()` itself. The secret VALUE is never part of the
 * payload; this helper only ever receives metadata, and `emit()`'s
 * `sanitizePayload` is a second redaction layer.
 *
 * The same call also mirrors the event into the per-bundle usage read-model DB
 * (`~/.agents/secrets/secrets.db`, lib/secrets/usage-db.ts) so `secrets view` /
 * `list` / `activity` can answer "how often / how recently / by whom was this
 * bundle used?" without scanning the whole event stream — a DERIVED index fed
 * off this chokepoint, not a second write path a caller has to remember.
 *
 * The event vocabulary, all audit-level and non-milestone (so they surface in
 * `agents events` and the persisted audit trail, but are NOT required in the
 * curated `agents feed` surface):
 *  - `secrets.get`      — a value was READ (exec inject, export, `view --reveal`,
 *                         raw `get <item>`, remote resolve, sync push,
 *                         `run --secrets`, and every other bundle read).
 *  - `secrets.unlocked` — a bundle was GRANTED into the secrets broker / durable
 *                         session by `agents secrets unlock`, then readable
 *                         prompt-free for the grant TTL.
 *  - `secrets.create`   — a new bundle was created.
 *  - `secrets.import`   — keys were imported into a bundle (file / ssh / 1password).
 *  - `secrets.export`   — a bundle's values were exported (file / shell / ssh /
 *                         1password). Exporting also READS the values, so the
 *                         underlying resolve emits its own `secrets.get`.
 *  - `secrets.view`     — a bundle's (masked) metadata was inspected via `view`.
 */
import { emit } from '../events.js';
import { recordSecretUsage, type SecretUsageEvent } from './usage-db.js';

export type SecretAuditEvent =
  | 'secrets.get'
  | 'secrets.unlocked'
  | 'secrets.create'
  | 'secrets.import'
  | 'secrets.export'
  | 'secrets.view'
  | 'secrets.lease-denied'
  | 'secrets.lease-expire';

/**
 * Map each audit event onto the usage-DB kind it is counted as. `secrets.get` is
 * the injection/read access; the rest map 1:1 to their lifecycle kind.
 */
const USAGE_KIND: Record<SecretAuditEvent, SecretUsageEvent> = {
  'secrets.get': 'access',
  'secrets.unlocked': 'unlock',
  'secrets.create': 'create',
  'secrets.import': 'import',
  'secrets.export': 'export',
  'secrets.view': 'view',
  'secrets.lease-denied': 'access',
  'secrets.lease-expire': 'access',
};

export interface SecretAuditParams {
  /** Which audit event this is — a read (`secrets.get`) or an unlock grant. */
  event: SecretAuditEvent;
  /** Bundle name (never a value). */
  bundle?: string;
  /** Raw keychain item/service name for `secrets get <item>` (never a value). */
  item?: string;
  /** Free-form operation/caller label, e.g. 'export to shell', 'unlock'. */
  operation?: string;
  /**
   * Where the read/grant originated: agent | session | reveal | raw-item |
   * remote | sync-push | broker | broker+durable.
   */
  source?: string;
  status?: 'success' | 'error';
  /** Env/key NAMES exposed — names only, never values. */
  keys?: string[];
  keyCount?: number;
  /** Subset of `keys` backed by the OS keychain — names only. */
  keychainKeys?: string[];
  /** Count of resolved values by kind (literal / keychain / env / ...). */
  kindCounts?: Record<string, number>;
  /**
   * Resolving agent/harness identity the access was scoped to (`*` = a global
   * grant readable by every harness). Falls back to `$AGENTS_AGENT_NAME`.
   */
  agent?: string;
  /** Remote host the value was pulled from, when applicable. */
  host?: string;
  /** Grant lifetime in ms (`secrets.unlocked` only). */
  ttlMs?: number;
  error?: string;
}

/**
 * The agent/harness identity to attribute a secret access to. Explicit callers
 * (the bundle reader knows the scope it resolved under) win; otherwise fall back
 * to the ambient `$AGENTS_AGENT_NAME` set on every agent launch.
 */
export function resolveAuditAgent(explicit?: string): string | undefined {
  const a = explicit || process.env.AGENTS_AGENT_NAME;
  return a && a.length > 0 ? a : undefined;
}

/**
 * Emit one value-free secret audit event to the raw/operational event stream and
 * the persisted audit log. Only ever pass metadata — the secret value must never
 * reach this function.
 */
export function emitSecretAudit(p: SecretAuditParams): void {
  const agent = resolveAuditAgent(p.agent);
  emit(p.event, {
    module: 'secrets',
    ...(p.bundle !== undefined ? { bundle: p.bundle } : {}),
    ...(p.item !== undefined ? { item: p.item } : {}),
    ...(p.operation !== undefined ? { operation: p.operation } : {}),
    ...(p.source !== undefined ? { source: p.source } : {}),
    ...(p.status !== undefined ? { status: p.status } : {}),
    ...(p.keys !== undefined ? { keys: p.keys } : {}),
    ...(p.keyCount !== undefined ? { keyCount: p.keyCount } : {}),
    ...(p.keychainKeys !== undefined ? { keychainKeys: p.keychainKeys } : {}),
    ...(p.kindCounts !== undefined ? { kindCounts: p.kindCounts } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(p.host !== undefined ? { host: p.host } : {}),
    ...(p.ttlMs !== undefined ? { ttlMs: p.ttlMs } : {}),
    ...(p.error !== undefined ? { error: p.error } : {}),
  });

  // Mirror the event into the per-bundle usage read-model so `secrets view` /
  // `list` / `activity` can report frequency and recency without scanning the
  // whole event stream. Fed off THIS chokepoint alongside the events.jsonl
  // write, never a second write path. Per-bundle only — a raw `secrets get
  // <item>` has no bundle, so it stays in the events.jsonl audit but is not
  // counted as bundle usage. Best-effort inside usage-db (swallows errors).
  if (p.bundle) {
    recordSecretUsage({
      bundle: p.bundle,
      event: USAGE_KIND[p.event],
      agent,
      host: p.host,
      source: p.source,
      status: p.status,
      keyCount: p.keyCount,
    });
  }
}
