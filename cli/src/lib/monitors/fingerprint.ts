/**
 * Semantic identity of a monitor — "are these two definitions the same watcher?"
 *
 * A monitor's NAME is not its identity. Two monitors can poll the same command
 * on the same interval and fire the same action under two different names, and
 * nothing today notices: `writeMonitor` overwrites by name and never compares
 * arguments. Observed on one box: `open-pr-watch`, `pr-ci-fail`, three stale
 * `pr2222-*` watchers, and an agent-added lander, all polling
 * `gh pr list ... phnx-labs/agents-cli` — four overlapping triggers on one PR
 * queue, added without a single warning.
 *
 * That is the double-trigger bug class. The fingerprint is what lets `add`
 * refuse it.
 *
 * WHAT IS HASHED: only fields that change what the monitor DOES — the source it
 * watches, how often, the condition that fires, and the action it takes. Name,
 * description, and `enabled` are deliberately excluded, because a duplicate
 * under a new name is exactly the case being caught, and a paused duplicate is
 * still a duplicate the moment someone resumes it.
 *
 * WHAT IS NOT HASHED: `device`/`devices`/`runOn`. Placement is who executes, not
 * what runs — and two boxes deliberately owning the same watcher is a different
 * decision (see `monitorRunsOnThisDevice`). Including placement would let the
 * same watcher be added N times by varying only the owner, which is the very
 * duplication this guards.
 */

import { createHash } from 'crypto';
import type { MonitorConfig } from './config.js';

/**
 * Stable JSON: object keys sorted, so key order in the YAML cannot change the hash.
 *
 * Cycle-safe by construction. A monitor can arrive from arbitrary YAML
 * (`agents monitors add ./watcher.yml`), and a recursive anchor produces a
 * genuinely cyclic object that `validateMonitor` accepts — it checks named
 * fields, while this walks the whole graph. Without the seen-set the recursion
 * blew the stack before `JSON.stringify` could raise its own circular-structure
 * error, turning a bad input into a stack trace instead of a clear refusal.
 *
 * A `Date` is serialized to its ISO string rather than falling into the object
 * branch, where every Date collapsed to `{}` and two different timestamps
 * fingerprinted identically.
 */
function stable(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value.map((v) => stable(v, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = stable(v, seen);
    }
    return out;
  }
  return value;
}

/**
 * The behavioral identity of a monitor, as a short hex digest. Two monitors with
 * the same fingerprint watch the same thing and do the same thing on fire —
 * whatever they are called and wherever they are pinned.
 *
 * Pure: no I/O, so the duplicate check is unit-tested without a monitors dir.
 */
export function monitorFingerprint(
  config: Pick<MonitorConfig, 'source' | 'condition' | 'action'>,
): string {
  const identity = stable({
    source: config.source,
    condition: config.condition,
    action: config.action,
  });
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
}

/**
 * The already-existing monitor that this config would duplicate, or null.
 *
 * `existing` is the full monitor set (user + system layers), so a user monitor
 * duplicating a shipped built-in is caught too. A monitor never collides with
 * itself: a same-NAME entry is a rewrite of that monitor, which `add` reports
 * separately and more precisely than "duplicate".
 *
 * Pure — the caller supplies the list.
 */
export function findDuplicateMonitor(
  config: Pick<MonitorConfig, 'name' | 'source' | 'condition' | 'action'>,
  existing: Array<Pick<MonitorConfig, 'name' | 'source' | 'condition' | 'action'>>,
): string | null {
  const fp = monitorFingerprint(config);
  for (const other of existing) {
    if (other.name === config.name) continue;
    if (monitorFingerprint(other) === fp) return other.name;
  }
  return null;
}
