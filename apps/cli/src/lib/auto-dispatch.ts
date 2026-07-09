/**
 * Auto-dispatch — pull side of the factory dispatch loop.
 *
 * The run pipeline already exists: a Linear webhook fires when an issue moves to
 * Doing, and the factory spawns an agent on it. What was missing is the *pull*:
 * nothing picked up tickets that were delegated to an agent but left in Todo.
 *
 * This module polls Linear for issues delegated to an agent in a managed project
 * and, up to a per-project concurrency cap, moves them Todo -> Doing (which the
 * existing webhook turns into a real run). It reads the shared factory project
 * registry at ~/.agents/factory/projects.json — the CLI cannot import the factory
 * package (no cross-package imports), so it reads the JSON directly.
 *
 * OPT-IN: a project auto-dispatches ONLY when it has `autoDispatch: true` AND
 * `maxAgents > 0`. With no project opted in, the tick is a no-op. There is no
 * global default-on switch.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

/** The subset of a managed project this module needs (mirror of the shared JSON). */
export interface AutoDispatchProject {
  id: string;
  name: string;
  linearProjectId?: string;
  repoSlug?: string; // "owner/repo" — passed through so the run knows its repo
  autoDispatch?: boolean; // opt-in; default (undefined) = off
  maxAgents?: number; // per-project concurrency cap; <=0 or undefined = off
}

/** A Linear issue that is a candidate for dispatch. */
export interface DelegatedIssue {
  id: string;
  identifier: string;
  delegateName: string; // e.g. "Claude", "Codex" — the agent to run
  priority: number; // Linear priority (1=urgent … 4=low, 0=none)
}

/** One planned dispatch: which issue, to which agent, in which project. */
export interface PlannedDispatch {
  projectId: string;
  repoSlug?: string;
  issueId: string;
  identifier: string;
  delegateName: string;
}

/** Path to the shared factory project registry (written by the factory UI). */
export function factoryProjectsPath(): string {
  return path.join(homedir(), '.agents', 'factory', 'projects.json');
}

/** Read the project registry, keeping only rows that have opted into auto-dispatch. */
export function readAutoDispatchProjects(): AutoDispatchProject[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(factoryProjectsPath(), 'utf-8'));
  } catch {
    return []; // no registry yet, or unreadable — nothing to dispatch
  }
  if (!Array.isArray(raw)) return [];
  const out: AutoDispatchProject[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.name !== 'string') continue;
    out.push({
      id: o.id,
      name: o.name,
      linearProjectId: typeof o.linearProjectId === 'string' ? o.linearProjectId : undefined,
      repoSlug: typeof o.repoSlug === 'string' ? o.repoSlug : undefined,
      autoDispatch: o.autoDispatch === true,
      maxAgents: typeof o.maxAgents === 'number' ? o.maxAgents : undefined,
    });
  }
  return out;
}

/** A project is eligible only when it has explicitly opted in with a positive cap. */
export function isEligible(p: AutoDispatchProject): boolean {
  return p.autoDispatch === true && typeof p.maxAgents === 'number' && p.maxAgents > 0 && !!p.linearProjectId;
}

/**
 * PURE planner. Given the eligible projects, how many agents are already in flight
 * per project, and the delegated-Todo issues per project, decide exactly which
 * issues to dispatch — never exceeding `maxAgents` in-flight for a project.
 *
 * Highest Linear priority first (urgent=1 < low=4; 0/none sorts last).
 */
export function planAutoDispatch(
  projects: AutoDispatchProject[],
  inFlightByProject: Record<string, number>,
  delegatedTodoByProject: Record<string, DelegatedIssue[]>,
): PlannedDispatch[] {
  const plan: PlannedDispatch[] = [];
  for (const p of projects) {
    if (!isEligible(p)) continue;
    const cap = p.maxAgents as number;
    const inFlight = inFlightByProject[p.id] ?? 0;
    const slots = cap - inFlight;
    if (slots <= 0) continue;
    const candidates = (delegatedTodoByProject[p.id] ?? [])
      .slice()
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
    for (const issue of candidates.slice(0, slots)) {
      plan.push({
        projectId: p.id,
        repoSlug: p.repoSlug,
        issueId: issue.id,
        identifier: issue.identifier,
        delegateName: issue.delegateName,
      });
    }
  }
  return plan;
}

/** Map Linear priority to a sortable rank (urgent first, none last). */
export function priorityRank(priority: number): number {
  // Linear: 1=urgent, 2=high, 3=medium, 4=low, 0=no priority.
  return priority === 0 ? 5 : priority;
}

/** Linear I/O surface — injected so the planner + tick are testable without network. */
export interface LinearGateway {
  /** Count issues in a "started" (Doing) state whose delegate is set, per project id. */
  countInFlight(linearProjectId: string): Promise<number>;
  /** Fetch delegated issues in an "unstarted" (Todo) state for a project. */
  fetchDelegatedTodo(linearProjectId: string): Promise<DelegatedIssue[]>;
  /** Move an issue Todo -> Doing (the existing webhook turns this into a run). */
  startIssue(issueId: string, delegateName: string): Promise<void>;
}

export interface AutoDispatchDeps {
  projects: AutoDispatchProject[];
  linear: LinearGateway;
  log?: (level: 'INFO' | 'WARN' | 'ERROR', msg: string) => void;
}

/** One tick: read state per eligible project, plan, and start the planned issues. */
export async function autoDispatchTick(deps: AutoDispatchDeps): Promise<PlannedDispatch[]> {
  const log = deps.log ?? (() => {});
  const eligible = deps.projects.filter(isEligible);
  if (eligible.length === 0) return []; // opt-in: nothing to do

  const inFlight: Record<string, number> = {};
  const todo: Record<string, DelegatedIssue[]> = {};
  for (const p of eligible) {
    const pid = p.linearProjectId as string;
    try {
      inFlight[p.id] = await deps.linear.countInFlight(pid);
      todo[p.id] = await deps.linear.fetchDelegatedTodo(pid);
    } catch (err) {
      log('WARN', `auto-dispatch: failed to read Linear state for '${p.name}': ${(err as Error).message}`);
      inFlight[p.id] = Number.MAX_SAFE_INTEGER; // fail closed: dispatch nothing for this project
      todo[p.id] = [];
    }
  }

  const plan = planAutoDispatch(eligible, inFlight, todo);
  const dispatched: PlannedDispatch[] = [];
  for (const d of plan) {
    try {
      await deps.linear.startIssue(d.issueId, d.delegateName);
      dispatched.push(d);
      log('INFO', `auto-dispatch: started ${d.identifier} (${d.delegateName}) in ${d.projectId}`);
    } catch (err) {
      log('WARN', `auto-dispatch: failed to start ${d.identifier}: ${(err as Error).message}`);
    }
  }
  return dispatched;
}
