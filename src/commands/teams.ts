/**
 * Team management commands for organizing multi-agent collaboration.
 *
 * Implements `agents teams` -- create named teams, add teammates (background
 * agent processes), check status with session-aware previews, manage DAG
 * dependencies between teammates, and clean up when work is done.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  AgentManager,
  checkAllClis,
  getAgentsDir,
  VALID_TASK_TYPES,
  type AgentType,
  type TaskType,
} from '../lib/teams/agents.js';
import { resolveProvider } from '../lib/cloud/registry.js';
import type { CloudProviderId, DispatchOptions } from '../lib/cloud/types.js';
import { runSupervisor } from '../lib/teams/supervisor.js';
import {
  handleSpawn,
  handleStatus,
  handleStop,
  handleTasks,
  type AgentStatusDetail,
  type TaskInfo,
} from '../lib/teams/api.js';
import {
  createTeam,
  ensureTeam,
  getTeam,
  loadTeams,
  removeTeam,
  teamExists,
} from '../lib/teams/registry.js';
import { setHelpSections } from '../lib/help.js';
import {
  createWorktree,
  isGitRepo,
  hasUncommittedChanges,
  removeWorktree,
} from '../lib/teams/worktree.js';
import { isVersionInstalled, resolveVersionAlias, resolveVersionAliasLoose } from '../lib/versions.js';
import type { AgentId } from '../lib/types.js';
import { discoverSessions, parseTimeFilter, resolveSessionById } from '../lib/session/discover.js';
import type { SessionMeta } from '../lib/session/types.js';
import { buildPreview as buildSessionPreview } from './sessions-picker.js';
import { parseExecEnv } from '../lib/exec.js';
import { teamPicker, printTeamTable, type TeamRow } from './teams-picker.js';
import { itemPicker } from '../lib/picker.js';
import type { AgentProcess } from '../lib/teams/agents.js';
import {
  isPromptCancelled,
  isInteractiveTerminal,
  requireDestructiveArg,
  requireInteractiveSelection,
} from './utils.js';

const AGENT_NAMES: Record<AgentType, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  grok: 'Grok',
};

const VALID_AGENTS = Object.keys(AGENT_NAMES) as AgentType[];
const VALID_MODES = ['plan', 'edit', 'full'] as const;
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;
const VALID_CLOUD_PROVIDERS = ['rush', 'codex', 'factory'] as const satisfies readonly CloudProviderId[];

type Mode = (typeof VALID_MODES)[number];
type Effort = (typeof VALID_EFFORTS)[number];

// Auto-enable JSON mode when piped / not a TTY so AI agent consumers get
// parseable output by default.
function isJsonMode(opts: { json?: boolean }): boolean {
  return Boolean(opts.json) || !process.stdout.isTTY;
}

function die(msg: string, code = 1): never {
  console.error(chalk.red(msg));
  process.exit(code);
}

function statusColor(status: string): (s: string) => string {
  switch (status) {
    case 'pending': return chalk.blue;
    case 'running': return chalk.yellow;
    case 'completed': return chalk.green;
    case 'failed': return chalk.red;
    case 'stopped': return chalk.gray;
    default: return chalk.white;
  }
}

function relTime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function compactPrompt(s: string, n = 160): string {
  return truncate(s.replace(/\s+/g, ' ').trim(), n);
}

function formatTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function fullName(type: AgentType, version: string | null | undefined): string {
  const name = AGENT_NAMES[type];
  return version ? `${name} ${version}` : name;
}

function parseTeammate(spec: string): { agent: AgentType; version: string | null } {
  const [name, version] = spec.split('@');
  if (!VALID_AGENTS.includes(name as AgentType)) {
    die(
      `Unknown teammate '${name}'. Available: ${VALID_AGENTS.join(', ')}.\n` +
        `  Use the form 'claude' or 'claude@2.1.112' (see 'agents view' for installed versions).`
    );
  }
  const agent = name as AgentType;
  return { agent, version: resolveVersionAlias(agent as AgentId, version) ?? null };
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Preamble injected into every factory worker's prompt. Tells the worker
 * which team + teammate name + task-type it is, and how to file new tasks.
 * The actual how-to lives in the /factory-worker skill.
 */
function factoryWorkerPreamble(
  team: string,
  name: string | null,
  taskType: TaskType,
  after: string[]
): string {
  const n = name ?? '<anonymous>';
  const deps = after.length > 0 ? after.join(', ') : '(none)';
  return [
    `FACTORY WORKER — team="${team}", name="${n}", task_type="${taskType}", after=${deps}`,
    `You are a teammate in a Software Factory. Read the /factory-worker skill for the full pattern.`,
    `Key rules:`,
    ` - Other teammates may be running now. Coordinate via git and tests only — no direct peer communication.`,
    ` - If you discover work beyond your task, file a new teammate via Bash:`,
    `     agents teams add "${team}" claude "<ask>" --name <slug> --task-type <implement|test|review|bugfix|docs> [--after <dep>]`,
    `   A background supervisor picks up new tasks every wave.`,
    ``,
    `YOUR TASK:`,
  ].join('\n');
}

function mkManager(): AgentManager {
  return new AgentManager();
}

/**
 * Register the generic cloud dispatcher — staged cloud teammates get
 * dispatched when their --after deps resolve, using repo/branch stored on
 * the teammate itself so we don't need the original --cloud CLI args.
 */
export function wireCloudDispatcher(mgr: AgentManager): void {
  mgr.setCloudDispatcher(async (a) => {
    if (!a.cloudProvider) {
      throw new Error(`Teammate ${a.agentId} has no cloud provider set`);
    }
    const prov = resolveProvider(a.cloudProvider as CloudProviderId);
    const dispatchOpts: DispatchOptions = {
      prompt: a.prompt,
      agent: a.agentType,
      repo: a.cloudRepo ?? undefined,
      branch: a.cloudBranch ?? undefined,
      model: a.model ?? undefined,
    };
    const cloudTask = await prov.dispatch(dispatchOpts);
    return { cloudSessionId: cloudTask.id };
  });
}

/** Single-wave start used by `teams start` without --watch. */
async function runOneWave(mgr: AgentManager, team: string, json: boolean): Promise<void> {
  const launched = await mgr.startReady(team);
  const all = await mgr.listByTask(team);
  const stillPending = all.filter((a) => a.status === 'pending');

  if (json) {
    console.log(
      JSON.stringify({
        team,
        launched: launched.map((a) => ({ agent_id: a.agentId, name: a.name, after: a.after })),
        still_pending: stillPending.map((a) => ({ agent_id: a.agentId, name: a.name, after: a.after })),
      }, null, 2)
    );
    return;
  }

  if (launched.length === 0 && stillPending.length === 0) {
    console.log(chalk.gray(`No pending teammates in team ${team}.`));
    return;
  }

  if (launched.length > 0) {
    console.log(chalk.green(`Launched ${launched.length} teammate(s) in team ${chalk.cyan(team)}:`));
    for (const a of launched) {
      const who = fullName(a.agentType as AgentType, a.version);
      const h = a.name || shortId(a.agentId);
      console.log(`  ${chalk.cyan(h)}  ${who}`);
    }
  }
  if (stillPending.length > 0) {
    console.log();
    console.log(chalk.gray(`Still pending (${stillPending.length}):`));
    for (const a of stillPending) {
      const h = a.name || shortId(a.agentId);
      console.log(`  ${chalk.blue(h)}  ${chalk.gray('after')} ${a.after.join(', ')}`);
    }
  }
}

