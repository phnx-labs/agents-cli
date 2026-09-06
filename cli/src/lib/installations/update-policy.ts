/**
 * Settings that gate the AUTOMATIC update pass (PHNX-3940): whether it runs at
 * all (global + per-harness), and whether one installation participates.
 *
 * Two independent axes, deliberately kept apart:
 *   - `updates.auto` / `updates.<agent>.auto` — an OPERATOR switch, global and
 *     per-harness, stored centrally (`~/.agents/agents.yaml` `config:`) so it
 *     syncs fleet-wide like `summarizer.*`. Both are registered as ordinary
 *     TYPED entries in `device-config.ts`'s `CONFIG_KEYS` — the one canonical
 *     store for user-scope config — rather than a second untyped read/write
 *     path against `Meta.config` directly, so a config rewrite that only knows
 *     about the registry (validation, `agents config list`, the fleet sync
 *     that round-trips `config:`) can't silently drop these keys.
 *   - `Installation.updatePolicy` — an INSTALLATION property. Manual
 *     `agents update <agent>@<label> --to <concrete>` pins it; `--to latest`
 *     (or a fresh install) leaves/returns it to `'latest'`.
 *
 * The global switch is a HARD KILL SWITCH, not a default an explicit
 * per-harness `true` can override: `updates.auto=false` must stop every
 * harness's automatic pass even when an operator separately turned one
 * harness's switch on, because the global switch is the "something is
 * wrong, stop touching installations fleet-wide" lever and a forgotten
 * per-harness override must never defeat it. See
 * {@link isAutoUpdateEnabledForAgent}.
 */

import { getConfigValue, setConfigValue, unsetConfigValue } from '../device-config.js';
import { withFileLockAsync } from '../fs-atomic.js';
import type { AgentId } from '../types.js';
import { ensureInstallation, installationRecordPath, readInstallation, writeInstallation } from './store.js';
import { INSTALLATION_LOCK_OPTIONS } from './installation-lock.js';
import type { Installation, UpdatePolicy } from './types.js';

function agentAutoKey(agent: AgentId): string {
  return `updates.${agent}.auto`;
}

/** The raw, explicitly-set global switch, or `undefined` when never set (default: on). */
export function rawGlobalAutoUpdateSetting(): boolean | undefined {
  return getConfigValue('updates.auto').value as boolean | undefined;
}

export function setGlobalAutoUpdateEnabled(enabled: boolean): void {
  setConfigValue('updates.auto', enabled);
}

export function unsetGlobalAutoUpdateEnabled(): void {
  unsetConfigValue('updates.auto');
}

/** True unless the operator explicitly turned automatic updates off globally. */
export function isGlobalAutoUpdateEnabled(): boolean {
  return rawGlobalAutoUpdateSetting() !== false;
}

/** The raw, explicitly-set per-harness switch, or `undefined` when it defers to the global one. */
export function rawAgentAutoUpdateSetting(agent: AgentId): boolean | undefined {
  return getConfigValue(agentAutoKey(agent)).value as boolean | undefined;
}

export function setAgentAutoUpdateEnabled(agent: AgentId, enabled: boolean): void {
  setConfigValue(agentAutoKey(agent), enabled);
}

export function unsetAgentAutoUpdateEnabled(agent: AgentId): void {
  unsetConfigValue(agentAutoKey(agent));
}

/**
 * Whether the automatic-update pass may consider this agent at all.
 *
 * `updates.auto=false` is a hard kill switch: it wins even over an explicit
 * `updates.<agent>.auto=true` (see the module docblock). With the global
 * switch on (the default), the per-harness switch refines it when explicitly
 * set, else the harness is enabled too.
 */
export function isAutoUpdateEnabledForAgent(agent: AgentId): boolean {
  if (!isGlobalAutoUpdateEnabled()) return false;
  const perAgent = rawAgentAutoUpdateSetting(agent);
  return perAgent !== false;
}

/**
 * The effective policy for one installation. Absent (legacy data, or a fresh
 * install that never set it) means `'latest'` — see {@link Installation.updatePolicy}.
 * Read through this everywhere rather than comparing the field directly.
 */
export function effectiveUpdatePolicy(installation: Pick<Installation, 'updatePolicy'>): UpdatePolicy {
  return installation.updatePolicy ?? 'latest';
}

/**
 * Persist an installation's update policy. Takes the SAME per-installation
 * lock `updateInstallation` (`update.ts`) holds for its whole transaction —
 * without it, a manual `--to <release>`/`--to latest` pin racing an automatic
 * pass's own `recordRelease` write (both a read-modify-write of the same
 * `installation.json`) could lose whichever wrote second, silently reverting
 * a just-applied pin or an update's own release bump. Reloads the record
 * fresh from disk under the lock (never trusts a possibly-stale in-memory
 * copy) and writes back only the policy field — never touches
 * `history`/`releaseVersion`, since pinning or unpinning is not a release
 * change. Locks with the SAME `staleMs`/`acquireTimeoutMs`
 * ({@link INSTALLATION_LOCK_OPTIONS}) as that transaction — the fs-atomic
 * default (5s stale) is far shorter than an update can legitimately run, so
 * using it here would let this write break the transaction's
 * still-legitimately-held lock out from under it.
 */
export async function setInstallationUpdatePolicy(agent: AgentId, label: string, policy: UpdatePolicy): Promise<Installation> {
  // Guarantees `installation.json` exists and is VALID before locking on it,
  // migrating a legacy pre-frozen version dir when needed — same reasoning as
  // `launch-gate.ts`'s identical call. Throws its own clear
  // "no installation directory" error when `label` was never installed at
  // all, which is a real caller bug, not a race to reconcile under the lock.
  ensureInstallation(agent, label);
  const recordPath = installationRecordPath(agent, label);
  return withFileLockAsync(recordPath, () => {
    const current = readInstallation(agent, label);
    if (!current) {
      throw new Error(`No installation record for ${agent}@${label} — cannot set its update policy.`);
    }
    const next: Installation = { ...current, updatePolicy: policy, updatedAt: new Date().toISOString() };
    writeInstallation(next);
    return next;
  }, INSTALLATION_LOCK_OPTIONS);
}
