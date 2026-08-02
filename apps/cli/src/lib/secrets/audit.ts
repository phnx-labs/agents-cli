/**
 * Canonical audit emitter for `agents secrets` value access and unlock grants.
 *
 * Every path that reads a secret VALUE or grants an unlock funnels its audit
 * through here, so the operational event stream — `agents events`, backed by the
 * append-only `~/.agents/events.jsonl` audit log — carries a uniform, value-free
 * provenance record: bundle, key NAMES, the resolving agent/harness identity,
 * operation, source, status. The ts / host / session / caller fields are filled
 * in by `emit()` itself. The secret VALUE is never part of the payload; this
 * helper only ever receives metadata, and `emit()`'s `sanitizePayload` is a
 * second redaction layer.
 *
 * Two event types, both audit-level and non-milestone (so they surface in
 * `agents events` and the persisted audit trail, but are NOT required in the
 * curated `agents activity` / `agents feed` surfaces):
 *  - `secrets.get`      — a value was READ (exec inject, export, `view --reveal`,
 *                         raw `get <item>`, remote resolve, sync push,
 *                         `run --secrets`, and every other bundle read).
 *  - `secrets.unlocked` — a bundle was GRANTED into the secrets broker / durable
 *                         session by `agents secrets unlock`, then readable
 *                         prompt-free for the grant TTL.
 */
import { emit } from '../events.js';

export type SecretAuditEvent = 'secrets.get' | 'secrets.unlocked';

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
}
