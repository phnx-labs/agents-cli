/**
 * Project-level progress rollup — the headline of the projects subsystem.
 *
 * At 50–100 agents the per-agent activity line is noise; what matters is the
 * PROJECT. This aggregates the signals already carried per session (status,
 * plan progress, open PRs, tickets, worktrees) into one row per project, keyed
 * by matching each session's cwd to a defined project root (`projectNameForCwd`).
 * The session set is whatever the caller passes (today `getActiveSessions()` —
 * this machine's live view, matched by local-home cwd; a fleet-wide fan-out is a
 * deferred follow-up). Pure over an `ActiveSession[]` so the aggregation is
 * unit-testable; the merged-PR signal IS repo-global (harvested via `gh`) and the
 * artifact signal is local, both added in `enrichProjectSignals`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import type { ActiveSession, ActiveStatus } from './session/active.js';
import { projectNameForCwd, type ProjectDef } from './projects.js';
import { readRecentActivity } from './activity.js';

const execFileAsync = promisify(execFile);

/** One live agent on a project — the WHO behind the byStatus count. */
export interface ProjectMember {
  /** Harness name (claude / codex / …), from the session's `kind`. */
  agent: string;
  /** Lifecycle status (running / idle / …). */
  status: string;
  /** Tracker ticket the session is tied to, when any. */
  ticket?: string;
  /** Machine the session runs on (provenance host / fleet peer), when known. */
  host?: string;
}

/** One project's live session rollup. */
export interface ProjectSessionRollup {
  name: string;
  /** Total sessions whose cwd is inside this project. */
  agents: number;
  /** Count per lifecycle status. */
  byStatus: Partial<Record<ActiveStatus, number>>;
  /** Which agents are on the project (one per matched session). */
  members: ProjectMember[];
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
  return {
    name,
    agents: 0,
    byStatus: {},
    members: [],
    plan: { done: 0, total: 0 },
    openPrs: [],
    tickets: [],
    worktrees: 0,
  };
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
    const member: ProjectMember = { agent: s.kind, status: s.status };
    if (s.ticket?.id) member.ticket = s.ticket.id;
    if (s.machine) member.host = s.machine;
    r.members.push(member);
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

/**
 * Display order for the members line: the states a human scans for first
 * (running, then idle, then need-input, then queued), everything else after,
 * status name then agent name ascending within a state.
 */
const MEMBER_STATUS_RANK: Record<string, number> = { running: 0, idle: 1, input_required: 2, queued: 3 };

/** Sort members for the card: running first, then idle, then the rest; agent name asc within a state. */
export function sortProjectMembers(members: ProjectMember[]): ProjectMember[] {
  return [...members].sort((a, b) => {
    const ra = MEMBER_STATUS_RANK[a.status] ?? 4;
    const rb = MEMBER_STATUS_RANK[b.status] ?? 4;
    if (ra !== rb) return ra - rb;
    if (ra === 4 && a.status !== b.status) return a.status.localeCompare(b.status);
    return a.agent.localeCompare(b.agent);
  });
}

/** Cap for the members line before it collapses to `+N more`. */
export const MEMBERS_LINE_LIMIT = 6;

/**
 * The `agents` line under `live`: one cell per DISTINCT member state —
 * `claude · running · RUSH-2107 @zion` — with identical cells collapsed to a
 * `×N` count (35 same-harness sessions in one state are one fact, not six
 * truncated duplicates), capped at {@link MEMBERS_LINE_LIMIT} cells with a
 * `+N more` tail counting members, not cells. Pure (chalk styling only); the
 * caller adds the label.
 */
export function formatProjectMembers(members: ProjectMember[], limit = MEMBERS_LINE_LIMIT): string {
  if (members.length === 0) return '';
  // Collapse identical cells — 35 same-harness sessions in the same state are
  // one fact (`claude · running ×16`), not six truncated duplicates.
  const counts = new Map<string, { cell: string; n: number }>();
  for (const m of sortProjectMembers(members)) {
    const parts = [m.agent, m.status];
    if (m.ticket) parts.push(m.ticket);
    const cell = parts.join(' · ') + (m.host ? ` @${m.host}` : '');
    const key = cell.toLowerCase();
    const entry = counts.get(key);
    if (entry) entry.n++;
    else counts.set(key, { cell, n: 1 });
  }
  const entries = [...counts.values()];
  const shown = entries.slice(0, Math.max(1, limit));
  const shownMembers = shown.reduce((acc, e) => acc + e.n, 0);
  const more = members.length - shownMembers;
  const cells = shown.map(({ cell, n }) => (n > 1 ? `${cell} ×${n}` : cell));
  return cells.join(chalk.dim('  ·  ')) + (more > 0 ? chalk.dim(`  ·  +${more} more`) : '');
}

/** Harvested signals not on the session list: repo-global merged PRs + releases, local artifacts, in a time window. */
export interface ProjectRemoteSignals {
  windowDays: number;
  /** PRs merged into the primary repo within the window (via `gh`). */
  mergedPrs: number;
  /** Artifacts agents produced within the window (activity.created milestones). */
  artifacts: number;
  /** Basename of the most recent artifact, when any. */
  lastArtifact?: string;
  /** Latest release of the PRIMARY repo (via `gh release list`), when any. */
  latestRelease?: { tag: string; publishedAt: string };
}

/**
 * Harvest the signals that don't live on the active-session list: recently
 * merged PRs (from GitHub via `gh`) and artifacts agents produced (from the
 * local activity-milestone log, matched to the project by cwd). Best-effort —
 * a missing `gh`, no auth, or no repo degrades to zero rather than throwing, so
 * `projects status` still renders. `nowMs` is injected for testability.
 */
export async function enrichProjectSignals(
  def: ProjectDef,
  windowDays: number,
  nowMs: number,
  opts: { activityRoot?: string; skipRemote?: boolean } = {},
): Promise<ProjectRemoteSignals> {
  const sinceMs = nowMs - windowDays * 86_400_000;
  const out: ProjectRemoteSignals = { windowDays, mergedPrs: 0, artifacts: 0 };

  try {
    const evs = readRecentActivity({ events: ['artifact.created'], sinceMs, root: opts.activityRoot });
    const mine = evs.filter((e) => projectNameForCwd(e.cwd, [def]) === def.name);
    out.artifacts = mine.length;
    if (mine.length && typeof mine[0].detail === 'string') out.lastArtifact = mine[0].detail;
  } catch {
    /* activity log unreadable — best-effort */
  }

  if (def.repo && !opts.skipRemote) {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'list', '--repo', def.repo, '--state', 'merged', '--json', 'number,mergedAt', '--limit', '100'],
        { timeout: 8000, encoding: 'utf8' },
      );
      const rows = JSON.parse(stdout) as { mergedAt?: string }[];
      out.mergedPrs = rows.filter((r) => r.mergedAt && Date.parse(r.mergedAt) >= sinceMs).length;
    } catch {
      /* gh missing / unauthenticated / repo not found — skip this signal */
    }
    // Latest release of the PRIMARY repo only (repos[] is deliberately not
    // scanned — one release line per card). Same best-effort degradation.
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['release', 'list', '-R', def.repo, '-L', '1', '--json', 'tagName,publishedAt'],
        { timeout: 8000, encoding: 'utf8' },
      );
      const rows = JSON.parse(stdout) as { tagName?: string; publishedAt?: string }[];
      const first = rows[0];
      if (first?.tagName) out.latestRelease = { tag: first.tagName, publishedAt: first.publishedAt ?? '' };
    } catch {
      /* gh missing / unauthenticated / repo has no releases — skip this signal */
    }
  }
  return out;
}
