/**
 * Auto-dispatch — pull side of the factory dispatch loop.
 *
 * Polls Linear for issues that are delegated to an agent and still in Todo for a
 * managed project, and — up to a per-project concurrency cap — DISPATCHES each
 * through agents-cli's own cloud-provider abstraction (`resolveProvider().dispatch()`),
 * then marks the ticket Doing so it isn't picked up twice.
 *
 * The dispatch goes through the same provider layer as `agents cloud run`, so Rush
 * (Prix) is just one provider among rush/codex/factory — NOT a hidden requirement.
 * A project may pin its provider via `provider` in ~/.agents/factory/projects.json.
 *
 * OPT-IN: a project auto-dispatches ONLY when `autoDispatch: true` AND `maxAgents > 0`.
 * Nothing global is on by default.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

/** The subset of a managed project this module needs (mirror of the shared JSON). */
export interface AutoDispatchProject {
  id: string;
  name: string;
  linearProjectId?: string;
  repoSlug?: string; // "owner/repo" — the dispatch's target repo
  autoDispatch?: boolean; // opt-in; default (undefined) = off
  maxAgents?: number; // per-project concurrency cap; <=0 or undefined = off
  provider?: string; // optional pin: 'rush' | 'codex' | 'factory' | ... (else the agent's native cloud)
}

/** A Linear issue that is a candidate for dispatch. */
export interface DelegatedIssue {
  id: string;
  identifier: string;
  title: string;
  delegateName: string; // e.g. "Claude", "Codex" — the agent to run
  priority: number; // Linear priority (1=urgent … 4=low, 0=none)
}

/** One planned dispatch: which issue, to which agent, in which project. */
export interface PlannedDispatch {
  projectId: string;
  repoSlug?: string;
  provider?: string;
  issueId: string;
  identifier: string;
  title: string;
  delegateName: string;
}

/** Path to the shared factory project registry (written by the factory UI). */
export function factoryProjectsPath(): string {
  return path.join(homedir(), '.agents', 'factory', 'projects.json');
}

/** Read the project registry rows this module cares about. */
export function readAutoDispatchProjects(): AutoDispatchProject[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(factoryProjectsPath(), 'utf-8'));
  } catch {
    return [];
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
      provider: typeof o.provider === 'string' ? o.provider : undefined,
    });
  }
  return out;
}

/** A project is eligible only when it has explicitly opted in with a positive cap. */
export function isEligible(p: AutoDispatchProject): boolean {
  return p.autoDispatch === true && typeof p.maxAgents === 'number' && p.maxAgents > 0 && !!p.linearProjectId;
}

/**
 * PURE planner. Given eligible projects, in-flight counts, and delegated-Todo
 * issues per project, decide which issues to dispatch — never exceeding
 * `maxAgents` in-flight. Highest Linear priority first.
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
    const slots = cap - (inFlightByProject[p.id] ?? 0);
    if (slots <= 0) continue;
    const candidates = (delegatedTodoByProject[p.id] ?? [])
      .slice()
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
    for (const issue of candidates.slice(0, slots)) {
      plan.push({
        projectId: p.id,
        repoSlug: p.repoSlug,
        provider: p.provider,
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        delegateName: issue.delegateName,
      });
    }
  }
  return plan;
}

/** Map Linear priority to a sortable rank (urgent first, none last). */
export function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

/** Build the prompt an auto-dispatched agent receives for a ticket. */
export function dispatchPrompt(identifier: string, title: string): string {
  return `Work on Linear ticket ${identifier}: ${title}. Read the ticket for full context, implement it, and open a PR when done.`;
}

/** Linear I/O surface — discovery + bookkeeping (NOT the dispatch trigger). */
export interface LinearGateway {
  /** Count issues in a started ("Doing") state whose delegate is set, per project. */
  countInFlight(linearProjectId: string): Promise<number>;
  /** Fetch delegated issues in an unstarted ("Todo") state for a project. */
  fetchDelegatedTodo(linearProjectId: string): Promise<DelegatedIssue[]>;
  /** After a successful dispatch: move the issue Todo -> Doing so it isn't re-picked. */
  markStarted(issueId: string, delegateName: string): Promise<void>;
}

/** Dispatch surface — runs a ticket through agents-cli's cloud/local provider layer. */
export interface Dispatcher {
  dispatch(opts: { agent: string; prompt: string; repo?: string; provider?: string }): Promise<{ id: string }>;
}

export interface AutoDispatchDeps {
  projects: AutoDispatchProject[];
  linear: LinearGateway;
  dispatcher: Dispatcher;
  log?: (level: 'INFO' | 'WARN' | 'ERROR', msg: string) => void;
}

/** One tick: read state per eligible project, plan, dispatch, then mark started. */
export async function autoDispatchTick(deps: AutoDispatchDeps): Promise<PlannedDispatch[]> {
  const log = deps.log ?? (() => {});
  const eligible = deps.projects.filter(isEligible);
  if (eligible.length === 0) return [];

  const inFlight: Record<string, number> = {};
  const todo: Record<string, DelegatedIssue[]> = {};
  for (const p of eligible) {
    const pid = p.linearProjectId as string;
    try {
      inFlight[p.id] = await deps.linear.countInFlight(pid);
      todo[p.id] = await deps.linear.fetchDelegatedTodo(pid);
    } catch (err) {
      log('WARN', `auto-dispatch: failed to read Linear state for '${p.name}': ${(err as Error).message}`);
      inFlight[p.id] = Number.MAX_SAFE_INTEGER; // fail closed for this project
      todo[p.id] = [];
    }
  }

  const plan = planAutoDispatch(eligible, inFlight, todo);
  const dispatched: PlannedDispatch[] = [];
  for (const d of plan) {
    try {
      const task = await deps.dispatcher.dispatch({
        agent: d.delegateName.trim().toLowerCase(),
        prompt: dispatchPrompt(d.identifier, d.title),
        repo: d.repoSlug,
        provider: d.provider,
      });
      // Bookkeeping only — dispatch already happened; moving to Doing keeps the
      // ticket out of the next Todo poll. A failure here is non-fatal.
      try {
        await deps.linear.markStarted(d.issueId, d.delegateName);
      } catch (err) {
        log('WARN', `auto-dispatch: dispatched ${d.identifier} but failed to mark Doing: ${(err as Error).message}`);
      }
      dispatched.push(d);
      log('INFO', `auto-dispatch: dispatched ${d.identifier} to ${d.delegateName} (task ${task.id})`);
    } catch (err) {
      log('WARN', `auto-dispatch: failed to dispatch ${d.identifier}: ${(err as Error).message}`);
    }
  }
  return dispatched;
}
