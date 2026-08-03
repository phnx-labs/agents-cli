/**
 * Project-level progress rollup — the headline of the projects subsystem.
 *
 * At 50–100 agents the per-agent activity line is noise; what matters is the
 * PROJECT. This aggregates the signals already carried per session (status,
 * plan progress, open PRs, tickets, worktrees) into one row per project, keyed
 * by matching each session's cwd to a defined project root (`projectNameForCwd`).
 * Pure over an `ActiveSession[]` so the aggregation is unit-testable; the richer
 * async signals (merged PRs via `gh`, Linear ticket counts, produced artifacts)
 * enrich this in `enrichProjectStatus` without changing the core shape.
 */

import type { ActiveSession, ActiveStatus } from './session/active.js';
import { projectNameForCwd, type ProjectDef } from './projects.js';

/** One project's live session rollup. */
export interface ProjectSessionRollup {
  name: string;
  /** Total sessions whose cwd is inside this project. */
  agents: number;
  /** Count per lifecycle status. */
  byStatus: Partial<Record<ActiveStatus, number>>;
  /** Summed checklist progress across this project's sessions. */
  plan: { done: number; total: number };
  /** Distinct open PRs held by this project's sessions. */
  openPrs: { url: string; number?: number }[];
  /** Distinct tickets worked or created by this project's sessions. */
  tickets: string[];
  /** Sessions running inside a worktree. */
  worktrees: number;
}

function blank(name: string): ProjectSessionRollup {
  return { name, agents: 0, byStatus: {}, plan: { done: 0, total: 0 }, openPrs: [], tickets: [], worktrees: 0 };
}

/**
 * Roll active sessions up by project. Returns a map keyed by project name,
 * containing only projects with at least one matched session — callers merge
 * with the full definition list to show zero-agent projects.
 */
export function rollupSessionsByProject(
  defs: ProjectDef[],
  sessions: ActiveSession[],
): Map<string, ProjectSessionRollup> {
  const map = new Map<string, ProjectSessionRollup>();
  const prSeen = new Map<string, Set<string>>();
  const ticketSeen = new Map<string, Set<string>>();

  for (const s of sessions) {
    const name = projectNameForCwd(s.cwd, defs);
    if (!name) continue;
    let r = map.get(name);
    if (!r) {
      r = blank(name);
      map.set(name, r);
      prSeen.set(name, new Set());
      ticketSeen.set(name, new Set());
    }
    r.agents++;
    r.byStatus[s.status] = (r.byStatus[s.status] ?? 0) + 1;
    if (s.todos) {
      r.plan.done += s.todos.done;
      r.plan.total += s.todos.total;
    }
    if (s.pr?.url && !prSeen.get(name)!.has(s.pr.url)) {
      prSeen.get(name)!.add(s.pr.url);
      r.openPrs.push({ url: s.pr.url, number: s.pr.number });
    }
    const tset = ticketSeen.get(name)!;
    for (const t of [s.ticket?.id, ...(s.createdTickets ?? [])]) {
      if (t && !tset.has(t)) {
        tset.add(t);
        r.tickets.push(t);
      }
    }
    if (s.worktree) r.worktrees++;
  }
  return map;
}

/** Plan completion percentage (0–100), or undefined when nothing is tracked. */
export function planPct(plan: { done: number; total: number }): number | undefined {
  if (plan.total <= 0) return undefined;
  return Math.round((plan.done / plan.total) * 100);
}
