/**
 * Team management commands for organizing multi-agent collaboration.
 *
 * Implements `agents teams` -- create named teams, add teammates (background
 * agent processes), check status with session-aware previews, manage DAG
 * dependencies between teammates, and clean up when work is done.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { die, relTime, truncate, isJsonMode, padRight } from '../lib/format.js';
import * as fs from 'fs/promises';
import { addHostOption } from '../lib/hosts/option.js';
import * as path from 'path';
import {
  AgentManager,
  AgentStatus,
  checkCliSignedIn,
  collectTeamsDoctorData,
  getAgentsDir,
  VALID_TASK_TYPES,
  type AgentType,
  type TaskType,
  type TeamsDoctorEntry,
} from '../lib/teams/agents.js';
import { mailboxDir, enqueue } from '../lib/mailbox.js';
import { resolveProvider } from '../lib/cloud/registry.js';
import type { CloudProviderId, DispatchOptions } from '../lib/cloud/types.js';
import { emit } from '../lib/events.js';
import { runSupervisor } from '../lib/teams/supervisor.js';
import { debug } from '../lib/teams/debug.js';
import {
  runPrWatch,
  DEFAULT_MAX_WAVES,
  type WatchTarget,
  type PrWatchSpawnAction,
  type PrWatchEvent,
} from '../lib/teams/pr-watch.js';
import {
  handleSpawn,
  handleStatus,
  handleStop,
  handleTasks,
  toTaskStatusSummary,
  type AgentStatusDetail,
  type AgentStatusSummary,
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
import { resolveHost } from '../lib/hosts/registry.js';
import { sshTargetFor } from '../lib/hosts/types.js';
import { ensureHostReady } from '../lib/hosts/ready.js';
import { remoteShellFor } from '../lib/hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../lib/hosts/remote-os.js';
import { remoteWorktreeDirty, removeRemoteWorktree, ensureRemoteRepo } from '../lib/teams/remoteWorktree.js';
import { getRemoteUrl } from '../lib/git.js';
import { machineId } from '../lib/session/sync/config.js';
import { isVersionInstalled, resolveVersion, resolveVersionAlias, resolveVersionAliasLoose } from '../lib/versions.js';
import { AGENTS, warnAgentDeprecated } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { discoverSessions, parseTimeFilter, resolveSessionById } from '../lib/session/discover.js';
import { renderSessionLog } from './sessions.js';
import type { SessionMeta } from '../lib/session/types.js';
import { buildPreview as buildSessionPreview } from './sessions-picker.js';
import { parseExecEnv } from '../lib/exec.js';
import { checkRunAccountReadiness, type AccountReadiness } from '../lib/rotate.js';
import { teamPicker, printTeamTable, type TeamRow } from './teams-picker.js';
import { itemPicker } from '../lib/picker.js';
import type { AgentProcess } from '../lib/teams/agents.js';
import { profileExists, readProfile } from '../lib/profiles.js';
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
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  droid: 'Droid',
};

const VALID_AGENTS = Object.keys(AGENT_NAMES) as AgentType[];
// 'full' kept as historical alias for 'skip'; normalized to 'skip' downstream.
const VALID_MODES = ['plan', 'edit', 'auto', 'skip', 'full'] as const;
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;
const VALID_CLOUD_PROVIDERS = ['rush', 'codex', 'factory'] as const satisfies readonly CloudProviderId[];

type Mode = (typeof VALID_MODES)[number];
type Effort = (typeof VALID_EFFORTS)[number];

// Auto-enable JSON mode when piped / not a TTY so AI agent consumers get
// parseable output by default.
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


function fullName(type: AgentType, version: string | null | undefined): string {
  const name = AGENT_NAMES[type];
  return version ? `${name} ${version}` : name;
}

/**
 * Resolve a teammate spec to its execution target.
 *
 * Accepts:
 *  - `claude`            — default version of an installed agent
 *  - `claude@2.1.112`    — pinned version of an installed agent
 *  - `<profile-name>`    — runs through `agents run <profile>`, with the
 *                          profile's host agent used as the underlying
 *                          AgentType for event parsing and CLI checks.
 *
 * `agent` is always the underlying harness so event parsers, CLI-availability
 * checks, and version pins keep working. `profileName` is set only when the
 * spec resolved through a profile.
 */
