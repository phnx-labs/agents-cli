/**
 * Teams agent lifecycle management.
 *
 * Defines the AgentProcess and AgentManager classes that handle spawning,
 * monitoring, stopping, and persisting teammate processes across all supported
 * agent CLIs (Claude, Codex, Gemini, Cursor, OpenCode). Supports DAG-based
 * dependency scheduling via --after, per-teammate model/effort overrides, and
 * multiple permission modes (plan, edit, full).
 */
import { spawn, execSync, execFileSync, ChildProcess } from 'child_process';
import { getAgentsInvocation } from '../daemon.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { resolveAgentsDir } from './persistence.js';
import { findExecutable } from '../platform/index.js';
import { normalizeEvents, AgentType } from './parsers.js';
import { debug } from './debug.js';
import { setGeminiAutoUpdateDisabled, updateGeminiSettings } from '../gemini-settings.js';
import type { AgentId } from '../types.js';
import { getAgentsDir as getSystemAgentsDir, getShimsDir } from '../state.js';
import { AGENTS, getAccountInfo } from '../agents.js';
import { resolveVersion, isVersionInstalled, verifyInstalledBinaryLaunches } from '../versions.js';
import { sanitizeProcessEnv } from '../secrets/bundles.js';
import { recordRunName } from '../session/run-names.js';
import { sshExec, shellQuote } from '../ssh-exec.js';
import { resolveHost } from '../hosts/registry.js';
import { sshTargetFor } from '../hosts/types.js';
import { dispatchAgentsCommand } from '../hosts/dispatch.js';
import { ensureHostReady } from '../hosts/ready.js';
import { remoteShellFor } from '../hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';
import { pullRemoteLogDelta, REMOTE_MIRROR_MAX_BYTES } from '../hosts/progress.js';
import { createRemoteWorktree, ensureRemoteRepo } from './remoteWorktree.js';
import { getTeam } from './registry.js';
import { resolvePlacement } from './scheduler.js';

let lastMemoryWarnAt = 0;

// On macOS, os.freemem() returns only the truly-free pool and ignores the
// large inactive+purgeable cache the kernel will reclaim under pressure, so
// it always looks alarmingly low on a healthy Mac. Parse vm_stat to get the
// real "available" figure: free + inactive + purgeable + speculative.
function availableMemoryBytes(): number {
  if (process.platform !== 'darwin') return os.freemem();
  try {
    const out = execSync('vm_stat', { encoding: 'utf8', timeout: 1000 });
    const pageSizeMatch = out.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
    const grab = (label: string): number => {
      const m = out.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
      return m ? Number(m[1]) : 0;
    };
    const pages =
      grab('Pages free') +
      grab('Pages inactive') +
      grab('Pages purgeable') +
      grab('Pages speculative');
    if (pages <= 0) return os.freemem();
    return pages * pageSize;
  } catch {
    return os.freemem();
  }
}

function warnIfMemoryLow(runningCount: number): void {
  const total = os.totalmem();
  if (total <= 0) return;
  const available = availableMemoryBytes();
  const freeRatio = available / total;
  if (freeRatio >= 0.15) return;
  const now = Date.now();
  if (now - lastMemoryWarnAt < 60_000) return;
  lastMemoryWarnAt = now;
  const freeGb = (available / 1024 ** 3).toFixed(1);
  const totalGb = (total / 1024 ** 3).toFixed(1);
  process.stderr.write(
    `Heads up: only ${freeGb}GB of ${totalGb}GB free with ${runningCount} teammates already running. ` +
      `Spawning more may slow your machine.\n`
  );
}

/**
 * Compute the Lowest Common Ancestor (LCA) of multiple file paths.
 * Returns the deepest common directory shared by all paths.
 * Returns null if paths is empty or paths have no common ancestor (different roots).
 */
export function computePathLCA(paths: string[]): string | null {
  const validPaths = paths.filter(p => p && p.trim());
  if (validPaths.length === 0) return null;
  if (validPaths.length === 1) return validPaths[0];

  // Normalize and split all paths into segments
  const splitPaths = validPaths.map(p => {
    const normalized = path.resolve(p);
    // Split by path separator, filter empty segments
    return normalized.split(path.sep).filter(seg => seg);
  });

  // Find minimum length
  const minLen = Math.min(...splitPaths.map(p => p.length));

  // Find common prefix
  const commonSegments: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const segment = splitPaths[0][i];
    const allMatch = splitPaths.every(p => p[i] === segment);
    if (allMatch) {
      commonSegments.push(segment);
    } else {
      break;
    }
  }

  if (commonSegments.length === 0) return null;

  // Reconstruct path (add leading separator for absolute paths)
  const lca = path.sep + commonSegments.join(path.sep);
  return lca;
}

/** Lifecycle status of a teammate process. */
export enum AgentStatus {
  PENDING = 'pending',     // staged with unresolved --after deps
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  STOPPED = 'stopped',
}

/** Task type label for Software Factory workflows. Drives planner fan-out. Optional — teammates without a task_type work exactly as before. */
export type TaskType = 'plan' | 'implement' | 'test' | 'review' | 'bugfix' | 'docs';
export const VALID_TASK_TYPES: readonly TaskType[] = [
  'plan', 'implement', 'test', 'review', 'bugfix', 'docs',
] as const;

/**
 * Walk the `after` chain from `startName` within the given map; returns true
 * if `targetName` appears anywhere in the transitive dependency closure.
 * Used to detect cycles before adding a new --after edge.
 */
function hasTransitiveDep(
  byName: Map<string, { after: string[] }>,
  startName: string,
  targetName: string,
  seen: Set<string> = new Set()
): boolean {
  if (seen.has(startName)) return false;
  seen.add(startName);
  const node = byName.get(startName);
  if (!node) return false;
  for (const dep of node.after) {
    if (dep === targetName) return true;
    if (hasTransitiveDep(byName, dep, targetName, seen)) return true;
  }
  return false;
}

export type { AgentType } from './parsers.js';

/**
 * Single-quote a string for safe interpolation into a POSIX `sh -c` command.
 * Wraps in single quotes and escapes embedded single quotes via the standard
 * `'\''` close-escape-reopen idiom, so arbitrary prompts/paths can't break out
 * of quoting or inject shell syntax.
 */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap a teammate argv in a POSIX shell command that runs it and then records
 * the real exit code to `exitCodePath`. `echo $?` captures the status of the
 * preceding command, so the sentinel reflects the underlying CLI's exit code,
 * not the shell's. Single source of truth shared by launchProcess() and its
 * test. See reapProcess() for how the sentinel is consumed.
 */
export function buildSentinelCommand(cmd: string[], exitCodePath: string): string {
  return `${cmd.map(shSingleQuote).join(' ')}; echo $? > ${shSingleQuote(exitCodePath)}`;
}

/**
 * Capture a stable identifier for a process at the moment it was started.
 * Used to defeat PID reuse: a kill(pid, ...) is only safe when the process
 * still occupies the PID we observed at spawn time. A bare kill(pid, 0)
 * probe cannot tell whether the OS has recycled the slot to an unrelated
 * process — combined with detached spawns and unref(), that's exactly how
 * `agents teams stop` ends up SIGKILLing random process groups.
 *
 * Linux:  field 22 of /proc/<pid>/stat (starttime in clock ticks since boot).
 * macOS:  output of `ps -o lstart= -p <pid>` (start time in human format).
 * Returns null on any error so callers can skip the guard rather than crash.
 */