// Pick the display handle for a teammate: explicit teammate name, Claude
// session label, then the 8-char UUID prefix.
function handle(a: { name?: string | null; session_label?: string | null; agent_id: string }): string {
  return a.name || a.session_label || shortId(a.agent_id);
}

function displayHandle(a: AgentStatusDetail): string {
  if (a.name && a.session_label && a.name !== a.session_label) {
    return `${a.name} / ${a.session_label}`;
  }
  return handle(a);
}

type TeammateLookup =
  | { kind: 'ok'; agentId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: { team: string; agentId: string; display: string }[] };

// Resolve a teammate reference (name / UUID / UUID prefix) by scanning every
// meta.json under the agents dir. Team hint narrows the search.
async function resolveTeammateAcrossTeams(
  base: string,
  ref: string,
  teamHint?: string
): Promise<TeammateLookup> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(base);
  } catch {
    return { kind: 'none' };
  }

  // Cheap path: exact UUID or unique UUID prefix match by directory name.
  const byDir = entries.filter((e) => e === ref || e.startsWith(ref));
  if (byDir.length === 1 && byDir[0] === ref) {
    return { kind: 'ok', agentId: ref };
  }

  // Otherwise scan meta.json files to match on name as well, and respect the
  // team hint if given.
  const candidates: { team: string; agentId: string; display: string; name: string | null }[] = [];
  for (const dir of entries) {
    try {
      const meta = JSON.parse(
        await fs.readFile(path.join(base, dir, 'meta.json'), 'utf-8')
      );
      if (teamHint && meta.task_name !== teamHint) continue;
      const matchesName = meta.name && meta.name === ref;
      const matchesPrefix = dir.startsWith(ref);
      if (matchesName || matchesPrefix) {
        candidates.push({
          team: meta.task_name || '(none)',
          agentId: dir,
          display: meta.name || shortId(dir),
          name: meta.name || null,
        });
      }
    } catch {
      /* skip entries without readable meta.json */
    }
  }

  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) return { kind: 'ok', agentId: candidates[0].agentId };

  // If multiple match but one is an exact name hit, prefer it.
  const exactName = candidates.filter((c) => c.name === ref);
  if (exactName.length === 1) return { kind: 'ok', agentId: exactName[0].agentId };

  return { kind: 'ambiguous', candidates };
}

// Print a teammate block using the same session preview the sessions picker
// uses — one canonical renderer across `agents sessions`, teams picker
// preview, and teams status output.
//
// Layout:
//   alice  claude  COMPLETED · 5.0 minutes
//     after: bob
//     <buildSessionPreview output>    (when the session file was found)
//     ! reported an error             (if flagged)
//     PR: <url>                       (if set)
function printAgentDetail(a: AgentStatusDetail, session: SessionMeta | null): void {
  const label = statusColor(a.status)(a.status.toUpperCase());
  const who = fullName(a.agent_type as AgentType, a.version);
  const h = displayHandle(a);
  const secondary = a.name ? chalk.gray(`(${shortId(a.agent_id)})`) : '';
  const duration = a.duration ? `${chalk.gray(' · ')}${chalk.white(a.duration)}` : '';
  console.log(
    `  ${chalk.cyan(h.padEnd(10))} ${secondary.padEnd(11)} ${who.padEnd(18)} ${label}${duration}`
  );

  if (a.task_type) {
    console.log(`    ${chalk.gray('type    ')} ${chalk.magenta(a.task_type)}`);
  }
  if (a.prompt) {
    console.log(`    ${chalk.gray('task    ')} ${chalk.white(compactPrompt(a.prompt))}`);
  }
  const started = formatTimestamp(a.started_at);
  const completed = formatTimestamp(a.completed_at);
  if (started || completed) {
    const parts = [];
    if (started) parts.push(`started ${started}`);
    if (completed) parts.push(`ended ${completed}`);
    console.log(`    ${chalk.gray('time    ')} ${parts.join(chalk.gray(' · '))}`);
  }
  if (a.after && a.after.length) {
    console.log(`    ${chalk.gray('after   ')} ${a.after.join(', ')}`);
  }
  // If the agent's internal session id differs from ours (non-Claude), show
  // it as a hint for `agents sessions <id>`.
  if (a.remote_session_id && a.remote_session_id !== a.agent_id) {
    console.log(`    ${chalk.gray('session ')} ${chalk.gray(a.remote_session_id)}`);
  }

  if (session) {
    // Hand off to the same renderer the sessions picker uses. Indent so the
    // block visually belongs to this teammate.
    const preview = buildSessionPreview(session);
    for (const line of preview.split('\n')) {
      console.log(line ? `    ${line}` : '');
    }
  } else {
    // Session file not yet on disk (e.g. teammate is pending, or their
    // agent type writes sessions elsewhere). Fall back to a compact summary
    // derived from the live status payload.
    const activity: string[] = [];
    if (a.files_modified.length) activity.push(`${a.files_modified.length} modified`);
    if (a.files_created.length)  activity.push(`${a.files_created.length} created`);
    if (a.files_read.length)     activity.push(`${a.files_read.length} read`);
    if (a.tool_count)            activity.push(`${a.tool_count} tools`);
    if (activity.length) {
      console.log(`    ${chalk.gray(activity.join(' · '))}`);
    }
    const lastMsg = a.last_messages[a.last_messages.length - 1];
    if (lastMsg) {
      const firstLine = lastMsg.split(/\r?\n/).find((l) => l.trim()) || '';
      if (firstLine) console.log(`    ${chalk.gray('> ' + truncate(firstLine, 96))}`);
    }
  }

  if (a.recent_tool_calls.length) {
    console.log(`    ${chalk.gray('tools   ')}`);
    for (const call of a.recent_tool_calls.slice(-5)) {
      const when = call.timestamp ? `${relTime(call.timestamp)} ` : '';
      console.log(`      ${chalk.gray(when)}${chalk.bold(call.tool)} ${chalk.gray(truncate(call.summary, 96))}`);
    }
  }
  if (a.has_errors) console.log(`    ${chalk.red('! reported an error')}`);
  if (a.pr_url) console.log(`    ${chalk.gray('PR  ')}${a.pr_url}`);
}

