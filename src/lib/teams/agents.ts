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
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { resolveAgentsDir } from './persistence.js';
import { normalizeEvents, AgentType } from './parsers.js';
import { debug } from './debug.js';
import { setGeminiAutoUpdateDisabled, updateGeminiSettings } from '../gemini-settings.js';
import type { AgentId } from '../types.js';
import { getAgentsDir as getSystemAgentsDir } from '../state.js';
import { AGENTS } from '../agents.js';
import { sanitizeProcessEnv } from '../secrets/bundles.js';

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
const TEAM_AGENT_TYPES: AgentType[] = ['codex', 'cursor', 'gemini', 'claude', 'opencode', 'grok', 'antigravity'];

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

/** Check whether the CLI binary for a given agent type exists in PATH. Returns [available, pathOrError]. */
export function checkCliAvailable(agentType: AgentType): [boolean, string | null] {
  const executable = AGENTS[agentType as AgentId]?.cliCommand;
  if (!executable) {
    return [false, `Unknown agent type: ${agentType}`];
  }

  try {
    const whichPath = execFileSync('which', [executable], { encoding: 'utf-8' }).trim();
    return [true, whichPath];
  } catch {
    return [false, `CLI tool '${executable}' not found in PATH. Install it first.`];
  }
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

  async readNewEvents(): Promise<void> {
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
      return agent;
    } catch {
      return null;
    }
  }

  isProcessAlive(): boolean {
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

  private async reapProcess(): Promise<number | null> {
    if (!this.pid) return null;
    try {
      process.kill(this.pid, 0);
      return null;
    } catch {
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
    if (!isCloudBacked) {
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

    const agentDir = await agent.getAgentDir();
    try {
      await fs.mkdir(agentDir, { recursive: true });
    } catch (err: any) {
      throw new Error(`Failed to create agent directory: ${err.message}`);
    }
    this.agents.set(agentId, agent);

    if (isStaged) {
      await agent.saveMeta();
      debug(`Staged ${agentType} teammate '${name}' in team '${taskName}' (after: ${cleanAfter.join(', ')})`);
    } else if (isCloudBacked) {
      // Cloud-backed teammate: the provider already dispatched a remote task.
      // No local process to launch; status polling walks the provider instead.
      await agent.saveMeta();
      debug(`Cloud-backed ${agentType} teammate via ${cloudProvider} (session=${cloudSessionId})`);
    } else {
      await this.launchProcess(agent);
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

      const childProcess = spawn(cmd[0], cmd.slice(1), {
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
      try {
        if (agent.cloudProvider) {
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
    const agentsCli = process.argv[1];

    const cmd: string[] = [
      process.execPath,
      agentsCli,
      'run',
      target,
      fullPrompt,
      '--mode', mode,
      '--effort', effort,
      '--json',
      '--headless',
      '--quiet',
    ];

    if (model) cmd.push('--model', model);
    if (cwd) cmd.push('--cwd', cwd);

    // Pin Claude's session UUID to our agent_id so its session file lands at
    // ~/.claude/projects/.../<agent_id>.jsonl — unified identity for status polling.
    if (agentType === 'claude' && sessionId) {
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
