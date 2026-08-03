// Fork lineage — which session was forked from which, and onto which machine.
//
// A fork launches a brand-new session that shares no id with its parent, so once
// both have ended the ledger shows two unrelated rows. This records the edge at
// launch time (the only moment both ids and both machines are known) so the
// Recap ledger can pair them back up side by side.

export interface ForkEdge {
  /** Session whose transcript the fork continued from. */
  sourceSessionId: string;
  /** Machine the source transcript lives on (fleet name). */
  sourceHost: string;
  /** Session id minted for the fork. Null for a harness that discovers its id post-spawn. */
  forkSessionId: string | null;
  /** Machine the fork runs on (fleet name). */
  forkHost: string;
  agentKey: string;
  forkedAt: number;
}

export const FORK_LINEAGE_KEY = 'agents.forkLineage.v1';

/** Ledger depth is the last ~20 sessions per machine, so a deeper history of
 *  edges can never be rendered. Keep enough to cover a heavy day and drop the rest. */
export const FORK_LINEAGE_MAX = 60;

/**
 * Prepend an edge, newest first, capped. An edge is identified by its fork
 * session: re-recording the same fork (a relaunch that re-mints the same id)
 * replaces the old row instead of stacking a duplicate. An edge with no fork id
 * yet is kept — it is still the honest record that a fork happened — and is
 * simply unpairable until the harness reports the id.
 */
export function recordForkEdge(
  edges: readonly ForkEdge[],
  edge: ForkEdge,
  max = FORK_LINEAGE_MAX,
): ForkEdge[] {
  const rest = edge.forkSessionId
    ? edges.filter((e) => e.forkSessionId !== edge.forkSessionId)
    : [...edges];
  return [edge, ...rest].slice(0, max);
}

/** Index by fork session id — the key the ledger joins on. Idless edges drop out. */
export function forkEdgesBySessionId(edges: readonly ForkEdge[]): Map<string, ForkEdge> {
  const byId = new Map<string, ForkEdge>();
  for (const e of edges) {
    if (e.forkSessionId && !byId.has(e.forkSessionId)) byId.set(e.forkSessionId, e);
  }
  return byId;
}
