/**
 * Read-only state assembly for `agents serve`.
 *
 * Reuses the SAME structured data the CLI already emits — no recomputation:
 *  - teams: {@link handleTasks} + {@link handleStatus} + {@link toTaskStatusSummary}
 *    (the shape behind `agents teams status --json`), plus a per-worktree
 *    `git diff` via {@link gitDiff}.
 *  - routines: {@link listJobs} (the shape behind `agents routines list --json`).
 *  - cloud: {@link listTasks} from the local SQLite store (behind `agents cloud list --json`).
 *
 * Every panel is assembled independently: if one subsystem throws (e.g. the
 * SQLite cloud store isn't provisioned on this box), that panel reports an
 * `error` string and the others still render. This is an aggregator dashboard,
 * not a fallback that hides a bug in a single code path.
 */
import { AgentManager } from '../teams/agents.js';
import type { AgentProcess } from '../teams/agents.js';
import { handleTasks, handleStatus, toTaskStatusSummary } from '../teams/api.js';
import type { AgentStatusSummary } from '../teams/api.js';
import { gitDiff } from '../teams/worktree.js';
import { listJobs } from '../routines.js';
import type { JobConfig } from '../routines.js';
import { listTasks as listCloudTasks } from '../cloud/store.js';
import type { CloudTask } from '../cloud/types.js';

/** One teammate's worktree and its current uncommitted diff. */
export interface WorktreeDiff {
  agent_id: string;
  name: string | null;
  agent_type: string;
  status: string;
  worktree_name: string | null;
  worktree_path: string | null;
  pr_url: string | null;
  /** Uncommitted `git diff HEAD` for the worktree, capped. '' when clean/absent. */
  diff: string;
}

/** One team: its per-teammate status summary plus per-worktree diffs. */
export interface TeamPanel {
  task_name: string;
  agent_count: number;
  running: number;
  completed: number;
  failed: number;
  agents: AgentStatusSummary[];
  worktrees: WorktreeDiff[];
}

/** A panel that either carries data or an error string (never both). */
export type PanelResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** The full read-only snapshot streamed to the browser. */
export interface ServeState {
  generated_at: string;
  teams: PanelResult<TeamPanel[]>;
  routines: PanelResult<JobConfig[]>;
  cloud: PanelResult<CloudTask[]>;
}

/** Shape of the teammate fields needed to build a worktree diff. */
export interface WorktreeAgentLike {
  agentId: string;
  name: string | null;
  agentType: string;
  status: string;
  worktreeName: string | null;
  worktreePath: string | null;
  prUrl: string | null;
}

/**
 * Build the per-worktree diffs for a set of teammates. Only teammates with a
 * `worktreePath` produce a diff; each gets a real `git diff HEAD` via
 * {@link gitDiff}. Pure over its inputs (no manager, no globals) so it can be
 * unit-tested against a real temp git worktree.
 */
export async function buildWorktreeDiffs(agents: WorktreeAgentLike[]): Promise<WorktreeDiff[]> {
  const withTree = agents.filter((a) => !!a.worktreePath);
  return Promise.all(
    withTree.map(async (a) => ({
      agent_id: a.agentId,
      name: a.name,
      agent_type: a.agentType,
      status: a.status,
      worktree_name: a.worktreeName,
      worktree_path: a.worktreePath,
      pr_url: a.prUrl,
      diff: await gitDiff(a.worktreePath as string),
    })),
  );
}

/** Assemble the teams panel: overview counts, status summaries, worktree diffs. */
async function assembleTeams(manager: AgentManager): Promise<TeamPanel[]> {
  const { tasks } = await handleTasks(manager, 1000);
  const panels: TeamPanel[] = [];
  for (const t of tasks) {
    const status = toTaskStatusSummary(await handleStatus(manager, t.task_name, 'all'));
    const teamAgents = await manager.listByTask(t.task_name);
    const worktrees = await buildWorktreeDiffs(
      teamAgents.map((a: AgentProcess) => ({
        agentId: a.agentId,
        name: a.name,
        agentType: a.agentType,
        status: a.status,
        worktreeName: a.worktreeName,
        worktreePath: a.worktreePath,
        prUrl: a.prUrl,
      })),
    );
    panels.push({
      task_name: t.task_name,
      agent_count: t.agent_count,
      running: t.running,
      completed: t.completed,
      failed: t.failed,
      agents: status.agents,
      worktrees,
    });
  }
  return panels;
}

/**
 * Assemble the full read-only snapshot. Each panel degrades independently to an
 * `error` string so one unavailable subsystem never blanks the whole dashboard.
 *
 * @param cwd - Project root used for project-scoped routine discovery.
 * @param manager - Injectable for tests; defaults to a fresh {@link AgentManager}.
 */
export async function assembleState(
  cwd: string = process.cwd(),
  manager: AgentManager = new AgentManager(),
): Promise<ServeState> {
  const [teams, routines, cloud] = await Promise.all([
    assembleTeams(manager).then(
      (data): PanelResult<TeamPanel[]> => ({ ok: true, data }),
      (err): PanelResult<TeamPanel[]> => ({ ok: false, error: String(err?.message ?? err) }),
    ),
    Promise.resolve()
      .then(() => listJobs(cwd))
      .then(
        (data): PanelResult<JobConfig[]> => ({ ok: true, data }),
        (err): PanelResult<JobConfig[]> => ({ ok: false, error: String(err?.message ?? err) }),
      ),
    Promise.resolve()
      .then(() => listCloudTasks({ limit: 50 }))
      .then(
        (data): PanelResult<CloudTask[]> => ({ ok: true, data }),
        (err): PanelResult<CloudTask[]> => ({ ok: false, error: String(err?.message ?? err) }),
      ),
  ]);

  return {
    generated_at: new Date().toISOString(),
    teams,
    routines,
    cloud,
  };
}
