/**
 * Teammate *delivery* vs process *lifecycle* (RUSH-2380).
 *
 * `AgentStatus.COMPLETED` means the process exited 0 — not that the PR merged.
 * Orchestrators that treat COMPLETED as "work landed on main" compose on top of
 * unmerged PRs. This module derives a delivery signal from process status +
 * whether a PR URL is still open, so `teams status` can surface `PR OPEN`
 * instead of bare COMPLETED.
 *
 * Process status still drives the DAG (`--after` deps): a finished process
 * unblocks dependents. Delivery is the postcondition for "done end-to-end".
 */

import { AgentStatus } from './agents.js';

/** Postcondition-facing delivery of a teammate's work. */
export type TeammateDelivery =
  | 'pending'
  | 'in_progress'
  | 'pr_open'
  | 'pr_merged'
  | 'no_pr'
  | 'failed'
  | 'stopped';

/**
 * Derive delivery from process status and PR state.
 *
 * When the process completed with a `prUrl` and merge is unknown or false,
 * delivery is `pr_open` — pessimistic: assume open until proven merged so an
 * orchestrator never mistakes "agent stopped" for "work on main".
 */
export function resolveTeammateDelivery(opts: {
  status: AgentStatus | string;
  prUrl?: string | null;
  /**
   * When known from a probe or meta: true = merged, false = still open.
   * `null`/`undefined` = unknown; with a `prUrl` that means `pr_open`.
   */
  prMerged?: boolean | null;
}): TeammateDelivery {
  const status = String(opts.status);
  if (status === AgentStatus.PENDING || status === 'pending') return 'pending';
  if (status === AgentStatus.RUNNING || status === 'running') return 'in_progress';
  if (status === AgentStatus.FAILED || status === 'failed') return 'failed';
  if (status === AgentStatus.STOPPED || status === 'stopped') return 'stopped';

  if (status === AgentStatus.COMPLETED || status === 'completed') {
    const prUrl = opts.prUrl?.trim();
    if (!prUrl) return 'no_pr';
    if (opts.prMerged === true) return 'pr_merged';
    return 'pr_open';
  }

  return 'in_progress';
}

/**
 * Human label for `teams status` rows. Replaces bare COMPLETED with PR OPEN
 * when delivery is still pending merge.
 */
export function deliveryDisplayLabel(
  delivery: TeammateDelivery,
  processStatus: AgentStatus | string,
): string {
  if (delivery === 'pr_open') return 'PR OPEN';
  if (delivery === 'pr_merged') return 'COMPLETED';
  return String(processStatus).toUpperCase();
}

/**
 * Color key for statusColor-style switches. `pr_open` is its own key so the
 * row is visually distinct from green COMPLETED.
 */
export function deliveryColorKey(delivery: TeammateDelivery, processStatus: string): string {
  if (delivery === 'pr_open') return 'pr_open';
  return String(processStatus);
}