// Resolve each live teammate to its on-disk session (Claude/Codex/Gemini/
// OpenCode all write parseable session files). `agent_id === remote_session_id`
// for Claude teammates; non-Claude agents may carry their own session UUID on
// `remote_session_id`. We try both.
async function resolveTeammateSessions(
  agents: AgentStatusDetail[]
): Promise<Map<string, SessionMeta | null>> {
  const map = new Map<string, SessionMeta | null>();
  if (agents.length === 0) return map;
  // Scan every project dir — team teammates may have run from anywhere.
  const all = await discoverSessions({ all: true, limit: 5000 });
  for (const a of agents) {
    const candidates = [a.remote_session_id, a.agent_id].filter(Boolean) as string[];
    let found: SessionMeta | null = null;
    for (const id of candidates) {
      const hits = resolveSessionById(all, id);
      if (hits.length) { found = hits[0]; break; }
    }
    map.set(a.agent_id, found);
  }
  return map;
}

// Render a team's status in the same format the `status` subcommand uses, so
// the interactive picker's Enter action drops the user into a familiar view.
async function printTeamStatus(team: string, result: import('../lib/teams/api.js').TaskStatusResult): Promise<void> {
  const { summary, agents } = result;
  console.log(
    chalk.bold(`Team ${chalk.cyan(team)}  `) +
      chalk.gray(
        summary.pending > 0
          ? `(${summary.pending} pending, ${summary.running} working, ${summary.completed} done, ${summary.failed} failed, ${summary.stopped} stopped)`
          : `(${summary.running} working, ${summary.completed} done, ${summary.failed} failed, ${summary.stopped} stopped)`
      )
  );
  if (agents.length === 0) {
    console.log(chalk.gray('  (no teammates yet — add one with `agents teams add`)'));
  } else {
    const sessions = await resolveTeammateSessions(agents);
    const width = Math.min(process.stdout.columns || 80, 80);
    const divider = chalk.gray('┈'.repeat(width));
    for (let i = 0; i < agents.length; i++) {
      console.log();
      if (i > 0) {
        console.log(divider);
        console.log();
      }
      printAgentDetail(agents[i], sessions.get(agents[i].agent_id) ?? null);
    }
  }
  console.log();
  console.log(chalk.gray(`cursor: ${result.cursor}`));
}

// Classify a team into a single bucket for --status filtering.
//  - empty:   no teammates (created but nobody added yet)
//  - waiting: only staged teammates — call `teams start` to kick them off
//  - working: at least one teammate still running
//  - failed:  at least one teammate failed or was stopped (any failure wins —
//             even if others finished, you want to know about the failure)
//  - done:    everyone finished successfully, no failures
function classifyTeamStatus(t: TaskInfo): 'empty' | 'waiting' | 'working' | 'done' | 'failed' {
  if (t.agent_count === 0) return 'empty';
  if (t.running > 0) return 'working';
  if (t.failed + t.stopped > 0) return 'failed';
  // At this point nobody is running/failed/stopped. If there's any pending
  // teammate (agent_count > running+completed+failed+stopped), it's "waiting".
  const accounted = t.running + t.completed + t.failed + t.stopped;
  if (accounted < t.agent_count) return 'waiting';
  return 'done';
}

// Merge persistent team registry with tasks derived from live agents so empty
// teams (created but no teammates yet) still show up.
function mergeTeams(
  registry: Record<string, { created_at: string; description?: string }>,
  tasks: TaskInfo[]
): TaskInfo[] {
  const byName = new Map<string, TaskInfo>();
  for (const t of tasks) byName.set(t.task_name, t);
  for (const [name, meta] of Object.entries(registry)) {
    if (!byName.has(name)) {
      byName.set(name, {
        task_name: name,
        agent_count: 0,
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        stopped: 0,
        workspace_dir: null,
        created_at: meta.created_at,
        modified_at: meta.created_at,
      });
    }
  }
  return Array.from(byName.values()).sort(
    (a, b) => new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime()
  );
}

// Build the same enriched rows the `list` picker uses. Shared between `list`
// (interactive default) and the picker fallback for `status` / `start`.
async function loadTeamRows(
  mgr: AgentManager
): Promise<{ rows: TeamRow[]; names: string[] }> {
  const [tasks, registry] = await Promise.all([handleTasks(mgr, 1000), loadTeams()]);
  const merged = mergeTeams(registry, tasks.tasks);
  const rows: TeamRow[] = await Promise.all(
    merged.map(async (team) => {
      let agents: AgentStatusDetail[] = [];
      try {
        const res = await handleStatus(mgr, team.task_name, 'all');
        agents = res.agents;
      } catch {
        // Empty teams (no live agents) throw in some code paths.
      }
      return { team, agents, description: registry[team.task_name]?.description };
    })
  );
  return { rows, names: merged.map((t) => t.task_name) };
}