function parseTeammate(spec: string): {
  agent: AgentType;
  version: string | null;
  profileName: string | null;
} {
  const [name, version] = spec.split('@');

  if (VALID_AGENTS.includes(name as AgentType)) {
    const agent = name as AgentType;
    return {
      agent,
      version: resolveVersionAlias(agent as AgentId, version) ?? null,
      profileName: null,
    };
  }

  // Not a built-in agent id — try resolving as a profile name. A profile
  // pinning a version is allowed; `profile@<override>` is not (would conflict
  // with the profile's own host.version).
  if (!version && profileExists(name)) {
    try {
      const profile = readProfile(name);
      return {
        agent: profile.host.agent as AgentType,
        version: profile.host.version ?? null,
        profileName: profile.name,
      };
    } catch (err) {
      die(`Profile '${name}' is malformed: ${(err as Error).message}`);
    }
  }

  die(
    `Unknown teammate '${spec}'. Available agents: ${VALID_AGENTS.join(', ')}.\n` +
      `  Use 'claude', 'kimi@latest', 'kimi@0.19.2' (a version from 'agents view'), or a profile name.`
  );
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Where `teams message`/`teams resume` routes a follow-up, by teammate status. */
export type TeamMessageRoute =
  | { kind: 'steer' }        // running -> mailbox, delivered at next tool call
  | { kind: 'resume' }       // stopped/completed/failed -> re-enter its session
  | { kind: 'need-message' } // actionable, but no message was supplied
  | { kind: 'not-started' }; // pending --after deps, never launched

/**
 * Decide how a follow-up to a teammate is delivered from its reconciled status.
 * Pure — the source of truth for the routing table, unit-tested without I/O.
 *   - pending                       -> not-started (tell them to `teams start`)
 *   - running     + message         -> steer (mailbox)
 *   - stopped/etc + message         -> resume (re-enter session)
 *   - any actionable + no message   -> need-message
 */
export function decideTeamMessageRoute(status: AgentStatus, hasMessage: boolean): TeamMessageRoute {
  if (status === AgentStatus.PENDING) return { kind: 'not-started' };
  if (!hasMessage) return { kind: 'need-message' };
  if (status === AgentStatus.RUNNING) return { kind: 'steer' };
  return { kind: 'resume' };
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

/**
 * Advisory: warn once per agent type of any still-pending (staged `--after`)
 * teammate whose CLI may not be signed in. Warn-only — never blocks `start`.
 * Local teammates only; cloud teammates authenticate through their provider.
 */
/**
 * Advisory line for a version-pinned teammate whose account can't serve a run
 * right now. A pinned target (`agents run <agent>@<version>`) bypasses account
 * rotation — the pin IS the target — so unlike a bare teammate it can't route
 * around a throttled/expired account; it will launch and likely 429 at once.
 */
function throttleWarningLine(
  agent: AgentType,
  version: string,
  r: Extract<AccountReadiness, { ready: false }>,
): string {
  const who = `${AGENT_NAMES[agent]} ${version}`;
  const acct = r.email ? ` (${r.email})` : '';
  const reason =
    r.reason === 'out_of_credits' ? 'is out of credits'
    : r.reason === 'signed_out' ? 'is not signed in'
    : 'is rate-limited right now';
  return (
    chalk.yellow(`⚠ ${who}${acct} ${reason}.`) +
    chalk.gray(
      `\n  A pinned version skips account rotation, so it will launch on this account and may immediately hit its limit.` +
      `\n  Use a bare \`${agent}\` teammate to let the team pick a healthy account, or pass --force to silence this.`,
    )
  );
}

/**
 * Advisory: for each staged VERSION-PINNED teammate, warn if its account is
 * rate-limited / out of credits / signed out right now — reusing the router's
 * own eligibility signal (`checkRunAccountReadiness`) so the warning matches
 * what the spawn would actually do. Bare teammates (rotation handles them) and
 * profile/cloud teammates (account not locally checkable) are skipped. Warns,
 * never blocks. Deduped by agent@version so N teammates on one account warn once.
 */
async function warnThrottledTeammates(mgr: AgentManager, team: string): Promise<void> {
  let pending;
  try {
    pending = (await mgr.listByTask(team)).filter(
      (a) => a.status === 'pending' && !a.cloudProvider && !a.profileName && a.version,
    );
  } catch {
    return; // team not loadable yet — nothing to warn about
  }
  const seen = new Set<string>();
  for (const a of pending) {
    const agent = a.agentType as AgentType;
    const version = a.version as string;
    const key = `${agent}@${version}`;
    if (seen.has(key) || !AGENT_NAMES[agent]) continue;
    seen.add(key);
    const readiness = await checkRunAccountReadiness(agent, version);
    if (!readiness.ready) console.error(throttleWarningLine(agent, version, readiness));
  }
}

async function warnUnsignedTeammates(mgr: AgentManager, team: string): Promise<void> {
  let pending;
  try {
    pending = (await mgr.listByTask(team)).filter((a) => a.status === 'pending' && !a.cloudProvider);
  } catch {
    return; // team not loadable yet — nothing to warn about
  }
  const seen = new Set<AgentType>();
  for (const a of pending) {
    const agent = a.agentType as AgentType;
    if (seen.has(agent) || !AGENT_NAMES[agent]) continue;
    seen.add(agent);
    if (!(await checkCliSignedIn(agent))) {
      console.error(
        chalk.yellow(`⚠ ${AGENT_NAMES[agent]} may not be signed in (detection is unreliable). Launching anyway.`) +
          chalk.gray(`\n  If it fails to start, run \`${AGENTS[agent].cliCommand}\` to log in, or pass --force to silence this.`)
      );
    }
  }
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

/**
 * Path to the pr-watch dedupe-state file for a team. Persists the set of
 * already-handled check/comment dedupe keys so a restart of `teams pr-watch`
 * never re-spawns a fix wave for a failure it already reacted to. Lives in the
 * teammate base dir; it's a flat file so loadExistingAgents (dir-only) skips it.
 */
async function prWatchStatePath(team: string): Promise<string> {
  const safe = team.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(await getAgentsDir(), `pr-watch-${safe}.json`);
}

interface PrWatchState {
  handled: Set<string>;
  waves: Map<string, number>;
}

async function loadPrWatchState(team: string): Promise<PrWatchState> {
  try {
    const raw = await fs.readFile(await prWatchStatePath(team), 'utf-8');
    const parsed = JSON.parse(raw);
    const handled = new Set(Array.isArray(parsed?.handled) ? (parsed.handled as string[]) : []);
    const waves = new Map<string, number>(
      parsed?.waves && typeof parsed.waves === 'object'
        ? Object.entries(parsed.waves as Record<string, number>).map(([k, v]) => [k, Number(v) || 0])
        : []
    );
    return { handled, waves };
  } catch {
    return { handled: new Set(), waves: new Map() };
  }
}

async function savePrWatchState(team: string, state: PrWatchState): Promise<void> {
  try {
    await fs.writeFile(
      await prWatchStatePath(team),
      JSON.stringify(
        { handled: [...state.handled], waves: Object.fromEntries(state.waves) },
        null,
        2
      )
    );
  } catch (err) {
    debug(`Could not persist pr-watch state for ${team}: ${(err as Error).message}`);
  }
}

/**
 * Resolve the PRs opened by a team's teammates, de-duplicated by PR URL. A
 * teammate's PR URL comes from its own `pr_url` field or, failing that, the
 * session it ran (detected from the transcript's `gh pr create`). The teammate
 * name is the `--after` anchor for the fix/bugfix teammate we spawn.
 */
async function resolvePrWatchTargets(mgr: AgentManager, team: string): Promise<WatchTarget[]> {
  const status = await handleStatus(mgr, team, 'all');
  const sessions = await resolveTeammateSessions(status.agents);
  const byPr = new Map<string, WatchTarget>();
  for (const a of status.agents) {
    const prUrl = a.pr_url || sessions.get(a.agent_id)?.prUrl || null;
    if (!prUrl) continue;
    if (byPr.has(prUrl)) continue; // first teammate to own a PR is its source
    byPr.set(prUrl, { prUrl, sourceTeammate: a.name ?? null });
  }
  return [...byPr.values()];
}

/**
 * React to one decided pr-watch action by spawning a follow-up teammate on the
 * same PR — a ci-fix teammate on RED CI, or a `bugfix` teammate on a new review
 * comment — linked `--after` the teammate that opened the PR so it slots into
 * the same DAG the supervisor already drains. Returns the teammate label.
 */
async function reactWithTeammate(
  mgr: AgentManager,
  team: string,
  action: PrWatchSpawnAction,
  prompt: string,
): Promise<string | null> {
  // Unique name per reaction. The dedupe key is stable across waves (keyed on the
  // check NAME), so the wave number is what keeps successive fixers' names — and
  // their worktrees — distinct within the team.
  const uniq = action.dedupeKey.replace(/[^A-Za-z0-9]/g, '').slice(-10) || `${action.wave}`;
  const slug = `${uniq}-w${action.wave}`;
  const name = action.kind === 'ci-fix' ? `cifix-${slug}` : `bugfix-${slug}`;
  const taskType: TaskType | null = action.kind === 'review-fix' ? 'bugfix' : null;
  // Link --after the source teammate when it's a real, resolvable sibling; a
  // missing source means the PR couldn't be traced to a named teammate, so the
  // fix runs immediately with no dependency edge.
  const after: string[] = [];
  if (action.sourceTeammate) {
    const resolved = await mgr.resolveAgentIdInTask(team, action.sourceTeammate);
    if (resolved.kind === 'ok') after.push(action.sourceTeammate);
  }
  // Isolate each fixer in its own worktree so concurrent `gh pr checkout`s (across
  // PRs, or across waves) never clash in a shared cwd. Requires a git repo — which
  // pr-watch always is, since it operates on PRs; fall back to the cwd only when
  // the checkout somehow isn't a repo.
  const baseCwd = process.cwd();
  let worktreeName: string | null = null;
  let worktreePath: string | null = null;
  let cwd = baseCwd;
  if (await isGitRepo(baseCwd)) {
    try {
      worktreeName = `prwatch-${name}`;
      worktreePath = await createWorktree(baseCwd, worktreeName);
      cwd = worktreePath;
    } catch (err) {
      debug(`pr-watch: could not create worktree for ${name}: ${(err as Error).message}`);
      worktreeName = null;
      worktreePath = null;
      cwd = baseCwd;
    }
  }
  const result = await handleSpawn(
    mgr,
    team,
    'claude',
    prompt,
    cwd,
    'edit',
    'medium',
    null,
    cwd,
    null,
    name,
    after,
    null,
    null,
    taskType,
    null,
    null,
    null,
    null,
    worktreeName,
    worktreePath,
  );
  return result.name ?? shortId(result.agent_id);
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
  if (a.host) {
    console.log(`    ${chalk.gray('host    ')} ${chalk.cyan(a.host)}`);
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

// Default compact renderer — one block per teammate, optimized for the
// orchestrator scanning "what state, what did you touch, what did you say
// last." Caller passes the projected AgentStatusSummary; for the full
// verbose layout use printAgentDetail above.
function printAgentSummary(s: AgentStatusSummary): void {
  const label = statusColor(s.status)(s.status.toUpperCase());
  const handle = s.name ?? shortId(s.agent_id);
  const ident = s.name ? chalk.gray(`(${shortId(s.agent_id)})`) : '';
  const duration = s.duration ? `${chalk.gray(' · ')}${chalk.white(s.duration)}` : '';
  const errBadge = s.has_errors ? chalk.red(' !') : '';
  const tools = chalk.gray(` · ${s.tool_count} tools`);
  const hostBadge = s.host ? chalk.gray(' · on ') + chalk.cyan(s.host) : '';
  console.log(
    `  ${chalk.cyan(handle.padEnd(14))} ${ident.padEnd(11)} ${label}${duration}${tools}${hostBadge}${errBadge}`
  );

  // Files: counts + basenames. Read is count only.
  const fileLines: string[] = [];
  const renderCat = (label: string, cat: { count: number; names: string[] }) => {
    if (cat.count === 0) return;
    const more = cat.count > cat.names.length ? ` +${cat.count - cat.names.length}` : '';
    const names = cat.names.length ? ` ${cat.names.join(', ')}${more}` : '';
    fileLines.push(`${label} ${cat.count}${names}`);
  };
  renderCat('modified', s.files.modified);
  renderCat('created',  s.files.created);
  renderCat('deleted',  s.files.deleted);
  if (s.files.read.count > 0) fileLines.push(`read ${s.files.read.count}`);
  if (fileLines.length) {
    console.log(`    ${chalk.gray('files   ')} ${fileLines.join(chalk.gray(' · '))}`);
  }

  // Last 3 bash commands.
  const recentBash = s.bash_commands.slice(-3);
  if (recentBash.length) {
    console.log(`    ${chalk.gray('bash    ')}`);
    for (const cmd of recentBash) {
      console.log(`      ${chalk.gray('$')} ${truncate(cmd, 96)}`);
    }
  }

  // Last messages — first non-empty line of each, truncated.
  if (s.last_messages.length) {
    console.log(`    ${chalk.gray('messages')}`);
    for (const msg of s.last_messages) {
      const firstLine = msg.split(/\r?\n/).find((l) => l.trim()) || '';
      if (firstLine) console.log(`      ${chalk.gray('>')} ${truncate(firstLine, 96)}`);
    }
  }

  if (s.pr_url) console.log(`    ${chalk.gray('PR      ')} ${chalk.cyan(s.pr_url)}`);
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

// Compact default renderer — no session-file dive, no per-teammate
// 15-line preview. One block per teammate, suitable for the orchestrator
// scanning what each agent did. Use `printTeamStatus` (above) for the
// verbose/legacy layout.
function printTeamSummary(
  team: string,
  result: import('../lib/teams/api.js').TaskStatusSummaryResult
): void {
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
    const width = Math.min(process.stdout.columns || 80, 80);
    const divider = chalk.gray('┈'.repeat(width));
    for (let i = 0; i < agents.length; i++) {
      console.log();
      if (i > 0) {
        console.log(divider);
        console.log();
      }
      printAgentSummary(agents[i]);
    }
  }
  console.log();
  console.log(chalk.gray(`cursor: ${result.cursor}`));
  console.log(chalk.gray('Full detail: agents teams status ' + team + ' --verbose'));
  console.log(chalk.gray('Raw log:     agents teams logs --team ' + team + ' --teammate <name>'));
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

      # Nudge a teammate that stopped with more to do — resumes its own session
      agents teams resume pricing-page backend "Review's in — rebase-merge the PR, then release"

      # Steer a still-running teammate mid-flight (delivered at its next tool call)
      agents teams message pricing-page qa "Skip the flaky screenshot test for now"

      # Wind everyone down when shipped
      agents teams disband pricing-page
    `,
    notes: `
      A team is a named group of agents working in the background on a shared task.
      Teammate sessions show in 'agents sessions --teams' tagged [team/name · mode].

      Teammate syntax:
        'claude'           the default Claude version on this machine
        'claude@2.1.112'   a specific installed version (see 'agents view')
        '<profile>'        a profile from 'agents view' — runs through 'agents
                           run <profile>' with the profile's host harness

      Short aliases:
        teams c  = create    teams a  = add       teams s  = status
        teams rm = remove    teams d  = disband   teams ls = list
    `,
  });

  // list
  addHostOption(teams.command('list [query]'))
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
  addHostOption(teams.command('create <team>'))
    .aliases(['c', 'new'])
    .description('Start a new team. No teammates yet; add them with `teams add`.')
    .option('-d, --description <text>', 'One-line summary of what this team is working on')
    .option('--enable-worktrees', 'Each teammate works in its own git worktree (requires --worktree on add)')
    .option('--use-worktree <path>', 'All teammates share this existing worktree path (mutually exclusive with --enable-worktrees)')
    .option('--devices <list>', 'Pool of machines this team may run teammates on (comma-separated). Enables distributed auto-scheduling.')
    .option('--hosts <list>', 'Alias for --devices.')
    .option('--repo <urlOrPath>', 'How each device gets the code (git URL to clone, or a path). Defaults to the local checkout origin.')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string, opts: { description?: string; enableWorktrees?: boolean; useWorktree?: string; devices?: string; hosts?: string; repo?: string; json?: boolean }) => {
      try {
        // --devices / --hosts are aliases; commander can't express a two-name
        // option that isn't a short flag, so merge them here. Split on comma,
        // trim, drop blanks, dedupe (preserving first-seen order).
        const rawPool = [opts.devices, opts.hosts].filter(Boolean).join(',');
        const devices: string[] = [];
        for (const d of rawPool.split(',').map((s) => s.trim()).filter(Boolean)) {
          if (!devices.includes(d)) devices.push(d);
        }

        // Validate every pooled device resolves + is POSIX (v1 remote monitor is
        // POSIX-only). A device equal to the local machine is fine (runs local),
        // so skip the resolve/POSIX check for it.
        for (const name of devices) {
          if (name.toLowerCase() === machineId()) continue;
          const host = await resolveHost(name);
          if (!host) {
            die(
              `Couldn't resolve pool device "${name}". Register it with \`agents devices\`, ` +
                `enroll it with \`agents hosts add ${name}\`, or pass user@host.`,
            );
          }
          if (remoteShellFor(host.os ?? resolveRemoteOsSync(host.name)) === 'powershell') {
            die(
              `Distributed teams on Windows device "${host.name}" are not supported yet — ` +
                `the teams remote monitor is POSIX-only. Use a Linux/macOS device.`,
            );
          }
        }

        // --repo: how each device gets the code. Default to the local checkout's
        // origin when a pool is declared and we're inside a git repo, so the user
        // never hand-manages a path per box. A poolless team leaves repo unset.
        let repo = opts.repo;
        if (!repo && devices.length > 0) {
          const cwd = process.cwd();
          if (await isGitRepo(cwd)) {
            const origin = await getRemoteUrl(cwd);
            if (origin) repo = origin;
          }
        }

        const meta = await createTeam(team, {
          description: opts.description,
          enableWorktrees: opts.enableWorktrees,
          useWorktree: opts.useWorktree,
          devices,
          repo,
        });
        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ team, ...meta }, null, 2));
          return;
        }
        console.log(chalk.green(`New team: ${chalk.cyan(team)}`));
        if (meta.description) console.log(chalk.gray(`  ${meta.description}`));
        if (meta.enable_worktrees) console.log(chalk.gray(`  worktrees: per-teammate`));
        if (meta.use_worktree) console.log(chalk.gray(`  worktree: ${meta.use_worktree}`));
        if (meta.devices && meta.devices.length) console.log(chalk.gray(`  devices: ${meta.devices.join(', ')}`));
        if (meta.repo) console.log(chalk.gray(`  repo: ${meta.repo}`));
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
  addHostOption(teams.command('add <team> <teammate> <task>'))
    .alias('a')
    .description("Add a teammate to work on a task. Runs in background; returns immediately. Use 'status' to check in.")
    .option('-n, --name <name>', 'Friendly name for this teammate (e.g. alice). Required if using --after. Unique within team.')
    .option('-m, --mode <mode>', `Permissions: plan (read-only) | edit (can write files) | auto (smart classifier auto-approves safe ops) | skip (bypass all permission prompts). 'full' accepted as alias for skip. Teammates run headless: plan works headless on claude/codex/droid/opencode; kimi/grok/cursor/antigravity have no headless plan mode and auto-downgrade a plan request to auto.`, 'edit')
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
    .option('--force', "Skip the advisory 'may not be signed in' / 'account throttled' warnings")
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string, teammate: string, task: string, opts: {
      name?: string; mode: string; effort: string; model?: string; env: string[];
      cwd?: string; worktree?: string; after?: string; json?: boolean;
      taskType?: string; cloud?: string; host?: string; device?: string; repo?: string; branch?: string; force?: boolean;
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

      // Auto-create the team if it doesn't exist yet (friendlier UX than erroring),
      // then load its metadata — needed here for the distributed --repo (how each
      // device gets the code) before we resolve a per-teammate --device pin.
      await ensureTeam(team);
      const teamMeta = await getTeam(team);

      // `--device`/`--host` are aliases (addHostOption registers both). For `teams
      // add` the passthrough special-cases them as PLACEMENT, not routing, so the
      // local action reads them here. Reject a conflicting pair.
      const explicitDevice = (() => {
        const h = opts.host;
        const d = opts.device;
        if (h && d && h !== d) {
          die('Conflicting --host/--device values — pass just one.');
        }
        return h ?? d ?? null;
      })();

      // Distributed teams: --device <name> PINS this teammate to a machine over
      // SSH. Resolve + validate the placement here so a bad target fails at `add`
      // time, not silently at launch. Persisted (hostName/hostTarget/repoPath) so
      // startReady()/launchRemoteProcess dispatch over SSH. Unpinned teammates
      // leave these null — the launch-time scheduler resolves the pool cascade.
      let hostName: string | null = null;
      let hostTarget: string | null = null;
      let hostRepoPath: string | null = null;
      if (explicitDevice && explicitDevice.toLowerCase() !== machineId()) {
        if (cloudProviderId) {
          die(`--device and --cloud are mutually exclusive (two different remote backends). Pick one.`);
        }
        const host = await resolveHost(explicitDevice);
        if (!host) {
          die(
            `Couldn't resolve --device "${explicitDevice}". Register it with \`agents devices\`, ` +
              `enroll it with \`agents hosts add ${explicitDevice}\`, or pass user@host.`,
          );
        }
        // POSIX-only in v1: the remote follow/monitor layer offset-tails the log
        // with tail/cat/kill, which don't exist under PowerShell. Refuse Windows
        // up front, mirroring dispatch.ts launchDetached.
        if (remoteShellFor(host.os ?? resolveRemoteOsSync(host.name)) === 'powershell') {
          die(
            `Distributed teammates on Windows host "${host.name}" are not supported yet — ` +
              `the teams remote monitor is POSIX-only (offset-tails the remote log with tail/cat/kill). ` +
              `Use a Linux/macOS host, or run this teammate locally.`,
          );
        }
        try {
          hostTarget = sshTargetFor(host);
        } catch (err) {
          die(`Can't resolve an ssh target for "${host.name}": ${(err as Error).message}`);
        }
        // Ensure agents-cli is present + version-matched on the host; surface
        // (not fail on) an agent-not-installed warning, like the run --host path.
        try {
          const { warnings } = ensureHostReady(host, { agent: parseTeammate(teammate).agent });
          for (const w of warnings) process.stderr.write(chalk.yellow(`[teams] warning: ${w}\n`));
        } catch (err) {
          die(`Host "${host.name}" is not ready: ${(err as Error).message}`);
        }
        // Provision the repo on the host from the team's --repo (clone into
        // ~/.agents/repos/<team> or reuse an existing checkout), resolving to the
        // ABSOLUTE git root so every later remote command works from an absolute
        // path (dispatch `cd`, worktree create, polling). When the team has no
        // --repo (the common "just send one teammate elsewhere" case, created
        // without a pool), fall back to THIS checkout's origin so the headline case
        // works with zero extra flags whenever you run `add` inside a git repo.
        let effectiveRepo = teamMeta?.repo ?? '';
        if (!effectiveRepo && (await isGitRepo(process.cwd()))) {
          effectiveRepo = (await getRemoteUrl(process.cwd())) ?? '';
        }
        try {
          hostRepoPath = ensureRemoteRepo(hostTarget!, effectiveRepo, team);
        } catch (err) {
          die(
            `Couldn't provision the repo on "${host.name}": ${(err as Error).message}\n` +
              `  Set how each device gets the code with: agents teams create ${team} --repo <url|path>`,
          );
        }
        hostName = host.name;
      }

      const { agent, version, profileName } = parseTeammate(teammate);
      warnAgentDeprecated(agent);
      // Version-installed check is about the LOCAL machine — a distributed (--on)
      // teammate's agent/version lives on the host, verified by ensureHostReady.
      if (version && !hostName && !isVersionInstalled(agent, version)) {
        die(
          `${AGENT_NAMES[agent]} ${version} isn't installed.\n` +
            `  Install it:  agents add ${agent}@${version}\n` +
            `  Or see what's installed (incl. @latest):  agents view ${agent}`
        );
      }

      // Advisory sign-in check: warn but NEVER block. Detection is unreliable
      // for opaque-cred agents, so a false negative must not stop a team. Cloud
      // dispatch authenticates through the provider, not the local CLI — skip it.
      // Distributed (--on) teammates authenticate on the host, not locally — skip.
      if (!opts.force && !cloudProviderId && !hostName && !(await checkCliSignedIn(agent))) {
        console.error(
          chalk.yellow(`⚠ ${AGENT_NAMES[agent]} may not be signed in (detection is unreliable). Adding anyway.`) +
            chalk.gray(`\n  If it fails to start, run \`${AGENTS[agent].cliCommand}\` to log in, or pass --force to silence this.`)
        );
      }

      // Advisory throttle check — only for a version-pinned teammate, which
      // bypasses account rotation and so can't route around a rate-limited /
      // out-of-credits / signed-out account (see throttleWarningLine). Skip bare
      // targets (rotation handles them), profiles (auth-injected account isn't
      // the version-home one we can read), and cloud dispatch. Warn, never block.
      if (!opts.force && !cloudProviderId && !hostName && !profileName && version) {
        const readiness = await checkRunAccountReadiness(agent, version);
        if (!readiness.ready) console.error(throttleWarningLine(agent, version, readiness));
      }

      if (opts.name !== undefined) {
        if (!opts.name || !/^[A-Za-z0-9_-]+$/.test(opts.name)) {
          die(`Invalid teammate name '${opts.name}'. Use letters, numbers, '-', or '_'.`);
        }
      }

      if (opts.worktree !== undefined) {
        if (!opts.worktree || !/^[A-Za-z0-9_-]+$/.test(opts.worktree)) {
          die(`Invalid worktree name '${opts.worktree}'. Use letters, numbers, '-', or '_'.`);
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

      // Team already ensured + loaded above (teamMeta) for the --repo provisioning.
      const worktreesEnabled = teamMeta?.enable_worktrees ?? false;
      const sharedWorktree = teamMeta?.use_worktree ?? null;
      let worktreeName: string | null = null;
      let worktreePath: string | null = null;

      if (hostName) {
        // Distributed teammate: the checkout lives on the host, so we NEVER touch
        // the local filesystem here. A shared local worktree makes no sense for a
        // remote teammate; a per-teammate worktree is created ON THE HOST at launch
        // (createRemoteWorktree in launchRemoteProcess) — we just capture its name.
        if (sharedWorktree) {
          die(`Team '${team}' uses a shared local --use-worktree, which can't apply to a --device (remote) teammate.`);
        }
        if (worktreesEnabled) {
          if (!opts.worktree) {
            die(`Team '${team}' has worktrees enabled. Use --worktree <name> for the remote teammate (created on ${hostName}).`);
          }
          if (!opts.name) {
            die(`Team '${team}' has worktrees enabled. Use --name <name> to identify this teammate.`);
          }
          worktreeName = opts.worktree;
        } else if (opts.worktree) {
          die(`--worktree requires --enable-worktrees on the team. Recreate the team with: agents teams create ${team} --enable-worktrees`);
        }
        // Local cwd stays null — the remote cwd is repoPath / the remote worktree.
      } else if (sharedWorktree) {
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

      // Distributed teammates have no LOCAL cwd — their working dir lives on the
      // host (repoPath / the remote worktree). Local teammates default to the
      // worktree path, then --cwd, then the current directory.
      const cwd = hostName ? null : (worktreePath ?? opts.cwd ?? process.cwd());
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
          worktreePath,
          profileName,
          hostName,
          hostTarget,
          hostRepoPath,
        );

        emit('teams.add', { module: 'teams', team, agent, name: result.name, agent_id: result.agent_id, status: result.status });

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const who = profileName ? `${profileName} (via ${fullName(agent, version)})` : fullName(agent, version);
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
        console.log(`  ${chalk.gray('working ')}  ${hostName ? hostRepoPath : cwd}`);
        if (hostName) {
          console.log(`  ${chalk.gray('host    ')}  ${chalk.cyan(hostName)}${chalk.gray(` (${hostTarget})`)}`);
        }
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
          if (after.length > 0) {
            process.stderr.write(
              chalk.yellow(
                `\nWarning: this teammate has --after dependencies and will NEVER start on its own.\n` +
                `  A supervisor watch process is required to launch it when its deps complete.\n` +
                `  Run this in another terminal:\n` +
                `    agents teams start ${team} --watch\n`
              )
            );
          }
        } else {
          console.log(chalk.gray(`Check in later:  agents teams status ${team}`));
        }
      } catch (err) {
        die(`Could not add ${fullName(agent, version)} to ${team}: ${(err as Error).message}`);
      }
    });

  // status
  addHostOption(teams.command('status [team]'))
    .aliases(['s', 'st', 'check'])
    .description("Check in on a team: status, files touched, recent commands, last messages. Pass --verbose for the full per-teammate dump; --since for delta polling.")
    .option('-f, --filter <state>', 'Show only teammates in this state: running, completed, failed, stopped, or all (default: all)', 'all')
    .option('-s, --since <iso>', 'Cursor from a previous status call; only show updates after this timestamp (enables efficient polling)')
    .option('--agent-id <id>', 'Show only this one teammate (by UUID or UUID prefix)')
    .option('-v, --verbose', 'Emit the full per-teammate detail (prompt, all file paths, all messages). Default is a compact summary.')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string | undefined, opts: {
      filter: string; since?: string; agentId?: string; json?: boolean; verbose?: boolean;
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
        const filtered = { ...result, agents };

        if (isJsonMode(opts)) {
          // JSON output also respects --verbose. Default = compact summary
          // shape; --verbose = full AgentStatusDetail. Same toggle covers
          // both text and JSON so MCP-style consumers can opt into detail.
          const payload = opts.verbose
            ? filtered
            : toTaskStatusSummary(filtered);
          console.log(JSON.stringify(payload, null, 2));
          return;
        }

        const exists = await teamExists(team);
        if (!exists && result.agents.length === 0) {
          console.log(chalk.yellow(`No team called '${team}'. Create it with: agents teams create ${team}`));
          return;
        }

        if (opts.verbose) {
          await printTeamStatus(team, filtered);
        } else {
          printTeamSummary(team, toTaskStatusSummary(filtered));
        }
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
          host: a.hostName,
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
          // A distributed teammate has no local pid; show its host + remote pid.
          const pidStr = a.hostName
            ? chalk.cyan(`on ${a.hostName}`) + (a.remotePid ? chalk.gray(` (pid ${a.remotePid})`) : '')
            : a.pid ? chalk.yellow(`pid ${a.pid}`) : chalk.gray('pid ?');
          const started = chalk.gray(relTime(a.startedAt.toISOString()));
          console.log(`  ${chalk.magenta(padRight(fullName(a.agentType, a.version), 18))}  ${chalk.white(padRight(ident, 20))}  ${pidStr}  ${started}`);
        }
        console.log();
      }
      console.log(chalk.gray(`${running.length} teammate${running.length === 1 ? '' : 's'} running. See 'agents sessions --active' for the full cross-context view.`));
    });

  // start — fire any staged teammates whose --after deps have all completed
  addHostOption(teams.command('start [team]'))
    .description('Launch any pending teammates whose --after dependencies are satisfied. Use --watch to keep draining the DAG as teammates finish and as new tasks are added mid-flight.')
    .option('--json', 'Output machine-readable JSON')
    .option('--watch', 'Keep running: poll every --interval seconds, fire new waves, exit when the DAG drains.')
    .option('--interval <seconds>', 'Seconds between waves in --watch mode (default 8)', '8')
    .option('--max-waves <n>', 'Safety cap on waves in --watch mode (default 1000)', '1000')
    .option('--force', "Skip the advisory 'may not be signed in' / 'account throttled' warnings for staged teammates")
    .action(async (team: string | undefined, opts: { json?: boolean; watch?: boolean; interval: string; maxWaves: string; force?: boolean }) => {
      const mgr = mkManager();
      wireCloudDispatcher(mgr);

      if (!team) {
        const picked = await pickTeamOr(mgr, 'agents teams start');
        if (!picked) return;
        team = picked;
      }

      if (!opts.force && !isJsonMode(opts)) {
        await warnUnsignedTeammates(mgr, team);
        await warnThrottledTeammates(mgr, team);
      }

      emit('teams.start', { module: 'teams', team, watch: Boolean(opts.watch) });

      if (!opts.watch) {
        await runOneWave(mgr, team, Boolean(opts.json));
        return;
      }

      const intervalMs = Math.max(1000, Number.parseInt(opts.interval, 10) * 1000 || 8000);
      const maxWaves = Math.max(1, Number.parseInt(opts.maxWaves, 10) || 1000);
      const json = isJsonMode(opts);

      // Live budget kill-switch (issue #399). Dormant when no caps set — the
      // factory dropping this in returns null and runSupervisor short-circuits.
      const { createTeamBudgetWatcher } = await import('../lib/budget/live-team.js');
      const budgetWatcher = createTeamBudgetWatcher({
        manager: mgr,
        team,
        cwd: process.cwd(),
        onBreach: (b) => {
          process.stderr.write(
            `[budget] cap ${b.cap} exceeded ($${b.spend.toFixed(2)} > $${b.limit.toFixed(2)}) — stopping team ${team}\n`,
          );
        },
      });

      const result = await runSupervisor(mgr, {
        team,
        intervalMs,
        maxWaves,
        budgetWatcher,
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
      emit('teams.complete', { module: 'teams', team, stoppedBy: result.stoppedBy, waves: result.waves, durationMs: result.elapsed_ms });

      if (result.stoppedBy === 'drained') {
        console.log(chalk.green(`Factory drained in ${elapsed}s (${result.waves} waves).`));
      } else if (result.stoppedBy === 'max-waves') {
        console.error(chalk.yellow(`Hit --max-waves=${maxWaves}; stopping. Re-run to continue.`));
      } else if (result.stoppedBy === 'signal') {
        console.error(chalk.yellow(`Stopped by signal after ${result.waves} waves.`));
      } else if (result.stoppedBy === 'budget') {
        const b = result.budgetBreach;
        console.error(chalk.red(
          `Budget kill-switch tripped after ${result.waves} waves` +
            (b ? ` (cap ${b.cap}: $${b.spend.toFixed(2)} > $${b.limit.toFixed(2)})` : '') +
            `.`,
        ));
        process.exitCode = 7; // Mirrors BUDGET_KILL_EXIT_CODE for CI/headless.
      }
    });

  // pr-watch — autonomous PR lifecycle (issue #338)
  addHostOption(teams.command('pr-watch [team]'))
    .description('Watch the PRs a team opened and react autonomously: RED CI -> spawn a fix teammate with the failure logs; new review comment -> route a bugfix teammate. Both slot into the team DAG (visible in `teams status`).')
    .option('--interval <seconds>', 'Seconds between polls (default 30)', '30')
    .option('--max-polls <n>', 'Stop after this many polls (default: run until Ctrl-C)', '0')
    .option('--max-waves <n>', `Fix waves per PR before escalating to a human (default ${DEFAULT_MAX_WAVES})`, String(DEFAULT_MAX_WAVES))
    .option('--once', 'Poll a single time and exit (equivalent to --max-polls 1)')
    .option('--json', 'Emit one JSON line per pr-watch event')
    .action(async (team: string | undefined, opts: { interval: string; maxPolls: string; maxWaves: string; once?: boolean; json?: boolean }) => {
      const mgr = mkManager();

      if (!team) {
        const picked = await pickTeamOr(mgr, 'agents teams pr-watch');
        if (!picked) return;
        team = picked;
      }
      const resolvedTeam = team;

      const intervalMs = Math.max(1000, (Number.parseInt(opts.interval, 10) || 30) * 1000);
      const maxPolls = opts.once ? 1 : Math.max(0, Number.parseInt(opts.maxPolls, 10) || 0);
      const maxWaves = Math.max(1, Number.parseInt(opts.maxWaves, 10) || DEFAULT_MAX_WAVES);
      const json = isJsonMode(opts);

      const { handled, waves } = await loadPrWatchState(resolvedTeam);

      let stopSignal = false;
      const onSig = () => { stopSignal = true; };
      process.once('SIGINT', onSig);
      process.once('SIGTERM', onSig);

      const emit = (e: PrWatchEvent) => {
        if (json) { console.log(JSON.stringify(e)); return; }
        const ts = e.timestamp.slice(11, 19);
        if (e.type === 'poll') {
          console.log(`[${ts}] polled ${chalk.cyan(resolvedTeam)} — ${e.targets} PR(s) under watch`);
        } else if (e.type === 'spawned') {
          const verb = e.action.kind === 'ci-fix' ? 'CI-fix' : 'bugfix';
          const detail = e.action.kind === 'ci-fix'
            ? `check ${chalk.yellow(e.action.check.name)}`
            : `comment ${chalk.yellow('#' + e.action.comment.id)}`;
          console.log(
            `[${ts}] ${chalk.green('spawned')} ${verb} teammate ${chalk.cyan(e.label ?? '?')} ` +
            `(wave ${e.action.wave}/${maxWaves}) for ${detail} on ${e.action.prUrl}`
          );
        } else if (e.type === 'needs-human') {
          console.error(
            `[${ts}] ${chalk.red('needs human')} — ${e.prUrl} still failing after ${e.waves} wave(s) ` +
            `(${e.subject}). Not spawning again; hand it to a human.`
          );
        } else if (e.type === 'error') {
          console.error(`[${ts}] ${chalk.red('error')} on ${e.prUrl}: ${e.message}`);
        }
      };

      // A fixer's dedupe guard clears once it settles, so a still-red check can
      // spawn its next (budget-bounded) wave. Terminal = completed/failed/stopped.
      const reactionSettled = async (label: string): Promise<boolean> => {
        const roster = await mgr.listByTask(resolvedTeam);
        const teammate = roster.find((a) => a.name === label || shortId(a.agentId) === label);
        if (!teammate) return false;
        const s = String(teammate.status);
        return s === 'completed' || s === 'failed' || s === 'stopped';
      };

      try {
        const result = await runPrWatch(
          {
            resolveTargets: async () => {
              // Drive the DAG each pass so fix/bugfix teammates staged --after a
              // now-completed source teammate actually launch — no separate
              // `teams start --watch` needed.
              await mgr.rescanFromDisk();
              await mgr.startReady(resolvedTeam);
              return resolvePrWatchTargets(mgr, resolvedTeam);
            },
            react: (action, prompt) => reactWithTeammate(mgr, resolvedTeam, action, prompt),
            reactionSettled,
            onEvent: emit,
          },
          {
            intervalMs,
            maxPolls,
            maxWaves,
            handled,
            waves,
            shouldStop: () => stopSignal,
          }
        );
        await savePrWatchState(resolvedTeam, { handled: result.handled, waves: result.waves });
        if (!json) {
          const humanNote = result.neededHuman > 0
            ? ` ${result.neededHuman} PR(s) escalated to a human.`
            : '';
          console.log(
            chalk.gray(
              `pr-watch stopped (${result.stoppedBy}) after ${result.polls} poll(s); ` +
              `spawned ${result.spawned} follow-up teammate(s).${humanNote}`
            )
          );
          console.log(chalk.gray(`Check the team:  agents teams status ${resolvedTeam}`));
        }
      } finally {
        process.off('SIGINT', onSig);
        process.off('SIGTERM', onSig);
      }
    });

  // stop
  addHostOption(teams.command('stop [team] [teammate]'))
    .description('Stop a running teammate. Resume it later with `agents teams resume`. Cleans up worktree if no uncommitted changes.')
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
          if (agent.hostName && agent.hostTarget && agent.repoPath) {
            // Distributed teammate: guard + remove the worktree ON THE HOST.
            if (remoteWorktreeDirty(agent.hostTarget, agent.worktreePath)) {
              worktreeKept = true;
            } else {
              removeRemoteWorktree(agent.hostTarget, agent.repoPath, agent.worktreeName);
            }
          } else {
            const dirty = await hasUncommittedChanges(agent.worktreePath);
            if (dirty) {
              worktreeKept = true;
            } else {
              const baseCwd = process.cwd();
              await removeWorktree(baseCwd, agent.worktreeName);
            }
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

  // message / resume — send a follow-up message to a teammate. Routes by the
  // teammate's reconciled status: a RUNNING teammate is STEERED via its mailbox
  // (delivered at its next tool call); a STOPPED one (completed/failed/stopped)
  // is RESUMED — re-entering its own session with the message as the next user
  // turn, re-attaching it to the team as live.
  async function teamMessageAction(
    team: string,
    ref: string,
    message: string | undefined,
    opts: { json?: boolean; from?: string },
  ): Promise<void> {
    const mgr = mkManager();

    const lookup = await mgr.resolveAgentIdInTask(team, ref);
    if (lookup.kind === 'none') die(`No teammate matching '${ref}' in team ${team}`, 2);
    if (lookup.kind === 'ambiguous') {
      const shorts = lookup.matches.map(shortId).join(', ');
      die(`'${ref}' matches multiple teammates: ${shorts}. Use more characters or a name.`, 2);
    }
    const agentId = (lookup as { kind: 'ok'; agentId: string }).agentId;

    // mgr.get reconciles the teammate's status (PID + start-time guard / remote
    // .exit sentinel / exit-code reap) before we branch — so running-vs-stopped
    // is a fact, not a guess.
    const agent = await mgr.get(agentId);
    if (!agent) die(`Teammate ${shortId(agentId)} vanished from team ${team}.`);
    const display = agent!.name || shortId(agentId);
    const status = agent!.status;
    const hasMessage = message != null && message.trim().length > 0;

    const route = decideTeamMessageRoute(status, hasMessage);
    switch (route.kind) {
      case 'not-started':
        die(`Teammate '${display}' hasn't started yet (waiting on --after deps). Run \`agents teams start ${team}\` to launch it.`);
        return;
      case 'need-message':
        if (status === AgentStatus.RUNNING) {
          die(`Teammate '${display}' is running — pass a message to steer it.`);
        }
        die(`Teammate '${display}' is ${status} — pass a message to resume it: \`agents teams resume ${team} ${display} "<message>"\`.`);
        return;
      case 'steer': {
        // Running -> steer via mailbox; never re-launch (that forks a 2nd session).
        enqueue(mailboxDir(agentId), { to: agentId, text: message!, from: opts.from });
        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ team, agent_id: agentId, name: agent!.name ?? null, action: 'steer', status }, null, 2));
          return;
        }
        console.log(
          chalk.green(`Steering ${chalk.cyan(display)} (running) — `) +
            chalk.dim('message queued; it will see it at its next tool call.'),
        );
        return;
      }
      case 'resume': {
        // Stopped / completed / failed -> resume its own session with the message.
        try {
          await mgr.resumeTeammate(agentId, message!);
        } catch (err) {
          die((err as Error).message);
        }
        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ team, agent_id: agentId, name: agent!.name ?? null, action: 'resume', prior_status: status }, null, 2));
          return;
        }
        console.log(
          chalk.green(`Resuming ${chalk.cyan(display)} `) +
            chalk.dim(`(was ${status}) in team ${team} — re-entering its session with your message.`),
        );
        console.log(chalk.dim(`Track it with \`agents teams status ${team}\`.`));
        return;
      }
    }
  }

  addHostOption(teams.command('message <team> <teammate> <message>'))
    .description('Send a follow-up message to a teammate. A running teammate is steered via its mailbox; a stopped one is resumed — re-entering its own session with the message.')
    .option('--from <who>', 'Label recorded as the sender of this message')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string, ref: string, message: string, opts: { json?: boolean; from?: string }) => {
      await teamMessageAction(team, ref, message, opts);
    });

  addHostOption(teams.command('resume <team> <teammate> [message]'))
    .description("Resume a stopped teammate (completed/failed/stopped) by re-entering its own session with a message as the next user turn. If the teammate is still running, the message is steered via its mailbox instead.")
    .option('--from <who>', 'Label recorded as the sender of this message')
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string, ref: string, message: string | undefined, opts: { json?: boolean; from?: string }) => {
      await teamMessageAction(team, ref, message, opts);
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
            if (agent.hostName && agent.hostTarget && agent.repoPath) {
              // Distributed teammate: guard + remove the worktree ON THE HOST.
              if (remoteWorktreeDirty(agent.hostTarget, agent.worktreePath)) {
                keptWorktrees.push(agent.worktreeName);
              } else {
                removeRemoteWorktree(agent.hostTarget, agent.repoPath, agent.worktreeName);
              }
            } else {
              const dirty = await hasUncommittedChanges(agent.worktreePath);
              if (dirty) {
                keptWorktrees.push(agent.worktreeName);
              } else {
                await removeWorktree(baseCwd, agent.worktreeName);
              }
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
    .description("Show a teammate's concise session summary. --full (or -n <lines>) for the raw stdout. Accepts positional name, --teammate <name>, UUID, or UUID prefix.")
    .option('-n, --tail <n>', 'Show the last N lines of raw stdout instead of the concise summary')
    .option('-m, --full', 'Show the full raw stdout log instead of the concise summary')
    .option('--team <team>', 'Disambiguate when the same name appears in multiple teams')
    .option('--teammate <name>', 'Teammate name (alias for the positional arg; useful for scripts)')
    .action(async (ref: string | undefined, opts: { tail?: string; full?: boolean; team?: string; teammate?: string }) => {
      const base = await getAgentsDir();

      // Resolve teammate identity. Precedence:
      //   1. positional `[teammate]` arg (back-compat, most common)
      //   2. --teammate <name> flag (script-friendly alias)
      //   3. interactive picker (TTY only)
      const teammateRef = ref ?? opts.teammate;

      let agentId: string;
      if (!teammateRef) {
        const mgr = mkManager();
        const picked = await pickTeammateOr(mgr, 'agents teams logs');
        if (!picked) return;
        agentId = picked.agentId;
      } else {
        const resolved = await resolveTeammateAcrossTeams(base, teammateRef, opts.team);
        if (resolved.kind === 'none') {
          die(`No notes on record for teammate '${teammateRef}'`, 2);
        }
        if (resolved.kind === 'ambiguous') {
          const hints = resolved.candidates.map((c) => `${c.team}/${c.display}`).join(', ');
          die(
            `'${teammateRef}' matches multiple teammates: ${hints}.\n` +
              `  Narrow it with --team <team>, or pass a UUID prefix.`,
            2
          );
        }
        agentId = resolved.agentId;
      }

      // Concise by default: a teammate's agentId IS its agent session id (passed
      // as --session-id at launch), so render the same summary digest as
      // `agents sessions <id>`. --full / -n <lines> opt into the raw stdout.log.
      if (!opts.full && !opts.tail) {
        const all = await discoverSessions({ all: true, limit: 5000 });
        const matches = resolveSessionById(all, agentId);
        if (matches.length > 0) {
          await renderSessionLog(matches[0], 'summary');
          return;
        }
        // No resolvable session (e.g. a non-Claude teammate) — fall through to a
        // bounded tail of raw stdout rather than dumping the whole file.
      }

      const logPath = path.join(base, agentId, 'stdout.log');
      try {
        const content = await fs.readFile(logPath, 'utf-8');
        if (opts.full) {
          process.stdout.write(content);
          return;
        }
        // Default tail size keeps an un-resolvable teammate's glance bounded too.
        const n = opts.tail ? Math.max(1, parseInt(opts.tail, 10) || 50) : 40;
        const lines = content.split('\n');
        process.stdout.write(lines.slice(-n).join('\n'));
      } catch {
        die(`No notes on record for teammate '${teammateRef ?? agentId}' (looked in ${logPath})`, 2);
      }
    });

  // doctor
  teams
    .command('doctor')
    .alias('dr')
    .description('Check which agents are installed and available to join a team. Verifies CLI paths and shows an advisory sign-in hint.')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const data = await collectTeamsDoctorData();

      if (isJsonMode(opts)) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(chalk.bold('Who can join a team:'));
      for (const [name, entry] of Object.entries(data)) {
        const pretty = AGENT_NAMES[name as AgentType] || name;
        if (entry.installed) {
          const { signedIn, running: isRunning } = entry;
          const hint = isRunning
            ? chalk.gray('in use')
            : signedIn
              ? chalk.gray('signed in')
              : chalk.gray('sign-in unverified');
          console.log(`  ${chalk.green('ready')}  ${pretty.padEnd(10)} ${chalk.gray(entry.path || '')}  ${hint}`);
        } else {
          console.log(`  ${chalk.red('no   ')}  ${pretty.padEnd(10)} ${chalk.gray(entry.error || 'not installed')}`);
        }
      }
    });
}