export function captureProcessStartTime(pid: number): string | null {
  if (!pid || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const stat = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const lastParen = stat.lastIndexOf(')');
      if (lastParen < 0) return null;
      const tail = stat.slice(lastParen + 2);
      const fields = tail.split(' ');
      // After comm we are at field 3; starttime is field 22, so index 19 here.
      return fields[19] || null;
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Agent types the team runner supports. */
const TEAM_AGENT_TYPES: AgentType[] = ['codex', 'cursor', 'gemini', 'claude', 'opencode', 'grok', 'antigravity', 'kimi', 'droid'];

/**
 * Reasoning-intensity knob. Passed through to `agents run --effort`, which
 * translates it into per-agent reasoning flags (claude --effort, codex
 * model_reasoning_effort override). Mode (plan/edit/full) is a separate knob.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

// Suffix appended to all prompts to ensure agents provide a summary
const PROMPT_SUFFIX = `

When you're done, provide a brief summary of:
1. What you did (1-2 sentences)
2. Key files modified and why
3. Any important classes, functions, or components you added/changed`;

// Prefix for Claude agents in plan mode - explains the headless plan mode restrictions
const CLAUDE_PLAN_MODE_PREFIX = `You are running in HEADLESS PLAN MODE. This mode works like normal plan mode with one exception: you cannot write to ~/.claude/plans/ directory. Instead of writing a plan file, output your complete plan/response as your final message.

`;

// Canonical modes plus the historical `full` alias (rewritten to `skip` by
// normalizeModeValue). Keep `full` listed so user-typed CLI flags and stored
// metadata that pre-date the rename continue to parse.
export const VALID_MODES = ['plan', 'edit', 'auto', 'skip', 'full'] as const;
type Mode = 'plan' | 'edit' | 'auto' | 'skip';

function normalizeModeValue(modeValue: string | null | undefined): Mode | null {
  if (!modeValue) return null;
  const normalized = modeValue.trim().toLowerCase();
  if (normalized === 'full') return 'skip';
  if ((['plan', 'edit', 'auto', 'skip'] as readonly string[]).includes(normalized)) {
    return normalized as Mode;
  }
  return null;
}

function defaultModeFromEnv(): Mode {
  for (const envVar of ['AGENTS_MCP_MODE', 'AGENTS_MCP_DEFAULT_MODE']) {
    const rawValue = process.env[envVar];
    const parsed = normalizeModeValue(rawValue);
    if (parsed) {
      return parsed;
    }
    if (rawValue) {
      console.warn(`Invalid ${envVar}='${rawValue}'. Use plan, edit, auto, or skip. Falling back to plan mode.`);
    }
  }
  return 'plan';
}

function coerceDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      const ms = numeric < 1e12 ? numeric * 1000 : numeric;
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date;
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function extractTimestamp(raw: any): Date | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidates = [
    raw.timestamp,
    raw.time,
    raw.created_at,
    raw.createdAt,
    raw.ts,
    raw.started_at,
    raw.startedAt,
  ];

  for (const candidate of candidates) {
    const date = coerceDate(candidate);
    if (date) return date;
  }

  return null;
}

/** Resolve a mode string to a validated Mode, falling back to the given default. */
export function resolveMode(
  requestedMode: string | null | undefined,
  defaultMode: Mode = 'plan'
): Mode {
  const normalizedDefault = normalizeModeValue(defaultMode);
  if (!normalizedDefault) {
    throw new Error(`Invalid default mode '${defaultMode}'. Use plan, edit, auto, or skip.`);
  }

  if (requestedMode !== null && requestedMode !== undefined) {
    const normalizedMode = normalizeModeValue(requestedMode);
    if (!normalizedMode) {
      throw new Error(`Invalid mode '${requestedMode}'. Valid modes: plan (read-only), edit (can write), auto (smart classifier), skip (bypass all permissions). 'full' is accepted as alias for skip.`);
    }
    return normalizedMode;
  }

  return normalizedDefault;
}

/** Ensure Gemini's settings.json has experimental.plan enabled for headless plan mode. */
export async function ensureGeminiPlanMode(): Promise<void> {
  const settingsPath = path.join(os.homedir(), '.gemini', 'settings.json');
  try {
    let changed = false;
    const settings = updateGeminiSettings(settingsPath, (nextSettings) => {
      setGeminiAutoUpdateDisabled(nextSettings);
      const experimental = typeof nextSettings.experimental === 'object' && nextSettings.experimental !== null
        ? nextSettings.experimental as Record<string, unknown>
        : {};
      if (experimental.plan === true) {
        return;
      }
      nextSettings.experimental = { ...experimental, plan: true };
      changed = true;
    });
    if (changed && settings.experimental && typeof settings.experimental === 'object' && (settings.experimental as Record<string, unknown>).plan === true) {
      console.error('[Swarm] Enabled Gemini experimental.plan in', settingsPath);
    }
  } catch (err) {
    console.warn('[Swarm] Could not enable Gemini plan mode:', err);
  }
}

/**
 * Check whether the CLI binary for a given agent type is installed.
 * Returns [available, pathOrError].
 *
 * The agents-managed shims dir (`~/.agents/.cache/shims`) is the canonical
 * install location, so a shim there means installed regardless of the caller's
 * PATH. Non-interactive callers — the menu-bar helper, cron, CI — run with a
 * minimal launchd PATH that omits the shims dir; a bare PATH lookup false-flags
 * every shim-based CLI as "not installed". Check the shim first, PATH second
 * (for CLIs the user installed outside agents-cli).
 */
export function checkCliAvailable(agentType: AgentType): [boolean, string | null] {
  const agent = agentType as AgentId;
  const executable = AGENTS[agent]?.cliCommand;
  if (!executable) {
    return [false, `Unknown agent type: ${agentType}`];
  }

  const shimPath = path.join(getShimsDir(), executable);
  const dispatch = fsSync.existsSync(shimPath) ? shimPath : findExecutable(executable);
  if (!dispatch) {
    return [false, `CLI tool '${executable}' not found in PATH. Install it first.`];
  }

  // A shim file (or a PATH entry) existing does NOT mean the agent is runnable:
  // the managed default version's binary can be a stub or gutted (a partial/raced
  // npm extract leaves the version dir + JS wrapper but no real binary). Verify
  // the resolved default version is actually installed so `teams doctor` reports
  // the truth instead of a false `installed: true` that ENOENTs at spawn.
  const version = resolveVersion(agent);
  if (version && !isVersionInstalled(agent, version)) {
    return [false, `${executable}@${version} is not runnable — its binary is missing/incomplete. Repair: agents add ${agent}@${version}`];
  }
  return [true, dispatch];
}

/** Check availability of all known agent CLIs. Returns a map of agent type to install status. */
export function checkAllClis(): Record<string, { installed: boolean; path: string | null; error: string | null }> {
  const results: Record<string, { installed: boolean; path: string | null; error: string | null }> = {};
  for (const agentType of TEAM_AGENT_TYPES) {
    const [available, pathOrError] = checkCliAvailable(agentType);
    if (available) {
      results[agentType] = { installed: true, path: pathOrError, error: null };
    } else {
      results[agentType] = { installed: false, path: null, error: pathOrError };
    }
  }
  return results;
}

/**
 * Advisory sign-in probe for a teammate's agent. Reads the account-global login
 * (no `home` → active config) via `getAccountInfo`. Deliberately best-effort:
 * sign-in detection is UNRELIABLE for opaque-credential agents (Kimi/Antigravity
 * store an OAuth/JWT with no email claim) and for keychain-probed agents, so a
 * `false` here is often a false negative. Callers must WARN and continue — never
 * block a team on this result. Never throws (returns false on any error).
 */
export async function checkCliSignedIn(agentType: AgentType): Promise<boolean> {
  try {
    const info = await getAccountInfo(agentType as AgentId);
    return info.signedIn;
  } catch {
    return false;
  }
}

/** Advisory sign-in status for a `teams doctor` row. */
export interface SignInAdvisory {
  /** true / false from the probe, or null when the agent isn't installed. */
  signedIn: boolean | null;
  /** Whether the agent is currently a running teammate. */
  running: boolean;
}

/**
 * Resolve the advisory sign-in status shown by `teams doctor`. An agent that is
 * currently RUNNING in a team is live proof it works, so it overrides a
 * (frequently false-negative) sign-in probe — doctor must never report a
 * working agent as logged out. Not installed → `signedIn: null` (nothing to
 * probe). Never flips the authoritative installed/ready column.
 */
export function resolveSignInAdvisory(
  installed: boolean,
  running: boolean,
  probeSignedIn: boolean
): SignInAdvisory {
  if (!installed) return { signedIn: null, running: false };
  return { signedIn: running ? true : probeSignedIn, running };
}

/** One row of `agents teams doctor --json` output. */
export interface TeamsDoctorEntry {
  installed: boolean;
  path: string | null;
  error: string | null;
  signedIn: boolean | null;
  running: boolean;
}

/**
 * Collect the same data `agents teams doctor` prints: per-agent install status,
 * launch health, and advisory sign-in state. Kept in one place so `agents doctor
 * --devices` can run it locally or compare it against remote JSON without
 * duplicating the probe logic.
 */
export async function collectTeamsDoctorData(): Promise<Record<string, TeamsDoctorEntry>> {
  const info = checkAllClis();

  // Deep integrity probe. `checkAllClis` reports presence (shim + stub guard),
  // but a gutted native binary still passes that, so actually launch the default
  // version and flip the agent to not-installed if it won't run.
  await Promise.all(
    Object.entries(info).map(async ([name, entry]) => {
      if (!entry.installed) return;
      const agent = name as AgentId;
      const version = resolveVersion(agent);
      if (!version) return;
      const health = await verifyInstalledBinaryLaunches(agent, version);
      if (!health.ok) {
        entry.installed = false;
        entry.path = null;
        entry.error = `${AGENTS[agent]?.cliCommand ?? name}@${version} is installed but its binary won't launch`
          + `${health.detail ? ` (${health.detail})` : ''}. Repair: agents add ${agent}@${version}`;
      }
    })
  );

  // Advisory enrichment only. Sign-in detection is unreliable, so it never
  // changes the authoritative installed/ready column — it annotates. A running
  // teammate overrides a negative probe.
  const running = new Set<string>();
  try {
    for (const a of await new AgentManager().listRunning()) running.add(a.agentType);
  } catch { /* no teams yet — leave running empty */ }

  const result: Record<string, TeamsDoctorEntry> = {};
  await Promise.all(
    Object.entries(info).map(async ([name, entry]) => {
      const isRunning = running.has(name);
      const probe = entry.installed && !isRunning ? await checkCliSignedIn(name as AgentType) : false;
      const auth = resolveSignInAdvisory(entry.installed, isRunning, probe);
      result[name] = { ...entry, ...auth };
    })
  );
  return result;
}

let AGENTS_DIR: string | null = null;

/** Resolve and cache the base directory where teammate process data is stored. */
export async function getAgentsDir(): Promise<string> {
  if (!AGENTS_DIR) {
    AGENTS_DIR = await resolveAgentsDir();
  }
  return AGENTS_DIR;
}

/**
 * Represents a single teammate process within a team.
 *
 * Tracks process metadata (PID, status, timestamps), reads incremental
 * stdout events, persists state to disk as meta.json, and can be
 * reconstituted from disk via loadFromDisk().
 */
export class AgentProcess {
  agentId: string;
  taskName: string;
  agentType: AgentType;
  prompt: string;
  cwd: string | null;
  workspaceDir: string | null;
  mode: Mode = 'plan';
  pid: number | null = null;
  // Captured at spawn time so we can detect PID reuse before signaling.
  // Compared against the live /proc or `ps` value at every kill() call.
  startTime: string | null = null;
  status: AgentStatus = AgentStatus.RUNNING;
  startedAt: Date = new Date();
  completedAt: Date | null = null;
  parentSessionId: string | null = null;
  cloudSessionId: string | null = null;
  cloudProvider: string | null = null;
  prUrl: string | null = null;
  version: string | null = null;
  remoteSessionId: string | null = null;
  name: string | null = null;
  // Names of teammates in the same team that this teammate is waiting on.
  // Empty array = no deps = can run immediately. Populated by `teams add --after`.
  after: string[] = [];
  // Reasoning-intensity knob wired into buildReasoningFlags at launch time.
  // Resolved late so config/effort-default changes between spawn and launch
  // are honored for teammates staged via `teams add --after`.
  effort: EffortLevel | null = null;
  // Pinned model for this teammate. When null, the agent's CLI picks its
  // own default (no --model forwarded).
  model: string | null = null;
  // Profile target name when the teammate was added via `agents teams add
  // <team> <profile>`. The launcher targets the profile name so env/keychain
  // injection happens; agentType stays the underlying harness so event
  // parsers and CLI availability checks keep working.
  profileName: string | null = null;
  // Extra env vars passed through to the child process (from --env KEY=VALUE).
  envOverrides: Record<string, string> | null = null;
  // Factory task-type label. Drives planner fan-out. Null for plain teammates — no behavioral change.
  taskType: TaskType | null = null;
  // Repo/branch for cloud dispatches that stage behind --after. Captured
  // at spawn time so startReady() can invoke the dispatcher with the same
  // options the user originally supplied.
  cloudRepo: string | null = null;
  cloudBranch: string | null = null;
  // Worktree isolation: when non-null, this teammate runs in its own git worktree.
  worktreeName: string | null = null;
  worktreePath: string | null = null;
  // Distributed teams: when hostName is non-null, this teammate runs on another
  // machine over SSH (the "remote-host" backend), not as a local process. These
  // are set post-construction (like startTime/pid) — placement config at add
  // time (hostName/hostTarget/repoPath) and runtime handles at launch time
  // (remotePid/remoteLog/remoteExit) — so the giant constructor stays untouched.
  hostName: string | null = null;
  hostTarget: string | null = null;
  repoPath: string | null = null;
  remotePid: number | null = null;
  remoteLog: string | null = null;
  remoteExit: string | null = null;
  // Offset-tail cursor into the REMOTE log (bytes already pulled). Distinct from
  // lastReadPos, which tracks the LOCAL mirror the parser consumes.
  remoteLogOffset: number = 0;
  // Per-wave batched-poll snapshot, refreshed each wave by the supervisor's
  // one-ssh-per-host pre-pass (AgentManager.prefetchRemoteStatus) and read by
  // isProcessAlive()/readNewEvents() so they skip their own SSH round-trip. It is
  // set anew (and cleared for uncovered teammates) at the START of every prefetch,
  // so it persists across BOTH poll passes within one wave (startReady's roster
  // scan + the supervisor's listByTask) yet never carries into the next wave. Null
  // outside a batched wave (e.g. a bare `teams status`), where a direct per-teammate
  // SSH probe is the correctness fallback.
  remotePollSnapshot: { alive: boolean; exit: string | null } | null = null;
  private eventsCache: any[] = [];
  private lastReadPos: number = 0;
  private baseDir: string | null = null;

  constructor(
    agentId: string,
    taskName: string,
    agentType: AgentType,
    prompt: string,
    cwd: string | null = null,
    mode: Mode = 'plan',
    pid: number | null = null,
    status: AgentStatus = AgentStatus.RUNNING,
    startedAt: Date = new Date(),
    completedAt: Date | null = null,
    baseDir: string | null = null,
    parentSessionId: string | null = null,
    workspaceDir: string | null = null,
    cloudSessionId: string | null = null,
    cloudProvider: string | null = null,
    prUrl: string | null = null,
    version: string | null = null,
    remoteSessionId: string | null = null,
    name: string | null = null,
    after: string[] = [],
    effort: EffortLevel | null = null,
    model: string | null = null,
    envOverrides: Record<string, string> | null = null,
    taskType: TaskType | null = null,
    cloudRepo: string | null = null,
    cloudBranch: string | null = null,
    worktreeName: string | null = null,
    worktreePath: string | null = null,
    profileName: string | null = null,
  ) {
    this.agentId = agentId;
    this.remoteSessionId = remoteSessionId;
    this.name = name;
    this.after = after;
    this.effort = effort;
    this.model = model;
    this.profileName = profileName;
    this.envOverrides = envOverrides;
    this.taskType = taskType;
    this.cloudRepo = cloudRepo;
    this.cloudBranch = cloudBranch;
    this.worktreeName = worktreeName;
    this.worktreePath = worktreePath;
    this.taskName = taskName;
    this.agentType = agentType;
    this.prompt = prompt;
    this.cwd = cwd;
    this.workspaceDir = workspaceDir;
    this.mode = mode;
    this.pid = pid;
    this.status = status;
    this.startedAt = startedAt;
    this.completedAt = completedAt;
    this.baseDir = baseDir;
    this.parentSessionId = parentSessionId;
    this.cloudSessionId = cloudSessionId;
    this.cloudProvider = cloudProvider;
    this.prUrl = prUrl;
    this.version = version;
  }

  get isEditMode(): boolean {
    // Any mode that can mutate the workspace counts as "edit mode" for the
    // purposes of guarding read-only flows (plan-mode teammates).
    return this.mode === 'edit' || this.mode === 'auto' || this.mode === 'skip';
  }

  async getAgentDir(): Promise<string> {
    const base = this.baseDir || await getAgentsDir();
    return path.join(base, this.agentId);
  }

  /**
   * Dump the subset of state the Ledger sync hook needs. Keeps sync.ts
   * free of any teams-internal imports.
   */
  async toSnapshot(): Promise<{
    agent_id: string;
    team_id: string;
    teammate_name: string | null;
    agent_type: string;
    task_type: string | null;
    status: string;
    started_at: string;
    completed_at: string | null;
    after: string[];
    cloud_provider: string | null;
    cloud_session_id: string | null;
    cloud_repo: string | null;
    cloud_branch: string | null;
    agent_dir: string;
    cwd: string | null;
  }> {
    return {
      agent_id: this.agentId,
      team_id: this.taskName,
      teammate_name: this.name,
      agent_type: this.agentType,
      task_type: this.taskType,
      status: this.status,
      started_at: this.startedAt.toISOString(),
      completed_at: this.completedAt?.toISOString() ?? null,
      after: this.after,
      cloud_provider: this.cloudProvider,
      cloud_session_id: this.cloudSessionId,
      cloud_repo: this.cloudRepo,
      cloud_branch: this.cloudBranch,
      agent_dir: await this.getAgentDir(),
      cwd: this.cwd,
    };
  }

  async getStdoutPath(): Promise<string> {
    return path.join(await this.getAgentDir(), 'stdout.log');
  }

  async getMetaPath(): Promise<string> {
    return path.join(await this.getAgentDir(), 'meta.json');
  }

  /**
   * Path to the exit-code sentinel. The launcher wraps the teammate command in
   * a shell that writes the underlying CLI's `$?` here once it exits. Detached
   * teammates can't be wait()ed on by the parent, so this file is the only
   * durable record of the real exit status — see reapProcess().
   */
  async getExitCodePath(): Promise<string> {
    return path.join(await this.getAgentDir(), 'exit_code');
  }

  toDict(): any {
    return {
      agent_id: this.agentId,
      task_name: this.taskName,
      agent_type: this.agentType,
      status: this.status,
      started_at: this.startedAt.toISOString(),
      completed_at: this.completedAt?.toISOString() || null,
      event_count: this.events.length,
      duration: this.duration(),
      mode: this.mode,
      parent_session_id: this.parentSessionId,
      workspace_dir: this.workspaceDir,
      cloud_session_id: this.cloudSessionId,
      cloud_provider: this.cloudProvider,
      pr_url: this.prUrl,
      version: this.version,
      remote_session_id: this.remoteSessionId,
      name: this.name,
      after: this.after,
      effort: this.effort,
      model: this.model,
      profile_name: this.profileName,
      env_overrides: this.envOverrides,
      task_type: this.taskType,
      cloud_repo: this.cloudRepo,
      cloud_branch: this.cloudBranch,
    };
  }

  duration(): string | null {
    let seconds: number;
    if (this.completedAt) {
      seconds = (this.completedAt.getTime() - this.startedAt.getTime()) / 1000;
    } else if (this.status === AgentStatus.RUNNING) {
      seconds = (Date.now() - this.startedAt.getTime()) / 1000;
    } else {
      return null;
    }

    if (seconds < 60) {
      return `${Math.floor(seconds)} seconds`;
    } else {
      const minutes = seconds / 60;
      return `${minutes.toFixed(1)} minutes`;
    }
  }

  get events(): any[] {
    return this.eventsCache;
  }

  /**
   * Return the latest timestamp we have seen in the agent's events.
   * Falls back to null when none are available.
   */
  private getLatestEventTime(): Date | null {
    let latest: Date | null = null;

    for (const event of this.eventsCache) {
      const ts = event?.timestamp;
      if (!ts) continue;
      const parsed = new Date(ts);
      if (!Number.isNaN(parsed.getTime())) {
        if (!latest || parsed > latest) {
          latest = parsed;
        }
      }
    }

    return latest;
  }

  /**
   * For a distributed (remote-host) teammate, pull NEW bytes of the host's log
   * into the LOCAL mirror the parser consumes, advance the remote offset, and
   * resolve terminal status from the remote `.exit` sentinel. Runs BEFORE the
   * local read in readNewEvents(), so the existing stream-json parse path then
   * runs unchanged over the freshly-mirrored bytes.
   *
   * Uses a per-wave batched snapshot (remotePollSnapshot) when the supervisor's
   * one-ssh-per-host pre-pass populated it; otherwise falls back to its own
   * round-trips so a bare `teams status`/`teams logs` is still correct.
   */
  private async syncRemoteMirror(): Promise<void> {
    if (!this.hostName || !this.hostTarget || !this.remoteLog) return;

    // Pull the new remote bytes and append them to the local mirror the parser
    // reads. One offset-tail round-trip; nothing to write when the log is quiet.
    const delta = pullRemoteLogDelta(this.hostTarget, {
      remoteLog: this.remoteLog,
      offset: this.remoteLogOffset,
    });
    if (delta && delta.bytes.length > 0) {
      const stdoutPath = await this.getStdoutPath();
      try {
        await fs.appendFile(stdoutPath, delta.bytes);
        this.remoteLogOffset = delta.newOffset;
      } catch {
        // best-effort mirror — leave the offset unadvanced so we retry next poll
      }
    }

    // Resolve terminal status from the remote `.exit` sentinel (mirror
    // reapProcess). Prefer this wave's batched snapshot; else fetch the exit file
    // directly. The snapshot is left in place (refreshed each wave by prefetch),
    // so a second poll pass within the same wave reuses it.
    let exit: string | null = null;
    const snap = this.remotePollSnapshot;
    if (snap) {
      exit = snap.exit;
    } else if (this.remoteExit) {
      // UNQUOTED so `$HOME` in the dispatch exit path expands on the remote shell.
      const res = sshExec(this.hostTarget, `cat ${this.remoteExit} 2>/dev/null`, {
        timeoutMs: 8000,
        multiplex: true,
      });
      exit = res.code === 0 && res.stdout.trim() !== '' ? res.stdout.trim() : null;
    }
    // Only latch terminal on a PARSEABLE exit code. A `.exit` that exists but is
    // momentarily empty (created, not yet written) or garbage must NOT force a
    // spurious FAILED — leave the teammate RUNNING and let the next poll resolve
    // it once the code lands. Matches the direct-cat guard above.
    if (exit !== null && exit.trim() !== '' && this.status === AgentStatus.RUNNING) {
      const code = Number.parseInt(exit.trim(), 10);
      if (Number.isFinite(code)) {
        this.status = code === 0 ? AgentStatus.COMPLETED : AgentStatus.FAILED;
        if (!this.completedAt) this.completedAt = new Date();
      }
    }
  }

  async readNewEvents(): Promise<void> {
    // Distributed teammate: mirror the host's new log bytes locally first, then
    // fall through to the identical local read+parse below.
    if (this.hostName) {
      await this.syncRemoteMirror();
    }
    const stdoutPath = await this.getStdoutPath();
    try {
      const stats = await fs.stat(stdoutPath).catch(() => null);
      if (!stats) return;
      const fallbackTimestamp = (stats.mtime || new Date()).toISOString();

      const fd = await fs.open(stdoutPath, 'r');
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, this.lastReadPos);
      await fd.close();

      if (bytesRead === 0) return;

      const newContent = buffer.toString('utf-8', 0, bytesRead);
      this.lastReadPos += bytesRead;

      const lines = newContent.split('\n').map(l => l.trim()).filter(l => l);
      for (const line of lines) {
        try {
          const rawEvent = JSON.parse(line);
          const events = normalizeEvents(this.agentType, rawEvent);
          const resolvedTimestamp = extractTimestamp(rawEvent)?.toISOString() || fallbackTimestamp;
          for (const event of events) {
            event.timestamp = resolvedTimestamp;
            this.eventsCache.push(event);

            // Capture the agent's own session/thread id the first time we see
            // it. For Claude it's the same uuid we passed via --session-id;
            // for others (Codex thread_id, Gemini/Cursor/OpenCode sessionID)
            // it's their internal id, which lets us cross-reference with
            // `agents sessions <id>`.
            if (!this.remoteSessionId && event.session_id) {
              this.remoteSessionId = event.session_id;
            }

            if (event.type === 'result' || event.type === 'turn.completed' || event.type === 'thread.completed') {
              if (event.status === 'success' || event.type === 'turn.completed') {
                this.status = AgentStatus.COMPLETED;
                this.completedAt = event.timestamp ? new Date(event.timestamp) : new Date();
              } else if (event.status === 'error') {
                this.status = AgentStatus.FAILED;
                this.completedAt = event.timestamp ? new Date(event.timestamp) : new Date();
              }
            }
          }
        } catch {
          this.eventsCache.push({
            type: 'raw',
            content: line,
            timestamp: fallbackTimestamp,
          });
        }
      }
    } catch (err) {
      console.error(`Error reading events for agent ${this.agentId}:`, err);
    }

    // Distributed teammate: keep the orchestrator bounded across 10+ remote
    // teammates. The parser has already consumed everything up to lastReadPos
    // (status/digest updated), so both the on-disk mirror tail and the in-memory
    // event backlog are safe to trim. The host keeps the full log.
    if (this.hostName) {
      await this.capMirrorToTail();
      this.capEventsCache();
    }
  }

  /**
   * Truncate the local mirror to its trailing REMOTE_MIRROR_MAX_BYTES and reset
   * lastReadPos to the new (smaller) size so the parser doesn't re-read the kept
   * tail. Only trims when over the cap — a normal-length log is untouched.
   */
  private async capMirrorToTail(): Promise<void> {
    const stdoutPath = await this.getStdoutPath();
    try {
      const stats = await fs.stat(stdoutPath).catch(() => null);
      if (!stats || stats.size <= REMOTE_MIRROR_MAX_BYTES) return;
      const keep = REMOTE_MIRROR_MAX_BYTES;
      const fd = await fs.open(stdoutPath, 'r');
      const buf = Buffer.alloc(keep);
      const { bytesRead } = await fd.read(buf, 0, keep, stats.size - keep);
      await fd.close();
      await fs.writeFile(stdoutPath, buf.subarray(0, bytesRead));
      // The parser consumed up to lastReadPos already; after truncation the file
      // is `bytesRead` long, so clamp the cursor to the new EOF. It never needs
      // to re-read the retained tail (events already cached).
      this.lastReadPos = Math.min(this.lastReadPos, bytesRead);
    } catch {
      // best-effort — a failed cap just leaves the mirror larger this wave
    }
  }

  /** Cap on the in-memory event backlog kept per remote teammate. */
  private static readonly REMOTE_EVENTS_MAX = 200;

  /**
   * Drop the oldest cached events for a remote teammate once past the cap. The
   * status path only needs recent events (last N messages, recentToolCalls,
   * terminal status) and the getDelta cursor filters by timestamp, so a bounded
   * recent window preserves the digest while bounding the heap. Terminal status
   * is already latched onto `this.status`, so trimming can't lose it.
   */
  private capEventsCache(): void {
    const max = AgentProcess.REMOTE_EVENTS_MAX;
    if (this.eventsCache.length > max) {
      this.eventsCache = this.eventsCache.slice(-max);
    }
  }

  async saveMeta(): Promise<void> {
    const agentDir = await this.getAgentDir();
    await fs.mkdir(agentDir, { recursive: true });
    const meta = {
      agent_id: this.agentId,
      task_name: this.taskName,
      agent_type: this.agentType,
      prompt: this.prompt,
      cwd: this.cwd,
      workspace_dir: this.workspaceDir,
      mode: this.mode,
      pid: this.pid,
      start_time: this.startTime,
      status: this.status,
      started_at: this.startedAt.toISOString(),
      completed_at: this.completedAt?.toISOString() || null,
      parent_session_id: this.parentSessionId,
      cloud_session_id: this.cloudSessionId,
      cloud_provider: this.cloudProvider,
      pr_url: this.prUrl,
      version: this.version,
      remote_session_id: this.remoteSessionId,
      name: this.name,
      after: this.after,
      effort: this.effort,
      model: this.model,
      profile_name: this.profileName,
      env_overrides: this.envOverrides,
      task_type: this.taskType,
      cloud_repo: this.cloudRepo,
      cloud_branch: this.cloudBranch,
      worktree_name: this.worktreeName,
      worktree_path: this.worktreePath,
      host_name: this.hostName,
      host_target: this.hostTarget,
      repo_path: this.repoPath,
      remote_pid: this.remotePid,
      remote_log: this.remoteLog,
      remote_exit: this.remoteExit,
      remote_log_offset: this.remoteLogOffset,
    };
    const metaPath = await this.getMetaPath();
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  }

  static async loadFromDisk(agentId: string, baseDir: string | null = null): Promise<AgentProcess | null> {
    const base = baseDir || await getAgentsDir();
    const agentDir = path.join(base, agentId);
    const metaPath = path.join(agentDir, 'meta.json');

    try {
      await fs.access(metaPath);
    } catch {
      return null;
    }

    try {
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(metaContent);

      // Legacy teammates may have mode='ralph', 'cloud', or 'full' from before
      // modes were narrowed/renamed. Coerce to the closest current mode so they
      // still load.
      const modeMap: Record<string, Mode> = {
        plan: 'plan',
        edit: 'edit',
        auto: 'auto',
        skip: 'skip',
        full: 'skip',   // historical alias — `full` is the old name for `skip`
        ralph: 'skip',  // ralph used the same "no-permission" flags as full
        cloud: 'edit',  // cloud teammates had edit-level write access
      };
      const resolvedMode: Mode = modeMap[meta.mode] || 'plan';

      // AgentStatus is a string enum. Validate meta.status against its VALUES
      // (not its keys) — `AgentStatus["pending"]` is undefined but
      // `AgentStatus.PENDING === "pending"` works.
      const validStatuses = Object.values(AgentStatus);
      const resolvedStatus: AgentStatus = validStatuses.includes(meta.status as AgentStatus)
        ? (meta.status as AgentStatus)
        : AgentStatus.RUNNING;

      const agent = new AgentProcess(
        meta.agent_id,
        meta.task_name || 'default',
        meta.agent_type,
        meta.prompt,
        meta.cwd || null,
        resolvedMode,
        meta.pid || null,
        resolvedStatus,
        new Date(meta.started_at),
        meta.completed_at ? new Date(meta.completed_at) : null,
        baseDir,
        meta.parent_session_id || null,
        meta.workspace_dir || null,
        meta.cloud_session_id || null,
        meta.cloud_provider || null,
        meta.pr_url || null,
        meta.version || null,
        meta.remote_session_id || null,
        meta.name || null,
        Array.isArray(meta.after) ? meta.after : [],
        meta.effort || null,
        meta.model || null,
        meta.env_overrides || null,
        meta.task_type && (VALID_TASK_TYPES as readonly string[]).includes(meta.task_type)
          ? (meta.task_type as TaskType)
          : null,
        meta.cloud_repo || null,
        meta.cloud_branch || null,
        meta.worktree_name || null,
        meta.worktree_path || null,
        meta.profile_name || null,
      );
      agent.startTime = typeof meta.start_time === 'string' ? meta.start_time : null;
      // Distributed-team fields: set post-construction (like startTime) so the
      // constructor signature stays fixed. Null on every pre-existing teammate.
      agent.hostName = meta.host_name || null;
      agent.hostTarget = meta.host_target || null;
      agent.repoPath = meta.repo_path || null;
      agent.remotePid = typeof meta.remote_pid === 'number' ? meta.remote_pid : null;
      agent.remoteLog = meta.remote_log || null;
      agent.remoteExit = meta.remote_exit || null;
      agent.remoteLogOffset = typeof meta.remote_log_offset === 'number' ? meta.remote_log_offset : 0;
      return agent;
    } catch {
      return null;
    }
  }

  isProcessAlive(): boolean {
    // Distributed teammate: a local PID is meaningless. Alive = the remote `.exit`
    // sentinel is absent AND `kill -0 <remotePid>` succeeds on the host, resolved
    // in a single ssh round-trip. Prefer the supervisor's batched snapshot when
    // present (consume it once so it can't go stale); otherwise probe directly.
    if (this.hostName) {
      // Prefer this wave's batched snapshot (persists across the wave's poll
      // passes; the supervisor refreshes it each wave). Fall back to a direct
      // probe outside a wave.
      if (this.remotePollSnapshot) return this.remotePollSnapshot.alive;
      if (!this.hostTarget || !this.remotePid || !this.remoteExit) return false;
      // remoteExit is a dispatch `$HOME/.agents/.cache/hosts/<hex>.exit` path —
      // interpolate UNQUOTED so `$HOME` expands (shellQuote would defeat it).
      const probe =
        `test -f ${this.remoteExit} && echo DEAD || ` +
        `(kill -0 ${this.remotePid} 2>/dev/null && echo ALIVE || echo DEAD)`;
      const res = sshExec(this.hostTarget, probe, { timeoutMs: 8000, multiplex: true });
      if (res.code === null) return true; // transient ssh failure — don't reap early
      return res.stdout.trim().endsWith('ALIVE');
    }

    if (!this.pid) return false;
    try {
      process.kill(this.pid, 0);
    } catch {
      return false;
    }
    // PID is occupied — but is it still OUR process? If we captured a
    // start-time at spawn, refuse to claim aliveness when the live value
    // differs. A null startTime means we never captured one (legacy
    // teammates loaded from disk before this field existed) — fall back to
    // the bare kill(pid, 0) result for those.
    if (this.startTime !== null) {
      const current = captureProcessStartTime(this.pid);
      if (current === null || current !== this.startTime) {
        return false;
      }
    }
    return true;
  }

  async updateStatusFromProcess(): Promise<void> {
    if (!this.pid) {
      // Distributed (remote-host) teammates have no local PID by design; their
      // lifecycle lives on the host. readNewEvents() mirrors the remote log and
      // resolves terminal status from the remote `.exit` sentinel (see
      // syncRemoteMirror), so we just persist and return — never the local
      // "RUNNING without a PID is impossible" fail path below.
      if (this.hostName) {
        await this.readNewEvents();
        if (this.status !== AgentStatus.RUNNING && !this.completedAt) {
          this.completedAt = this.getLatestEventTime() || this.startedAt || new Date();
        }
        await this.saveMeta();
        return;
      }

      await this.readNewEvents();

      // Cloud-backed teammates have no local PID by design; their lifecycle
      // is driven by the remote provider instead of a local process.
      if (this.cloudProvider) {
        if (!this.completedAt && this.status !== AgentStatus.RUNNING) {
          const fallbackCompletion =
            this.getLatestEventTime() || this.startedAt || new Date();
          this.completedAt = fallbackCompletion;
          await this.saveMeta();
        }
        return;
      }

      // Pending teammates with unresolved --after deps also have no PID yet.
      // Leave them alone until startReady() launches them.
      if (this.status === AgentStatus.PENDING) {
        return;
      }

      // A local teammate marked RUNNING without a PID is an impossible state:
      // launch never produced a durable process identity, so it cannot still
      // be doing work. Keep any terminal event parsed from stdout; otherwise
      // fail it and stamp completion so team rollups stop showing it as live.
      if (this.status === AgentStatus.RUNNING) {
        const fallbackCompletion =
          this.getLatestEventTime() || this.startedAt || new Date();
        if (this.status === AgentStatus.RUNNING) {
          this.status = AgentStatus.FAILED;
          this.completedAt = fallbackCompletion;
        }
        await this.saveMeta();
        return;
      }

      if (!this.completedAt) {
        const fallbackCompletion =
          this.getLatestEventTime() || this.startedAt || new Date();
        this.completedAt = fallbackCompletion;
        await this.saveMeta();
      }
      return;
    }

    if (this.isProcessAlive()) {
      await this.readNewEvents();
      return;
    }

    if (this.status === AgentStatus.RUNNING) {
      const exitCode = await this.reapProcess();
      await this.readNewEvents();

      if (this.status === AgentStatus.RUNNING) {
        const fallbackCompletion =
          this.getLatestEventTime() || this.startedAt || new Date();
        if (exitCode !== null && exitCode !== 0) {
          this.status = AgentStatus.FAILED;
        } else {
          this.status = AgentStatus.COMPLETED;
        }
        this.completedAt = fallbackCompletion;
      }
    } else if (!this.completedAt) {
      await this.readNewEvents();
      const fallbackCompletion =
        this.getLatestEventTime() || this.startedAt || new Date();
      this.completedAt = fallbackCompletion;
    }

    await this.saveMeta();
  }

  /**
   * Recover the teammate's exit status after its process is gone.
   *
   * The teammate is spawned detached + unref()'d (see launchProcess), so the
   * parent never gets the child's exit code from the OS. Instead the launcher
   * wraps the command in a shell that records `$?` to the exit-code sentinel.
   * This reads that file:
   *   - still alive            -> null (no verdict yet)
   *   - sentinel present       -> the real exit code (0 = success)
   *   - sentinel absent        -> 1 (the shell was killed before it could write
   *                                  it, e.g. SIGKILL on timeout/stop — a real
   *                                  failure)
   *
   * Returning a real code (not a hardcoded 1) is what lets agents whose stream
   * never emits a parsed terminal event — kimi, antigravity, droid — be marked
   * completed on success instead of falsely failed.
   */
  private async reapProcess(): Promise<number | null> {
    if (!this.pid) return null;
    // isProcessAlive() applies the start-time guard, so a recycled PID now
    // owned by an unrelated process doesn't read as still-alive.
    if (this.isProcessAlive()) return null;

    try {
      const raw = (await fs.readFile(await this.getExitCodePath(), 'utf-8')).trim();
      const code = Number.parseInt(raw, 10);
      return Number.isNaN(code) ? 1 : code;
    } catch {
      // No sentinel: the shell died before recording $? (killed mid-run).
      return 1;
    }
  }
}

/**
 * Manages the full lifecycle of teammate agent processes.
 *
 * Handles spawning (with DAG dependency resolution), status polling,
 * stopping, and automatic cleanup of old agents. Maintains an in-memory
 * cache backed by on-disk meta.json files.
 */
/**
 * Callback used to dispatch a cloud-backed teammate when its --after deps
 * resolve. Teams.ts registers one via setCloudDispatcher() at startup; the
 * MCP server path leaves it null (cloud teammates aren't dispatched from MCP).
 */
export type CloudDispatchFn = (agent: AgentProcess) => Promise<{ cloudSessionId: string }>;

export class AgentManager {
  private agents: Map<string, AgentProcess> = new Map();
  private maxAgents: number;
  private agentsDir: string = '';
  private filterByCwd: string | null;
  private cleanupAgeDays: number;
  private defaultMode: Mode;
  private initPromise: Promise<void> | null = null;
  private cloudDispatcher: CloudDispatchFn | null = null;

  private constructorAgentsDir: string | null = null;

  constructor(
    maxAgents: number = 50,
    agentsDir: string | null = null,
    defaultMode: Mode | null = null,
    filterByCwd: string | null = null,
    cleanupAgeDays: number = 7,
  ) {
    this.maxAgents = maxAgents;
    this.constructorAgentsDir = agentsDir;
    this.filterByCwd = filterByCwd;
    this.cleanupAgeDays = cleanupAgeDays;
    const resolvedDefaultMode = defaultMode ? normalizeModeValue(defaultMode) : defaultModeFromEnv();
    if (!resolvedDefaultMode) {
      throw new Error(`Invalid default_mode '${defaultMode}'. Use plan, edit, auto, or skip.`);
    }
    this.defaultMode = resolvedDefaultMode;

    this.initPromise = this.doInitialize();
  }

  private async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    this.agentsDir = this.constructorAgentsDir || await getAgentsDir();
    await fs.mkdir(this.agentsDir, { recursive: true });

    await this.loadExistingAgents();
  }

  getDefaultMode(): Mode {
    return this.defaultMode;
  }

  /**
   * Register the callback used to dispatch cloud-backed teammates when their
   * --after deps resolve. Called once at CLI startup by `agents teams`.
   */
  setCloudDispatcher(fn: CloudDispatchFn | null): void {
    this.cloudDispatcher = fn;
  }

  registerAgent(agent: AgentProcess): void {
    this.agents.set(agent.agentId, agent);
  }

  /**
   * Scan the agents dir for meta.json files not already in the in-memory
   * cache and load them. Needed when another process (e.g. a Planner
   * teammate running `agents teams add`) creates new teammates while this
   * manager is alive — the supervisor loop calls this each wave so
   * dynamically-added teammates get picked up.
   *
   * Does not modify or re-load agents already in the cache; that path is
   * covered by updateStatusFromProcess() which re-reads stdout.log.
   */
  async rescanFromDisk(): Promise<number> {
    await this.initialize();
    try {
      await fs.access(this.agentsDir);
    } catch {
      return 0;
    }
    const entries = await fs.readdir(this.agentsDir);
    let added = 0;
    for (const entry of entries) {
      if (this.agents.has(entry)) continue;
      const agentDir = path.join(this.agentsDir, entry);
      const stat = await fs.stat(agentDir).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;
      const agent = await AgentProcess.loadFromDisk(entry, this.agentsDir);
      if (!agent) continue;
      if (this.filterByCwd !== null && agent.cwd !== this.filterByCwd) continue;
      this.agents.set(entry, agent);
      added++;
    }
    return added;
  }

  private async loadExistingAgents(): Promise<void> {
    try {
      await fs.access(this.agentsDir);
    } catch {
      return;
    }

    const cutoffDate = new Date(Date.now() - this.cleanupAgeDays * 24 * 60 * 60 * 1000);
    let loadedCount = 0;
    let skippedCwd = 0;
    let cleanedOld = 0;

    const entries = await fs.readdir(this.agentsDir);
    for (const entry of entries) {
      const agentDir = path.join(this.agentsDir, entry);
      const stat = await fs.stat(agentDir).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;

      const agentId = entry;
      const agent = await AgentProcess.loadFromDisk(agentId, this.agentsDir);
      if (!agent) continue;

      if (agent.completedAt && agent.completedAt < cutoffDate) {
        try {
          await fs.rm(agentDir, { recursive: true });
          cleanedOld++;
        } catch (err) {
          console.warn(`Failed to cleanup old agent ${agentId}:`, err);
        }
        continue;
      }

      if (this.filterByCwd !== null) {
        const agentCwd = agent.cwd;
        if (agentCwd !== this.filterByCwd) {
          skippedCwd++;
          continue;
        }
      }

      await agent.updateStatusFromProcess();
      this.agents.set(agentId, agent);
      loadedCount++;
    }

    if (cleanedOld > 0) {
      debug(`Cleaned up ${cleanedOld} old agents (older than ${this.cleanupAgeDays} days)`);
    }
    if (skippedCwd > 0) {
      debug(`Skipped ${skippedCwd} agents (different CWD)`);
    }
    debug(`Loaded ${loadedCount} agents from disk`);
  }

  async spawn(
    taskName: string,
    agentType: AgentType,
    prompt: string,
    cwd: string | null = null,
    mode: Mode | null = null,
    effort: EffortLevel = 'medium',
    parentSessionId: string | null = null,
    workspaceDir: string | null = null,
    version: string | null = null,
    name: string | null = null,
    after: string[] = [],
    model: string | null = null,
    envOverrides: Record<string, string> | null = null,
    taskType: TaskType | null = null,
    cloudProvider: string | null = null,
    cloudSessionId: string | null = null,
    cloudRepo: string | null = null,
    cloudBranch: string | null = null,
    worktreeName: string | null = null,
    worktreePath: string | null = null,
    profileName: string | null = null,
    hostName: string | null = null,
    hostTarget: string | null = null,
    repoPath: string | null = null,
  ): Promise<AgentProcess> {
    await this.initialize();
    const resolvedMode = resolveMode(mode, this.defaultMode);

    // Enforce: teammate names are unique within a team.
    const siblings = await this.listByTask(taskName);
    if (name && siblings.some((a) => a.name === name)) {
      throw new Error(
        `Team '${taskName}' already has a teammate named '${name}'. Pick another name or leave --name off.`
      );
    }

    // --- dependency validation ---
    const cleanAfter = after.filter((s) => s && s.trim());
    if (cleanAfter.length > 0) {
      if (!name) {
        throw new Error(
          "Can't use --after without --name. Dependencies reference teammates by name."
        );
      }
      // Every --after entry must resolve to an existing teammate name.
      const siblingNames = new Set(siblings.map((a) => a.name).filter(Boolean) as string[]);
      const missing = cleanAfter.filter((dep) => !siblingNames.has(dep));
      if (missing.length > 0) {
        throw new Error(
          `Team '${taskName}' has no teammate named ${missing.map((m) => `'${m}'`).join(', ')} yet.\n` +
            `  Add them first, then add this one.`
        );
      }
      // Cycle check: walk the transitive deps of each --after entry; if the
      // new teammate's own name shows up, we'd create a cycle.
      const byName = new Map(siblings.filter((a) => a.name).map((a) => [a.name as string, a]));
      for (const dep of cleanAfter) {
        if (hasTransitiveDep(byName, dep, name)) {
          throw new Error(
            `Adding '${name}' after '${dep}' would create a cycle (${dep} already depends on ${name}).`
          );
        }
      }
    }

    // Resolve and validate cwd
    let resolvedCwd: string | null = null;
    if (cwd !== null) {
      resolvedCwd = path.resolve(cwd);
      const stat = await fs.stat(resolvedCwd).catch(() => null);
      if (!stat) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Working directory is not a directory: ${cwd}`);
      }
    }

    // Cloud-backed teammates run on remote infrastructure; we don't need the
    // local CLI for them (the pod has its own). The caller has already
    // dispatched via the cloud provider and passed us the provider + session.
    const isCloudBacked = Boolean(cloudProvider);
    // Distributed teammates run on another machine over SSH — the agent CLI must
    // be present on the HOST (checked via ensureHostReady in the command), not
    // locally. So skip the local availability check for both remote backends.
    const isRemoteBacked = Boolean(hostName);
    if (!isCloudBacked && !isRemoteBacked) {
      // Profile-backed teammates still spawn through `agents run`, which
      // resolves the profile to its host harness — so the CLI we need to be
      // present is the underlying agentType, not the profile name.
      const [available, pathOrError] = checkCliAvailable(agentType);
      if (!available) {
        throw new Error(pathOrError || 'CLI tool not available');
      }
    }

    // Use a full UUIDv4 as the canonical agent_id. For Claude, we pass it via
    // --session-id so it's also Claude's session id (unified identity).
    const agentId = randomUUID();
    const isStaged = cleanAfter.length > 0;

    const initialStatus = isStaged || !isCloudBacked
      ? AgentStatus.PENDING
      : AgentStatus.RUNNING;

    const agent = new AgentProcess(
      agentId,
      taskName,
      agentType,
      prompt,
      resolvedCwd,
      resolvedMode,
      null,
      initialStatus,
      new Date(),
      null,
      this.agentsDir,
      parentSessionId,
      workspaceDir,
      cloudSessionId,
      cloudProvider,
      null,
      version,
      null,
      name,
      cleanAfter,
      effort,
      model,
      envOverrides && Object.keys(envOverrides).length > 0 ? envOverrides : null,
      taskType,
      cloudRepo,
      cloudBranch,
      worktreeName,
      worktreePath,
      profileName,
    );

    // Distributed-team placement: set post-construction (like startTime), so the
    // giant constructor stays fixed. launchRemoteProcess() reads these to dispatch
    // over SSH and fills in the runtime handles (remotePid/remoteLog/remoteExit).
    agent.hostName = hostName;
    agent.hostTarget = hostTarget;
    agent.repoPath = repoPath;

    const agentDir = await agent.getAgentDir();
    try {
      await fs.mkdir(agentDir, { recursive: true });
    } catch (err: any) {
      throw new Error(`Failed to create agent directory: ${err.message}`);
    }
    this.agents.set(agentId, agent);

    // Seed the teammate's session label with its friendly team name, so the run
    // shows up as `<name>` in `agents sessions` and resolves by it — consistent
    // with `agents run --name`. For Claude the agent id IS the session id (passed
    // via --session-id in buildCommand); other agents don't expose a launch-time
    // id, so they're seeded once discovery captures one. Best-effort.
    if (agentType === 'claude' && name && !isCloudBacked) {
      recordRunName({ sessionId: agentId, name, agent: agentType, cwd: resolvedCwd ?? undefined });
    }

    if (isStaged) {
      await agent.saveMeta();
      debug(`Staged ${agentType} teammate '${name}' in team '${taskName}' (after: ${cleanAfter.join(', ')})`);
    } else if (isCloudBacked) {
      // Cloud-backed teammate: the provider already dispatched a remote task.
      // No local process to launch; status polling walks the provider instead.
      await agent.saveMeta();
      debug(`Cloud-backed ${agentType} teammate via ${cloudProvider} (session=${cloudSessionId})`);
    } else if (isRemoteBacked) {
      // Distributed teammate that can run now (no unmet --after deps): dispatch
      // it onto its host over SSH instead of a local spawn.
      await this.launchRemoteProcess(agent);
    } else {
      // Unpinned + launching now: consult the pool scheduler before defaulting to
      // local, so an unpinned teammate on a --devices team auto-schedules even when
      // added without --after (it wouldn't pass through startReady otherwise).
      await this.maybeSchedulePlacement(agent, taskName);
      if (agent.hostName) await this.launchRemoteProcess(agent);
      else await this.launchProcess(agent);
    }

    await this.cleanupOldAgents();
    return agent;
  }

  /**
   * Actually spawn the OS process for a teammate. Extracted from spawn() so
   * staged teammates can be launched later by startReady().
   */
  private async launchProcess(agent: AgentProcess): Promise<void> {
    const running = await this.listRunning();
    warnIfMemoryLow(running.length);

    const effort = agent.effort ?? 'medium';
    // null model means "let the CLI pick its own default" (no --model flag
    // forwarded). Effort is a separate knob wired into buildReasoningFlags
    // inside buildCommand.
    const resolvedModel: string | null = agent.model ?? null;
    const cmd = this.buildCommand(
      agent.agentType,
      agent.prompt,
      agent.mode,
      resolvedModel,
      agent.cwd,
      agent.agentId,
      effort,
      agent.version,
      agent.profileName,
    );

    debug(`Launching ${agent.agentType} agent ${agent.agentId} [${agent.mode}]: ${cmd.slice(0, 3).join(' ')}...`);

    try {
      const stdoutPath = await agent.getStdoutPath();
      const stdoutFile = await fs.open(stdoutPath, 'w');
      const stdoutFd = stdoutFile.fd;

      // Wrap the teammate command in a shell that records the underlying CLI's
      // exit code to a sentinel file. Detached + unref()'d children can't be
      // wait()ed on by this parent, so the sentinel is the only durable record
      // of the real exit status — reapProcess() reads it to decide
      // completed-vs-failed for agents whose stream emits no parsed terminal
      // event (kimi, antigravity, droid). Remove any stale sentinel from a
      // prior run of the same agent id first so a restart can't read it.
      const exitCodePath = await agent.getExitCodePath();
      await fs.rm(exitCodePath, { force: true }).catch(() => {});
      const wrappedCmd = buildSentinelCommand(cmd, exitCodePath);

      // detached:true makes the shell the process-group leader, so stop()'s
      // `kill(-pid)` still reaches the underlying CLI through the group.
      const childProcess = spawn('/bin/sh', ['-c', wrappedCmd], {
        stdio: ['ignore', stdoutFd, stdoutFd],
        cwd: agent.cwd || undefined,
        detached: true,
        env: agent.envOverrides
          ? { ...sanitizeProcessEnv(process.env), ...agent.envOverrides }
          : sanitizeProcessEnv(process.env),
      });

      childProcess.unref();
      stdoutFile.close().catch(() => {});

      agent.pid = childProcess.pid || null;
      // Capture start-time NOW, while we know the PID is ours. Once the
      // OS reuses this PID slot, /proc and `ps` will report a different
      // value — that's the signal stop() uses to refuse to signal an
      // unrelated process.
      agent.startTime = agent.pid ? captureProcessStartTime(agent.pid) : null;
      agent.status = AgentStatus.RUNNING;
      agent.startedAt = new Date();
      await agent.saveMeta();
    } catch (err: any) {
      await this.cleanupPartialAgent(agent);
      console.error(`Failed to spawn agent ${agent.agentId}:`, err);
      throw new Error(`Failed to spawn agent: ${err.message}`);
    }

    debug(`Launched agent ${agent.agentId} with PID ${agent.pid}`);
  }

  /**
   * Dispatch a distributed teammate onto its host over SSH — the remote-host
   * analog of launchProcess(). Symmetric to the cloud path: no local process; the
   * lifecycle lives on the host and is polled (isProcessAlive/readNewEvents over
   * SSH via the remote `.exit` sentinel + offset-tailed log).
   *
   * When the team uses worktrees (agent.worktreeName set), a git worktree is first
   * created ON THE HOST off the freshly-fetched default branch; the teammate runs
   * there. Otherwise it runs in the host repo path directly.
   */
  private async launchRemoteProcess(agent: AgentProcess): Promise<void> {
    if (!agent.hostName || !agent.hostTarget || !agent.repoPath) {
      throw new Error(`Remote teammate ${agent.agentId} is missing host placement (host/target/repo).`);
    }

    // Re-resolve the device → Host at launch time (it may have moved / changed
    // address since `add` staged the teammate), matching how the command resolved
    // it. The target string on the agent stays the launch-time source of truth for
    // subsequent polling.
    const host = await resolveHost(agent.hostName);
    if (!host) {
      throw new Error(`Cannot launch remote teammate ${agent.agentId}: device "${agent.hostName}" no longer resolves.`);
    }

    // Ensure agents-cli is present + version-matched on the host; surface (not
    // fail on) an agent-not-installed warning like dispatch.ts does.
    try {
      const { warnings } = ensureHostReady(host, { agent: agent.agentType });
      for (const w of warnings) process.stderr.write(`[teams] warning: ${w}\n`);
    } catch (err) {
      throw new Error(`Host "${agent.hostName}" not ready for teammate ${agent.agentId}: ${(err as Error).message}`);
    }

    // Worktree isolation on the host, if the team enables it. createRemoteWorktree
    // fetches origin and branches off origin/<default>, returning the host path.
    let remoteCwd = agent.repoPath;
    if (agent.worktreeName) {
      const worktreePath = createRemoteWorktree(agent.hostTarget, agent.repoPath, agent.worktreeName);
      agent.worktreePath = worktreePath;
      remoteCwd = worktreePath;
    }

    // Same run argv the local path builds (shared buildRunArgv keeps the prompt
    // scaffolding + flags from drifting); dispatched non-blocking (follow:false)
    // — the supervisor polls the host, we don't block here.
    const effort = agent.effort ?? 'medium';
    const forwardedArgs = this.buildRunArgv(
      agent.agentType,
      agent.prompt,
      agent.mode,
      agent.model ?? null,
      effort,
      agent.version,
      agent.profileName,
    );

    try {
      const { task } = await dispatchAgentsCommand(host, {
        forwardedArgs,
        remoteCwd,
        follow: false,
      });
      agent.remotePid = task.pid ?? null;
      agent.remoteLog = task.remoteLog ?? null;
      agent.remoteExit = task.remoteExit ?? null;
      agent.remoteLogOffset = 0;
      agent.status = AgentStatus.RUNNING;
      agent.startedAt = new Date();
      await agent.saveMeta();
    } catch (err: any) {
      console.error(`Failed to launch remote teammate ${agent.agentId} on ${agent.hostName}:`, err);
      throw new Error(`Failed to launch remote teammate: ${err.message}`);
    }

    debug(`Launched remote agent ${agent.agentId} on ${agent.hostName} (remote pid ${agent.remotePid})`);
  }

  /**
   * Resolve a scheduler-picked device to host placement fields on an unpinned
   * teammate at LAUNCH time (the same resolution `teams add --device` runs, minus
   * the fatal `die()` — a scheduling failure here is per-teammate, not per-add).
   * Sets hostName/hostTarget/repoPath + persists, so the subsequent
   * launchRemoteProcess dispatches over SSH. Mirrors the `add`-time pin path:
   * resolve device → reject Windows (POSIX-only) → ssh target → ensure the repo
   * is present on the host from the team's --repo (ensureRemoteRepo).
   */
  private async resolveScheduledPlacement(
    agent: AgentProcess,
    device: string,
    taskName: string,
  ): Promise<void> {
    const host = await resolveHost(device);
    if (!host) {
      throw new Error(`Scheduler picked device "${device}" but it no longer resolves.`);
    }
    if (remoteShellFor(host.os ?? resolveRemoteOsSync(host.name)) === 'powershell') {
      throw new Error(
        `Scheduler picked Windows device "${host.name}", but distributed teammates are POSIX-only in v1.`,
      );
    }
    const target = sshTargetFor(host);
    const teamMeta = await getTeam(taskName);
    const repoRoot = ensureRemoteRepo(target, teamMeta?.repo ?? '', taskName);
    agent.hostName = host.name;
    agent.hostTarget = target;
    agent.repoPath = repoRoot;
    await agent.saveMeta();
  }

  /**
   * Place an UNPINNED, non-cloud teammate onto the team pool via the cascade
   * (least-loaded), if the team declares one. A no-op for a pinned teammate
   * (hostName already set from `--device`), a cloud teammate, or a poolless team —
   * leaving hostName null so the local spawn runs unchanged. Shared by spawn()
   * (immediate add-launch) and startReady() (staged launch) so an unpinned pool
   * teammate schedules identically no matter how it was fired.
   */
  private async maybeSchedulePlacement(agent: AgentProcess, taskName: string): Promise<void> {
    if (agent.hostName || agent.cloudProvider) return;
    const teamMeta = await getTeam(taskName);
    if (!teamMeta) return;
    const roster = await this.listByTask(taskName);
    const { device } = resolvePlacement(teamMeta, null, roster);
    if (device) await this.resolveScheduledPlacement(agent, device, taskName);
  }

  /**
   * One-ssh-per-host batched liveness/exit pre-pass for a team's remote teammates.
   * The supervisor calls this each wave BEFORE listByTask() so the per-teammate
   * isProcessAlive()/readNewEvents() consume a cached snapshot instead of each
   * issuing its own SSH handshake — avoiding N round-trips per wave at 10+ remote
   * teammates. Groups by hostTarget and, for each host, checks every teammate's
   * `.exit` + `kill -0` in a single ssh call over the shared ControlMaster socket.
   */
  async prefetchRemoteStatus(taskName: string): Promise<void> {
    await this.initialize();
    // Read the in-memory roster directly — going through listByTask()/listAll()
    // would poll each teammate first (an SSH round-trip apiece), defeating the
    // batch. The caller (supervisor) has already rescanned from disk this wave.
    const remotes = Array.from(this.agents.values()).filter(
      (a) => a.taskName === taskName && a.hostName,
    );
    // Fresh snapshots each wave: clear stale ones first so a teammate that has
    // since finished (dropped from the RUNNING filter below) can't carry an old
    // ALIVE reading into this wave's poll.
    for (const a of remotes) a.remotePollSnapshot = null;

    const teammates = remotes.filter(
      (a) =>
        a.hostTarget && a.remotePid && a.remoteExit &&
        a.status === AgentStatus.RUNNING,
    );
    if (teammates.length === 0) return;

    const byTarget = new Map<string, AgentProcess[]>();
    for (const a of teammates) {
      const arr = byTarget.get(a.hostTarget!) || [];
      arr.push(a);
      byTarget.set(a.hostTarget!, arr);
    }

    for (const [target, agents] of byTarget) {
      // Emit one line per teammate: "<agentId> ALIVE|DEAD <exitOrEmpty>". A single
      // round-trip over the multiplexed socket, regardless of teammate count.
      const parts = agents.map((a) => {
        const id = a.agentId;
        // remoteExit is a dispatch `$HOME/.agents/.cache/hosts/<hex>.exit` path —
        // interpolate UNQUOTED so `$HOME` expands (shellQuote would make `[ -f ]`
        // always miss, so a finished teammate would never resolve terminal).
        const exitFile = a.remoteExit!;
        // exit code (if the sentinel exists) OR empty, then liveness.
        return (
          `printf '%s ' ${shellQuote(id)}; ` +
          `if [ -f ${exitFile} ]; then printf 'DEAD '; cat ${exitFile} 2>/dev/null | tr -d '\\n'; printf '\\n'; ` +
          `elif kill -0 ${a.remotePid} 2>/dev/null; then printf 'ALIVE\\n'; ` +
          `else printf 'DEAD\\n'; fi`
        );
      });
      const res = sshExec(target, parts.join('; '), { timeoutMs: 12000, multiplex: true });
      if (res.code === null) continue; // transient ssh failure — skip this wave, no snapshot
      const snapshots = new Map<string, { alive: boolean; exit: string | null }>();
      for (const line of res.stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [id, state, exit] = trimmed.split(/\s+/);
        if (!id) continue;
        snapshots.set(id, {
          alive: state === 'ALIVE',
          exit: state === 'DEAD' ? (exit ?? '') : null,
        });
      }
      for (const a of agents) {
        const snap = snapshots.get(a.agentId);
        if (snap) a.remotePollSnapshot = snap;
      }
    }
  }

  /**
   * Fire any pending teammates in the given team whose `after` deps have all
   * completed. Returns the list of teammates just launched. Repeatable:
   * call it once per DAG wave. Safe to call on teams with no pending work
   * (returns empty list).
   */
  async startReady(taskName: string): Promise<AgentProcess[]> {
    await this.initialize();
    const teammates = await this.listByTask(taskName);
    const byName = new Map(
      teammates.filter((a) => a.name).map((a) => [a.name as string, a])
    );

    const launched: AgentProcess[] = [];
    for (const agent of teammates) {
      if (agent.status !== AgentStatus.PENDING) continue;
      const depsReady = agent.after.every((depName) => {
        const dep = byName.get(depName);
        return dep && dep.status === AgentStatus.COMPLETED;
      });
      if (!depsReady) continue;

      // Auto-scheduling: an UNPINNED teammate (no explicit --device at add time)
      // gets placed now via the pool cascade — same helper spawn() uses so the
      // immediate-add and staged paths agree. A null pick keeps hostName null →
      // local spawn, unchanged. Cloud teammates never schedule.
      try {
        await this.maybeSchedulePlacement(agent, taskName);
      } catch (err) {
        console.error(`Could not schedule ${agent.agentId} onto the team pool:`, err);
        continue;
      }

      try {
        if (agent.hostName) {
          // Distributed teammate: dispatch onto its host over SSH.
          await this.launchRemoteProcess(agent);
          launched.push(agent);
        } else if (agent.cloudProvider) {
          if (!this.cloudDispatcher) {
            console.error(
              `Cannot start cloud-backed teammate ${agent.agentId}: no dispatcher registered.`
            );
            continue;
          }
          const { cloudSessionId } = await this.cloudDispatcher(agent);
          agent.cloudSessionId = cloudSessionId;
          agent.status = AgentStatus.RUNNING;
          agent.startedAt = new Date();
          await agent.saveMeta();
          launched.push(agent);
        } else {
          await this.launchProcess(agent);
          launched.push(agent);
        }
      } catch (err) {
        console.error(`Could not launch ${agent.agentId}:`, err);
      }
    }
    return launched;
  }

  /**
   * Build the argv to spawn for a teammate. Delegates to `agents run` so the
   * agent's CLI flags, version routing, mode handling (plan/edit/full), model
   * injection, and reasoning-intensity flags are owned by a single canonical
   * exec path (src/lib/exec.ts). The team runner just supplies prompt + mode
   * and reads stream-json events off stdout.
   */
  /**
   * Build the `agents run …` argv AFTER the `agents` binary — the flags + prompt
   * scaffolding shared by the LOCAL launch (buildCommand, which prefixes
   * process.execPath + the agents CLI path) and the REMOTE launch
   * (launchRemoteProcess, which prefixes `agents` on the host via dispatch). Kept
   * in one place so the PROMPT_SUFFIX / CLAUDE_PLAN_MODE_PREFIX scaffolding and the
   * flag set can never drift between the two backends.
   *
   * `cwd` is intentionally NOT emitted here: the local path passes it as
   * `--cwd`/`--add-dir` (below), while the remote path `cd`s into the host cwd
   * before invoking `agents`. `sessionId` is likewise local-only (the remote run
   * mints its own session on the host).
   */
  private buildRunArgv(
    agentType: AgentType,
    prompt: string,
    mode: Mode,
    model: string | null,
    effort: EffortLevel,
    version: string | null,
    profileName: string | null,
  ): string[] {
    // Compose the prompt: a plan-mode prefix for Claude (clarifying headless
    // plan-mode restrictions) and a universal summary suffix. These are
    // team-specific prompt scaffolding — `agents run` does not apply them.
    let fullPrompt = prompt + PROMPT_SUFFIX;
    if (agentType === 'claude' && mode === 'plan') {
      fullPrompt = CLAUDE_PLAN_MODE_PREFIX + fullPrompt;
    }

    // Profile target takes precedence — `agents run <profile>` resolves the
    // host harness, version pin, and env injection in one place. Plain
    // version pins only apply when no profile is selected.
    const target = profileName ?? (version ? `${agentType}@${version}` : agentType);

    const args: string[] = [
      'run',
      target,
      fullPrompt,
      '--mode', mode,
      '--effort', effort,
      '--json',
      '--headless',
      '--quiet',
    ];
    if (model) args.push('--model', model);
    args.push('--env', 'AGENTS_RUNTIME=teams');
    return args;
  }

  private buildCommand(
    agentType: AgentType,
    prompt: string,
    mode: Mode,
    model: string | null,
    cwd: string | null = null,
    sessionId: string | null = null,
    effort: EffortLevel = 'medium',
    version: string | null = null,
    profileName: string | null = null,
  ): string[] {
    // Route through getAgentsInvocation so a teammate launched by the compiled
    // standalone binary (#315) doesn't relaunch as `agents /$bunfs/root/agents …`
    // (process.argv[1] is the bun virtual entry there) → "unknown command".
    const inv = getAgentsInvocation(
      this.buildRunArgv(agentType, prompt, mode, model, effort, version, profileName),
    );
    const cmd: string[] = [inv.command, ...inv.args];

    if (cwd) cmd.push('--cwd', cwd);

    // Pin the session UUID to our agent_id so buildExecEnv keys
    // AGENTS_MAILBOX_DIR by the same id mailboxIdForActiveSession returns.
    // Claude also forwards --session-id to its CLI (unified identity);
    // other agents ignore the flag but still get the correct mailbox dir.
    if (sessionId) {
      cmd.push('--session-id', sessionId);
    }

    // Claude: grant access to the teammate's working directory.
    if (agentType === 'claude' && cwd) {
      cmd.push('--add-dir', cwd);
    }

    // Codex's workspace-write sandbox blocks writes outside cwd. Factory
    // teammates need to run further `agents teams add` commands, which
    // write to ~/.agents/. Grant that root so subprocess-issued
    // `agents teams add` calls hit the real store.
    if (agentType === 'codex') {
      cmd.push('--add-dir', getSystemAgentsDir());
    }

    return cmd;
  }

  async get(agentId: string): Promise<AgentProcess | null> {
    await this.initialize();
    let agent = this.agents.get(agentId) || null;
    if (agent) {
      await agent.readNewEvents();
      await agent.updateStatusFromProcess();
      return agent;
    }

    agent = await AgentProcess.loadFromDisk(agentId, this.agentsDir);
    if (agent) {
      await agent.readNewEvents();
      await agent.updateStatusFromProcess();
      this.agents.set(agentId, agent);
      return agent;
    }

    return null;
  }

  /**
   * Resolve a teammate reference to a single agent_id within a team.
   * Accepts (in priority order):
   *   1. exact teammate name                ("alice")
   *   2. exact UUID                         ("b2438499-dc25-4a5e-9e02-9916012580b8")
   *   3. UUID prefix, if unique             ("b2438499")
   *
   * Returns:
   *  - { kind: 'ok', agentId }       when exactly one teammate matches
   *  - { kind: 'none' }              when nothing matches
   *  - { kind: 'ambiguous', matches } when the prefix matches multiple ids
   */
  async resolveAgentIdInTask(
    taskName: string,
    ref: string
  ): Promise<
    | { kind: 'ok'; agentId: string }
    | { kind: 'none' }
    | { kind: 'ambiguous'; matches: string[] }
  > {
    const agents = await this.listByTask(taskName);
    const byName = agents.find((a) => a.name === ref);
    if (byName) return { kind: 'ok', agentId: byName.agentId };
    const exact = agents.find((a) => a.agentId === ref);
    if (exact) return { kind: 'ok', agentId: exact.agentId };
    const prefix = agents.filter((a) => a.agentId.startsWith(ref));
    if (prefix.length === 1) return { kind: 'ok', agentId: prefix[0].agentId };
    if (prefix.length === 0) return { kind: 'none' };
    return { kind: 'ambiguous', matches: prefix.map((a) => a.agentId) };
  }

  async listAll(): Promise<AgentProcess[]> {
    await this.initialize();
    const agents = Array.from(this.agents.values());
    for (const agent of agents) {
      await agent.readNewEvents();
      await agent.updateStatusFromProcess();
    }
    return agents;
  }

  async listRunning(): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => a.status === AgentStatus.RUNNING);
  }

  async listCompleted(): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => a.status !== AgentStatus.RUNNING);
  }

  async listByTask(taskName: string): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => a.taskName === taskName);
  }

  async listByParentSession(parentSessionId: string): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => a.parentSessionId === parentSessionId);
  }

  async stopByTask(taskName: string): Promise<{ stopped: string[]; alreadyStopped: string[] }> {
    const agents = await this.listByTask(taskName);
    const stopped: string[] = [];
    const alreadyStopped: string[] = [];

    for (const agent of agents) {
      if (agent.status === AgentStatus.RUNNING) {
        const success = await this.stop(agent.agentId);
        if (success) {
          stopped.push(agent.agentId);
        }
      } else {
        alreadyStopped.push(agent.agentId);
      }
    }

    return { stopped, alreadyStopped };
  }

  async stop(agentId: string): Promise<boolean> {
    await this.initialize();
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    // Distributed teammate: no local PID — signal it over SSH. Try the process
    // GROUP first (negative pid, matching local `kill(-pid)`) to catch the
    // detached `agents run` and its children; but the remote launcher is
    // `nohup bash -lc … &` under a non-interactive shell where job control is off,
    // so `&` may NOT open a new group — fall back to signalling the wrapper pid
    // directly. Best-effort either way; the `.exit` sentinel is the durable
    // terminal-status source if a grandchild lingers.
    if (agent.hostName && agent.status === AgentStatus.RUNNING) {
      if (agent.hostTarget && agent.remotePid) {
        try {
          sshExec(agent.hostTarget, `kill -TERM -- -${agent.remotePid} 2>/dev/null || kill -TERM ${agent.remotePid} 2>/dev/null`, {
            timeoutMs: 10000,
            multiplex: true,
          });
        } catch {
          // best-effort — record the stop regardless
        }
      }
      agent.status = AgentStatus.STOPPED;
      agent.completedAt = new Date();
      await agent.saveMeta();
      debug(`Stopped remote agent ${agentId} on ${agent.hostName}`);
      return true;
    }

    if (agent.pid && agent.status === AgentStatus.RUNNING) {
      // PID-reuse guard: if the PID we recorded at spawn no longer maps to
      // our process (start-time mismatch), the OS has recycled it. Sending
      // SIGTERM/SIGKILL to -pid here would kill an unrelated process group.
      // Treat as already gone and just record the stop without signaling.
      if (!agent.isProcessAlive()) {
        debug(`Agent ${agentId} PID ${agent.pid} no longer ours (start-time mismatch or exited); skipping signal`);
        agent.status = AgentStatus.STOPPED;
        agent.completedAt = new Date();
        await agent.saveMeta();
        return true;
      }

      try {
        process.kill(-agent.pid, 'SIGTERM');
        debug(`Sent SIGTERM to agent ${agentId} (PID ${agent.pid})`);

        await new Promise(resolve => setTimeout(resolve, 2000));
        if (agent.isProcessAlive()) {
          process.kill(-agent.pid, 'SIGKILL');
          debug(`Sent SIGKILL to agent ${agentId}`);
        }
      } catch {
      }

      agent.status = AgentStatus.STOPPED;
      agent.completedAt = new Date();
      await agent.saveMeta();
      debug(`Stopped agent ${agentId}`);
      return true;
    }

    return false;
  }

  private async cleanupPartialAgent(agent: AgentProcess): Promise<void> {
    this.agents.delete(agent.agentId);
    try {
      const agentDir = await agent.getAgentDir();
      await fs.rm(agentDir, { recursive: true });
    } catch (err) {
      console.warn(`Failed to clean up agent directory:`, err);
    }
  }

  private async cleanupOldAgents(): Promise<void> {
    const completed = await this.listCompleted();
    if (completed.length > this.maxAgents) {
      completed.sort((a, b) => {
        const aTime = a.completedAt?.getTime() || 0;
        const bTime = b.completedAt?.getTime() || 0;
        return aTime - bTime;
      });
      for (const agent of completed.slice(0, completed.length - this.maxAgents)) {
        this.agents.delete(agent.agentId);
        try {
          const agentDir = await agent.getAgentDir();
          await fs.rm(agentDir, { recursive: true });
        } catch (err) {
          console.warn(`Failed to cleanup old agent ${agent.agentId}:`, err);
        }
      }
    }
  }
}