// Picker fallback for `teams logs` when the teammate ref is omitted. Shows a
// flat list of every teammate with their team context; Enter picks one.
async function pickTeammateOr(
  mgr: AgentManager,
  command: string
): Promise<{ agentId: string; team: string } | null> {
  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(`Picking a teammate for \`${command}\``, [
      `${command} <teammate>`,
      `agents teams list  # to see teammates per team`,
    ]);
  }
  const all = await mgr.listAll();
  if (all.length === 0) {
    console.log(chalk.gray('No teammates on any team yet.'));
    console.log(chalk.gray('  Add one with:  agents teams add <team> <agent> <task>'));
    return null;
  }
  const nameW = Math.max(8, ...all.map((a) => (a.name || shortId(a.agentId)).length));
  const teamW = Math.max(6, ...all.map((a) => a.taskName.length));
  try {
    const picked = await itemPicker<AgentProcess>({
      message: 'Select a teammate:',
      items: all,
      filter: (query) => {
        const q = query.trim().toLowerCase();
        if (!q) return all;
        return all.filter((a) => {
          const hay = [a.name ?? '', a.agentId, a.taskName, a.agentType, a.status].join(' ').toLowerCase();
          return hay.includes(q);
        });
      },
      labelFor: (a) => {
        const h = (a.name || shortId(a.agentId)).padEnd(nameW);
        const team = a.taskName.padEnd(teamW);
        const who = fullName(a.agentType as AgentType, a.version);
        return `${chalk.cyan(h)}  ${chalk.gray(team)}  ${who}  ${statusColor(a.status)(a.status)}`;
      },
      shortIdFor: (a) => a.name || shortId(a.agentId),
      pageSize: 10,
      emptyMessage: 'No teammates match.',
      enterHint: 'view log',
    });
    if (!picked) return null;
    return { agentId: picked.item.agentId, team: picked.item.taskName };
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

// Fallback for read-only / constructive subcommands when the user omits the
// team argument. In a TTY, show the picker and return the chosen team. Outside
// a TTY, hard-fail with a clear error so scripts surface the missing arg.
async function pickTeamOr(
  mgr: AgentManager,
  command: string
): Promise<string | null> {
  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(`Picking a team for \`${command}\``, [
      `${command} <team>`,
      `agents teams list  # to see your teams`,
    ]);
  }
  const { rows } = await loadTeamRows(mgr);
  if (rows.length === 0) {
    console.log(chalk.gray("You haven't started any teams yet."));
    console.log(chalk.gray('  Start one with:  agents teams create <name>'));
    return null;
  }
  try {
    const picked = await teamPicker(rows);
    return picked?.team ?? null;
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

/** Register the `agents teams` command tree (list, create, add, status, start, remove, disband, logs, doctor). */
export function registerTeamsCommands(program: Command): void {
  const teams = program
    .command('teams')
    .description('Organize AI coding agents into teams that work in parallel on a shared task.');

  setHelpSections(teams, {
    examples: `
      # Create a team for a coordinated task
      agents teams create pricing-page

      # Add a teammate — name them so you can refer to them later
      agents teams add pricing-page claude "Rewrite /v2/pricing endpoint" --name backend

      # Parallel work — frontend stubs API while backend lands
      agents teams add pricing-page codex "Build /pricing route with three-tier layout" --name frontend

      # DAG dependency — QA waits for backend AND frontend to finish
      agents teams add pricing-page claude "Run Playwright suite, fix flakes" --name qa --after backend,frontend

      # Start everyone (respects --after dependencies) and watch live
      agents teams start pricing-page --watch

      # Delta-poll status without rereading everything
      agents teams status pricing-page --since 2026-04-24T09:00:00-07:00

      # Wind everyone down when shipped
      agents teams disband pricing-page
    `,
    notes: `
      A team is a named group of agents working in the background on a shared task.
      Teammate sessions show in 'agents sessions --teams' tagged [team/name · mode].

      Teammate syntax:
        'claude'           the default Claude version on this machine
        'claude@2.1.112'   a specific installed version (see 'agents view')

      Short aliases:
        teams c  = create    teams a  = add       teams s  = status
        teams rm = remove    teams d  = disband   teams ls = list
    `,
  });

  // list
  teams
    .command('list [query]')
    .alias('ls')
    .description('List your teams, most recent activity first')
    .option('-a, --agent <agent>', 'Filter: only teams with this agent (e.g. claude or claude@2.1.112)')
    .option('--status <status>', 'Filter: only teams with this status (working, done, failed, or empty)')
    .option('--since <time>', 'Filter: teams active after this time (e.g. "2h", "7d", or ISO date)')
    .option('--until <time>', 'Filter: teams active before this time (e.g. "30d", or ISO date)')
    .option('-n, --limit <n>', 'Show at most this many teams (default: 20)', '20')
    .option('--json', 'Output machine-readable JSON instead of formatted table')
    .action(async (query: string | undefined, opts: {
      agent?: string; status?: string; since?: string; until?: string;
      limit: string; json?: boolean;
    }) => {
      const mgr = mkManager();
      const limit = Math.max(1, parseInt(opts.limit, 10) || 20);
      const [tasks, registry, everyAgent] = await Promise.all([
        handleTasks(mgr, 1000),
        loadTeams(),
        mgr.listAll(),
      ]);

      // Group agents by team so we can filter on agent-type / version.
      const byTeam = new Map<string, { agent_type: string; version: string | null }[]>();
      for (const a of everyAgent) {
        const arr = byTeam.get(a.taskName) || [];
        arr.push({ agent_type: a.agentType, version: a.version });
        byTeam.set(a.taskName, arr);
      }

      let merged = mergeTeams(registry, tasks.tasks);

      // --- query: substring match on team name ---
      if (query) {
        const q = query.toLowerCase();
        merged = merged.filter((t) => t.task_name.toLowerCase().includes(q));
      }

      // --- --agent: filter teams containing a matching teammate ---
      if (opts.agent) {
        const [wantType, rawVersion] = opts.agent.split('@');
        const wantVersion = VALID_AGENTS.includes(wantType as AgentType)
          ? resolveVersionAliasLoose(wantType as AgentId, rawVersion)
          : rawVersion;
        merged = merged.filter((t) => {
          const teammates = byTeam.get(t.task_name) || [];
          return teammates.some(
            (m) => m.agent_type === wantType && (!wantVersion || m.version === wantVersion)
          );
        });
      }

      // --- --status: classify each team, filter ---
      if (opts.status) {
        const want = opts.status.toLowerCase();
        const validStatuses = ['working', 'done', 'failed', 'empty'];
        if (!validStatuses.includes(want)) {
          die(`Invalid --status '${opts.status}'. Use one of: ${validStatuses.join(', ')}`);
        }
        merged = merged.filter((t) => classifyTeamStatus(t) === want);
      }

      // --- --since / --until: filter by activity window ---
      if (opts.since) {
        const cutoff = parseTimeFilter(opts.since);
        if (!cutoff) die(`Could not parse --since '${opts.since}'`);
        merged = merged.filter((t) => new Date(t.modified_at).getTime() >= cutoff);
      }
      if (opts.until) {
        const cutoff = parseTimeFilter(opts.until);
        if (!cutoff) die(`Could not parse --until '${opts.until}'`);
        merged = merged.filter((t) => new Date(t.modified_at).getTime() <= cutoff);
      }

      merged = merged.slice(0, limit);

      if (isJsonMode(opts)) {
        console.log(JSON.stringify({ teams: merged }, null, 2));
        return;
      }

      if (merged.length === 0) {
        if (query || opts.agent || opts.status || opts.since || opts.until) {
          console.log(chalk.gray('No teams match those filters.'));
        } else {
          console.log(chalk.gray("You haven't started any teams yet."));
          console.log(chalk.gray('  Start one with:  agents teams create <name>'));
        }
        return;
      }

      // Enrich teams with teammate details for the picker's preview pane.
      const rows: TeamRow[] = await Promise.all(
        merged.map(async (team) => {
          let agents: AgentStatusDetail[] = [];
          try {
            const res = await handleStatus(mgr, team.task_name, 'all');
            agents = res.agents;
          } catch {
            // Empty teams (no live agents) throw in some code paths — preview
            // will just show "no teammates yet".
          }
          return { team, agents, description: registry[team.task_name]?.description };
        })
      );

      if (isInteractiveTerminal()) {
        try {
          const picked = await teamPicker(rows, query);
          if (picked) {
            // Fall through to the status subcommand's action for the picked team.
            const result = await handleStatus(mgr, picked.team, 'all');
            await printTeamStatus(picked.team, result);
          }
        } catch (err) {
          if (!isPromptCancelled(err)) throw err;
        }
        return;
      }

      // Non-interactive fallback: rows flow without a header, matching the
      // shape of `agents sessions` when piped.
      printTeamTable(rows);
    });

  // create
  teams
    .command('create <team>')
    .aliases(['c', 'new'])
    .description('Start a new team. No teammates yet; add them with `teams add`.')
    .option('-d, --description <text>', 'One-line summary of what this team is working on')
    .option('--enable-worktrees', 'Each teammate works in its own git worktree (requires --worktree on add)')
    .option('--use-worktree <path>', 'All teammates share this existing worktree path (mutually exclusive with --enable-worktrees)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string, opts: { description?: string; enableWorktrees?: boolean; useWorktree?: string; json?: boolean }) => {
      try {
        const meta = await createTeam(team, {
          description: opts.description,
          enableWorktrees: opts.enableWorktrees,
          useWorktree: opts.useWorktree,
        });
        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ team, ...meta }, null, 2));
          return;
        }
        console.log(chalk.green(`New team: ${chalk.cyan(team)}`));
        if (meta.description) console.log(chalk.gray(`  ${meta.description}`));
        if (meta.enable_worktrees) console.log(chalk.gray(`  worktrees: per-teammate`));
        if (meta.use_worktree) console.log(chalk.gray(`  worktree: ${meta.use_worktree}`));
        console.log();
        console.log(chalk.gray('Add your first teammate:'));
        if (meta.enable_worktrees) {
          console.log(chalk.gray(`  agents teams add ${team} claude "your task here" --name alice --worktree feature-name`));
        } else {
          console.log(chalk.gray(`  agents teams add ${team} claude "your task here"`));
        }
      } catch (err) {
        die((err as Error).message);
      }
    });

  // add
  teams
    .command('add <team> <teammate> <task>')
    .alias('a')
    .description("Add a teammate to work on a task. Runs in background; returns immediately. Use 'status' to check in.")
    .option('-n, --name <name>', 'Friendly name for this teammate (e.g. alice). Required if using --after. Unique within team.')
    .option('-m, --mode <mode>', `Permissions: plan (read-only) | edit (can write files) | full (write + skip permission prompts)`, 'edit')
    .option('-e, --effort <effort>', `Reasoning intensity: ${VALID_EFFORTS.join('|')}`, 'medium')
    .option('--model <model>', 'Override the effort tier and use this specific model (e.g. claude-opus-4-6)')
    .option(
      '--env <key=value>',
      'Set an environment variable for this teammate (repeatable for multiple vars)',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option('--cwd <dir>', 'Working directory for this teammate (default: current directory)')
    .option('--worktree <name>', 'Run this teammate in a dedicated git worktree (required when team has --enable-worktrees)')
    .option('--after <names>', "DAG dependencies: comma-separated teammate names to wait for. Stages as PENDING; run 'teams start' to launch when ready.")
    .option('--task-type <type>', `Factory label: ${VALID_TASK_TYPES.join('|')}. Drives planner fan-out + test-oracle bugfix loop.`)
    .option('--cloud <provider>', `Dispatch to cloud backend instead of local CLI: ${VALID_CLOUD_PROVIDERS.join('|')}`)
    .option('--repo <owner/repo>', 'GitHub repository (required for --cloud rush)')
    .option('--branch <name>', 'Target git branch for cloud dispatch')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string, teammate: string, task: string, opts: {
      name?: string; mode: string; effort: string; model?: string; env: string[];
      cwd?: string; worktree?: string; after?: string; json?: boolean;
      taskType?: string; cloud?: string; repo?: string; branch?: string;
    }) => {
      if (!(VALID_MODES as readonly string[]).includes(opts.mode)) {
        die(`Invalid mode '${opts.mode}'. Use one of: ${VALID_MODES.join(', ')}`);
      }
      if (!(VALID_EFFORTS as readonly string[]).includes(opts.effort)) {
        die(`Invalid effort '${opts.effort}'. Use one of: ${VALID_EFFORTS.join(', ')}`);
      }

      let taskType: TaskType | null = null;
      if (opts.taskType) {
        if (!(VALID_TASK_TYPES as readonly string[]).includes(opts.taskType)) {
          die(`Invalid task-type '${opts.taskType}'. Use one of: ${VALID_TASK_TYPES.join(', ')}`);
        }
        taskType = opts.taskType as TaskType;
      }

      let cloudProviderId: CloudProviderId | null = null;
      if (opts.cloud) {
        if (!(VALID_CLOUD_PROVIDERS as readonly string[]).includes(opts.cloud)) {
          die(`Invalid cloud provider '${opts.cloud}'. Use one of: ${VALID_CLOUD_PROVIDERS.join(', ')}`);
        }
        cloudProviderId = opts.cloud as CloudProviderId;
        if (cloudProviderId === 'rush' && !opts.repo) {
          die(`--cloud rush requires --repo <owner/repo>`);
        }
      }

      const { agent, version } = parseTeammate(teammate);
      if (version && !isVersionInstalled(agent, version)) {
        die(
          `${AGENT_NAMES[agent]} ${version} isn't installed.\n` +
            `  Install it:  agents add ${agent}@${version}\n` +
            `  Or see what's installed:  agents view ${agent}`
        );
      }

      if (opts.name !== undefined) {
        if (!opts.name || !/^[A-Za-z0-9_-]+$/.test(opts.name)) {
          die(`Invalid teammate name '${opts.name}'. Use letters, numbers, '-', or '_'.`);
        }
      }

      const after = opts.after
        ? opts.after.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      if (after.length > 0 && !opts.name) {
        die("--after requires --name (dependencies reference teammates by name).");
      }

      let envOverrides: Record<string, string> | undefined;
      try {
        envOverrides = parseExecEnv(opts.env);
      } catch (err) {
        die((err as Error).message);
      }

      // Auto-create the team if it doesn't exist yet (friendlier UX than erroring).
      await ensureTeam(team);

      // Check if team has worktrees enabled or a shared worktree
      const teamMeta = await getTeam(team);
      const worktreesEnabled = teamMeta?.enable_worktrees ?? false;
      const sharedWorktree = teamMeta?.use_worktree ?? null;
      let worktreeName: string | null = null;
      let worktreePath: string | null = null;

      if (sharedWorktree) {
        // Team uses a shared worktree for all teammates
        const fsp = await import('fs/promises');
        try {
          const stat = await fsp.stat(sharedWorktree);
          if (!stat.isDirectory()) {
            die(`Shared worktree path is not a directory: ${sharedWorktree}`);
          }
        } catch {
          die(`Shared worktree path does not exist: ${sharedWorktree}`);
        }
        worktreePath = sharedWorktree;
        if (opts.worktree) {
          die(`Team '${team}' uses --use-worktree (shared). Don't pass --worktree on add.`);
        }
      } else if (worktreesEnabled) {
        if (!opts.worktree) {
          die(`Team '${team}' has worktrees enabled. Use --worktree <name> to specify a worktree name.`);
        }
        if (!opts.name) {
          die(`Team '${team}' has worktrees enabled. Use --name <name> to identify this teammate.`);
        }
        const baseCwd = opts.cwd ?? process.cwd();
        if (!(await isGitRepo(baseCwd))) {
          die(`Worktrees require a git repository. ${baseCwd} is not inside a git repo.`);
        }
        try {
          worktreeName = opts.worktree;
          worktreePath = await createWorktree(baseCwd, worktreeName);
        } catch (err) {
          die(`Failed to create worktree '${opts.worktree}': ${(err as Error).message}`);
        }
      } else if (opts.worktree) {
        die(`--worktree requires --enable-worktrees on the team. Recreate the team with: agents teams create ${team} --enable-worktrees`);
      }

      const cwd = worktreePath ?? opts.cwd ?? process.cwd();
      const mgr = mkManager();

      // Factory teammates: prepend the worker-skill preamble to every task
      // prompt so implementers/testers/reviewers know about the Ledger, the
      // dynamic DAG, and the pattern for filing new tasks mid-flight. No
      // preamble when --task-type isn't set (plain teammates work as before).
      let effectiveTask = task;
      if (taskType) {
        effectiveTask = factoryWorkerPreamble(team, opts.name ?? null, taskType, after) + '\n\n' + task;
      }

      // Dispatcher callback: when a staged cloud teammate's deps resolve,
      // AgentManager.startReady() invokes this to kick off the remote task.
      if (cloudProviderId) {
        const providerId = cloudProviderId;
        mgr.setCloudDispatcher(async (a) => {
          const prov = resolveProvider(providerId);
          const dispatchOpts: DispatchOptions = {
            prompt: a.prompt,
            agent: a.agentType,
            repo: opts.repo,
            branch: opts.branch,
            model: a.model ?? undefined,
          };
          const cloudTask = await prov.dispatch(dispatchOpts);
          return { cloudSessionId: cloudTask.id };
        });
      }

      let cloudSessionId: string | null = null;
      const isStaged = after.length > 0;
      if (cloudProviderId && !isStaged) {
        // Ready to run now: dispatch to the cloud provider before registering
        // the teammate so we have the remote session id up front.
        const prov = resolveProvider(cloudProviderId);
        const dispatchOpts: DispatchOptions = {
          prompt: effectiveTask,
          agent,
          repo: opts.repo,
          branch: opts.branch,
          model: opts.model,
        };
        try {
          const cloudTask = await prov.dispatch(dispatchOpts);
          cloudSessionId = cloudTask.id;
        } catch (err) {
          die(`Cloud dispatch failed: ${(err as Error).message}`);
        }
      }

      try {
        const result = await handleSpawn(
          mgr,
          team,
          agent,
          effectiveTask,
          cwd,
          opts.mode as Mode,
          opts.effort as Effort,
          null,
          cwd,
          version,
          opts.name ?? null,
          after,
          opts.model ?? null,
          envOverrides ?? null,
          taskType,
          cloudProviderId,
          cloudSessionId,
          opts.repo ?? null,
          opts.branch ?? null,
          worktreeName,
          worktreePath
        );

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const who = fullName(agent, version);
        const staged = result.status === 'pending';
        const verb = staged ? 'Staged' : 'Welcomed';
        const greeting = result.name
          ? `${verb} ${chalk.cyan(result.name)} (${who}) ${staged ? 'in' : 'to'} team ${chalk.cyan(team)}`
          : `${verb} ${who} ${staged ? 'in' : 'to'} team ${chalk.cyan(team)}`;
        console.log(chalk.green(greeting));
        if (result.name) {
          console.log(`  ${chalk.gray('name    ')}  ${chalk.cyan(result.name)}`);
        }
        console.log(`  ${chalk.gray('agent_id')}  ${chalk.cyan(shortId(result.agent_id))} ${chalk.gray(`(${result.agent_id})`)}`);
        console.log(`  ${chalk.gray('status  ')}  ${statusColor(result.status)(result.status)}`);
        console.log(`  ${chalk.gray('mode    ')}  ${opts.mode}`);
        console.log(`  ${chalk.gray('working ')}  ${cwd}`);
        if (worktreeName) {
          console.log(`  ${chalk.gray('worktree')}  ${chalk.cyan(worktreeName)}`);
        }
        if (result.task_type) {
          console.log(`  ${chalk.gray('task    ')}  ${chalk.cyan(result.task_type)}`);
        }
        if (result.cloud_provider) {
          console.log(`  ${chalk.gray('cloud   ')}  ${chalk.magenta(result.cloud_provider)}${result.cloud_session_id ? chalk.gray(' — ' + result.cloud_session_id.slice(0, 12)) : ''}`);
        }
        if (result.after && result.after.length) {
          console.log(`  ${chalk.gray('after   ')}  ${result.after.join(', ')}`);
        }
        console.log();
        if (staged) {
          console.log(chalk.gray(`Start the ready teammates:  agents teams start ${team}`));
        } else {
          console.log(chalk.gray(`Check in later:  agents teams status ${team}`));
        }
      } catch (err) {
        die(`Could not add ${fullName(agent, version)} to ${team}: ${(err as Error).message}`);
      }
    });

  // status
  teams
    .command('status [team]')
    .aliases(['s', 'st', 'check'])
    .description("Check in on a team: who's working, what files they touched, recent commands, last output. Pass --since for efficient delta polling.")
    .option('-f, --filter <state>', 'Show only teammates in this state: running, completed, failed, stopped, or all (default: all)', 'all')
    .option('-s, --since <iso>', 'Cursor from a previous status call; only show updates after this timestamp (enables efficient polling)')
    .option('--agent-id <id>', 'Show only this one teammate (by UUID or UUID prefix)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string | undefined, opts: {
      filter: string; since?: string; agentId?: string; json?: boolean;
    }) => {
      const filter = opts.filter;
      const mgr = mkManager();

      // No team given → drop into the picker (TTY) or fail clearly (script).
      if (!team) {
        const picked = await pickTeamOr(mgr, 'agents teams status');
        if (!picked) return;
        team = picked;
      }

      try {
        const result = await handleStatus(mgr, team, filter, opts.since);
        const agents = opts.agentId
          ? result.agents.filter((a) => a.agent_id.startsWith(opts.agentId!))
          : result.agents;

        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ ...result, agents }, null, 2));
          return;
        }

        const exists = await teamExists(team);
        if (!exists && result.agents.length === 0) {
          console.log(chalk.yellow(`No team called '${team}'. Create it with: agents teams create ${team}`));
          return;
        }

        await printTeamStatus(team, { ...result, agents });
      } catch (err) {
        die(`Could not check on team ${team}: ${(err as Error).message}`);
      }
    });

  // active — list every live teammate across every team, grouped by team.
  teams
    .command('active')
    .description('List every teammate running right now, across all teams (PID-alive check).')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const mgr = mkManager();
      const running = await mgr.listRunning();

      if (isJsonMode(opts)) {
        console.log(JSON.stringify({ agents: running.map((a) => ({
          agent_id: a.agentId,
          team: a.taskName,
          name: a.name,
          agent_type: a.agentType,
          pid: a.pid,
          started_at: a.startedAt.toISOString(),
          cwd: a.cwd,
          version: a.version,
        })) }, null, 2));
        return;
      }

      if (running.length === 0) {
        console.log(chalk.gray('No teammates are running right now.'));
        return;
      }

      const byTeam = new Map<string, typeof running>();
      for (const a of running) {
        const arr = byTeam.get(a.taskName) || [];
        arr.push(a);
        byTeam.set(a.taskName, arr);
      }

      for (const [team, agents] of byTeam) {
        console.log(chalk.bold(`Team ${chalk.cyan(team)}  ${chalk.gray(`(${agents.length} working)`)}`));
        for (const a of agents) {
          const ident = a.name || shortId(a.agentId);
          const pidStr = a.pid ? chalk.yellow(`pid ${a.pid}`) : chalk.gray('pid ?');
          const started = chalk.gray(relTime(a.startedAt.toISOString()));
          console.log(`  ${chalk.magenta(padRight(fullName(a.agentType, a.version), 18))}  ${chalk.white(padRight(ident, 20))}  ${pidStr}  ${started}`);
        }
        console.log();
      }
      console.log(chalk.gray(`${running.length} teammate${running.length === 1 ? '' : 's'} running. See 'agents sessions --active' for the full cross-context view.`));
    });

  // start — fire any staged teammates whose --after deps have all completed
  teams
    .command('start [team]')
    .description('Launch any pending teammates whose --after dependencies are satisfied. Use --watch to keep draining the DAG as teammates finish and as new tasks are added mid-flight.')
    .option('--json', 'Output machine-readable JSON')
    .option('--watch', 'Keep running: poll every --interval seconds, fire new waves, exit when the DAG drains.')
    .option('--interval <seconds>', 'Seconds between waves in --watch mode (default 8)', '8')
    .option('--max-waves <n>', 'Safety cap on waves in --watch mode (default 1000)', '1000')
    .action(async (team: string | undefined, opts: { json?: boolean; watch?: boolean; interval: string; maxWaves: string }) => {
      const mgr = mkManager();
      wireCloudDispatcher(mgr);

      if (!team) {
        const picked = await pickTeamOr(mgr, 'agents teams start');
        if (!picked) return;
        team = picked;
      }

      if (!opts.watch) {
        await runOneWave(mgr, team, Boolean(opts.json));
        return;
      }

      const intervalMs = Math.max(1000, Number.parseInt(opts.interval, 10) * 1000 || 8000);
      const maxWaves = Math.max(1, Number.parseInt(opts.maxWaves, 10) || 1000);
      const json = isJsonMode(opts);

      const result = await runSupervisor(mgr, {
        team,
        intervalMs,
        maxWaves,
        onWave: (s) => {
          const ts = s.timestamp.slice(11, 19);
          if (json) {
            console.log(JSON.stringify({
              wave: s.wave, ts, team: s.team, launched: s.launched.length,
              pending: s.pending, running: s.running, completed: s.completed, failed: s.failed,
            }));
            return;
          }
          console.log(
            `[${ts}] wave ${s.wave}  team ${chalk.cyan(s.team)}  ` +
            `launched=${chalk.green(s.launched.length)}  running=${chalk.yellow(s.running)}  ` +
            `pending=${chalk.blue(s.pending)}  done=${chalk.green(s.completed)}  ` +
            `failed=${s.failed > 0 ? chalk.red(s.failed) : '0'}`
          );
        },
      });

      const elapsed = Math.floor(result.elapsed_ms / 1000);
      if (result.stoppedBy === 'drained') {
        console.log(chalk.green(`Factory drained in ${elapsed}s (${result.waves} waves).`));
      } else if (result.stoppedBy === 'max-waves') {
        console.error(chalk.yellow(`Hit --max-waves=${maxWaves}; stopping. Re-run to continue.`));
      } else if (result.stoppedBy === 'signal') {
        console.error(chalk.yellow(`Stopped by signal after ${result.waves} waves.`));
      }
    });

  // stop
  teams
    .command('stop [team] [teammate]')
    .description('Stop a running teammate. Can be restarted later. Cleans up worktree if no uncommitted changes.')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string | undefined, ref: string | undefined, opts: { json?: boolean }) => {
      const mgr = mkManager();

      if (!team) {
        const { names } = await loadTeamRows(mgr);
        requireDestructiveArg({
          argName: 'team',
          command: 'agents teams stop',
          itemNoun: 'team',
          available: names,
          emptyHint: "You don't have any teams yet.",
        });
      }
      if (!ref) {
        const roster = await mgr.listByTask(team);
        const running = roster.filter((a) => a.status === 'running');
        requireDestructiveArg({
          argName: 'teammate',
          command: `agents teams stop ${team}`,
          itemNoun: 'teammate',
          available: running.map((a) => a.name || shortId(a.agentId)),
          emptyHint: `Team ${team} has no running teammates.`,
        });
      }

      const lookup = await mgr.resolveAgentIdInTask(team, ref);
      if (lookup.kind === 'none') {
        die(`No teammate matching '${ref}' in team ${team}`, 2);
      }
      if (lookup.kind === 'ambiguous') {
        const shorts = lookup.matches.map(shortId).join(', ');
        die(`'${ref}' matches multiple teammates: ${shorts}. Use more characters or a name.`, 2);
      }
      const agentId = lookup.agentId;

      const agent = await mgr.get(agentId);
      const display = agent?.name || shortId(agentId);

      const stopRes = await handleStop(mgr, team, agentId);
      if ('error' in stopRes) die(stopRes.error);

      // Clean up worktree if this teammate had one
      let worktreeKept = false;
      if (agent?.worktreeName && agent?.worktreePath) {
        try {
          const dirty = await hasUncommittedChanges(agent.worktreePath);
          if (dirty) {
            worktreeKept = true;
          } else {
            const baseCwd = process.cwd();
            await removeWorktree(baseCwd, agent.worktreeName);
          }
        } catch {
          // best-effort cleanup
        }
      }

      if (isJsonMode(opts)) {
        console.log(JSON.stringify({
          team,
          agent_id: agentId,
          name: agent?.name ?? null,
          stopped: stopRes.stopped.length > 0,
          worktree_kept: worktreeKept,
        }, null, 2));
        return;
      }

      if (stopRes.stopped.length) {
        console.log(chalk.green(`Stopped ${chalk.cyan(display)} in team ${chalk.cyan(team)}.`));
      } else if (stopRes.already_stopped.length) {
        console.log(chalk.gray(`${display} was already stopped.`));
      }
      if (worktreeKept && agent?.worktreeName) {
        console.log(chalk.yellow(`Worktree '${agent.worktreeName}' has uncommitted changes. Keeping it at: ${agent.worktreePath}`));
      }
    });

  // remove
  teams
    .command('remove [team] [teammate]')
    .alias('rm')
    .description("Remove a stopped teammate's logs and metadata. Use 'stop' first to end a running teammate.")
    .option('--keep-logs', 'Keep their log files on disk (default: delete them)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string | undefined, ref: string | undefined, opts: { keepLogs?: boolean; json?: boolean }) => {
      const mgr = mkManager();

      if (!team) {
        const { names } = await loadTeamRows(mgr);
        requireDestructiveArg({
          argName: 'team',
          command: 'agents teams remove',
          itemNoun: 'team',
          available: names,
          emptyHint: "You don't have any teams yet.",
        });
      }
      if (!ref) {
        const roster = await mgr.listByTask(team);
        const stopped = roster.filter((a) => a.status !== 'running' && a.status !== 'pending');
        requireDestructiveArg({
          argName: 'teammate',
          command: `agents teams remove ${team}`,
          itemNoun: 'stopped teammate',
          available: stopped.map((a) => a.name || shortId(a.agentId)),
          emptyHint: `Team ${team} has no stopped teammates. Use 'agents teams stop' first.`,
        });
      }

      const lookup = await mgr.resolveAgentIdInTask(team, ref);
      if (lookup.kind === 'none') {
        die(`No teammate matching '${ref}' in team ${team}`, 2);
      }
      if (lookup.kind === 'ambiguous') {
        const shorts = lookup.matches.map(shortId).join(', ');
        die(`'${ref}' matches multiple teammates: ${shorts}. Use more characters or a name.`, 2);
      }
      const agentId = lookup.agentId;

      const agent = await mgr.get(agentId);
      const display = agent?.name || shortId(agentId);

      // Require agent to be stopped first
      if (agent?.status === 'running' || agent?.status === 'pending') {
        die(`Teammate '${display}' is still ${agent.status}. Run 'agents teams stop ${team} ${display}' first.`);
      }

      if (!opts.keepLogs) {
        try {
          const dir = path.join(await getAgentsDir(), agentId);
          await fs.rm(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }

      if (isJsonMode(opts)) {
        console.log(JSON.stringify({ team, agent_id: agentId, name: agent?.name ?? null, removed: true }, null, 2));
        return;
      }

      console.log(chalk.green(`Removed ${chalk.cyan(display)} from team ${chalk.cyan(team)}.`));
    });

  // disband
  teams
    .command('disband [team]')
    .alias('d')
    .description('Disband the team. Stops all teammates cleanly and removes the team registry entry.')
    .option('--keep-logs', 'Keep all teammate logs on disk (default: delete them)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string | undefined, opts: { keepLogs?: boolean; json?: boolean }) => {
      const mgr = mkManager();

      if (!team) {
        const { names } = await loadTeamRows(mgr);
        requireDestructiveArg({
          argName: 'team',
          command: 'agents teams disband',
          itemNoun: 'team',
          available: names,
          emptyHint: "You don't have any teams to disband.",
        });
      }

      const stopRes = await handleStop(mgr, team);
      if ('error' in stopRes) die(stopRes.error);

      const status = await handleStatus(mgr, team, 'all');

      // Clean up worktrees for all teammates
      const baseCwd = process.cwd();
      const keptWorktrees: string[] = [];
      for (const a of status.agents) {
        const agent = await mgr.get(a.agent_id);
        if (agent?.worktreeName && agent?.worktreePath) {
          try {
            const dirty = await hasUncommittedChanges(agent.worktreePath);
            if (dirty) {
              keptWorktrees.push(agent.worktreeName);
            } else {
              await removeWorktree(baseCwd, agent.worktreeName);
            }
          } catch { /* best-effort */ }
        }
      }

      const removedIds: string[] = [];
      if (!opts.keepLogs) {
        const base = await getAgentsDir();
        for (const a of status.agents) {
          try {
            await fs.rm(path.join(base, a.agent_id), { recursive: true, force: true });
            removedIds.push(a.agent_id);
          } catch { /* best-effort */ }
        }
      }

      const existed = await removeTeam(team);

      if (isJsonMode(opts)) {
        console.log(JSON.stringify({ team, existed, stopped: stopRes.stopped, removed_members: removedIds }, null, 2));
        return;
      }
      if (!existed && stopRes.stopped.length === 0 && status.agents.length === 0) {
        die(`No team called '${team}'`, 2);
      }
      console.log(chalk.green(`Team ${chalk.cyan(team)} disbanded.`));
      if (stopRes.stopped.length) console.log(chalk.gray(`  Stopped ${stopRes.stopped.length} working teammate(s).`));
      if (removedIds.length) console.log(chalk.gray(`  Cleared ${removedIds.length} teammate log(s).`));
      if (keptWorktrees.length) {
        console.log(chalk.yellow(`  Kept ${keptWorktrees.length} worktree(s) with uncommitted changes: ${keptWorktrees.join(', ')}`));
      }
    });

  // logs
  teams
    .command('logs [teammate]')
    .alias('log')
    .description("Read a teammate's raw log output. Accepts name, UUID, or UUID prefix.")
    .option('-n, --tail <n>', 'Show only the last N lines instead of the full log')
    .option('--team <team>', 'Disambiguate when the same name appears in multiple teams')
    .action(async (ref: string | undefined, opts: { tail?: string; team?: string }) => {
      const base = await getAgentsDir();

      // No teammate → picker in TTY, hard fail outside.
      let agentId: string;
      if (!ref) {
        const mgr = mkManager();
        const picked = await pickTeammateOr(mgr, 'agents teams logs');
        if (!picked) return;
        agentId = picked.agentId;
      } else {
        const resolved = await resolveTeammateAcrossTeams(base, ref, opts.team);
        if (resolved.kind === 'none') {
          die(`No notes on record for teammate '${ref}'`, 2);
        }
        if (resolved.kind === 'ambiguous') {
          const hints = resolved.candidates.map((c) => `${c.team}/${c.display}`).join(', ');
          die(
            `'${ref}' matches multiple teammates: ${hints}.\n` +
              `  Narrow it with --team <team>, or pass a UUID prefix.`,
            2
          );
        }
        agentId = resolved.agentId;
      }

      const logPath = path.join(base, agentId, 'stdout.log');
      try {
        const content = await fs.readFile(logPath, 'utf-8');
        if (!opts.tail) {
          process.stdout.write(content);
          return;
        }
        const n = Math.max(1, parseInt(opts.tail, 10) || 50);
        const lines = content.split('\n');
        process.stdout.write(lines.slice(-n).join('\n'));
      } catch {
        die(`No notes on record for teammate '${ref ?? agentId}' (looked in ${logPath})`, 2);
      }
    });

  // doctor
  teams
    .command('doctor')
    .alias('dr')
    .description('Check which agents are installed and available to join a team. Verifies CLI paths.')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const info = checkAllClis();
      if (isJsonMode(opts)) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      console.log(chalk.bold('Who can join a team:'));
      for (const [name, entry] of Object.entries(info)) {
        const pretty = AGENT_NAMES[name as AgentType] || name;
        if (entry.installed) {
          console.log(`  ${chalk.green('ready')}  ${pretty.padEnd(10)} ${chalk.gray(entry.path || '')}`);
        } else {
          console.log(`  ${chalk.red('no   ')}  ${pretty.padEnd(10)} ${chalk.gray(entry.error || 'not installed')}`);
        }
      }
    });
}
