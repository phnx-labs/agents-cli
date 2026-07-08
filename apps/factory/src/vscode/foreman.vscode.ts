// Foreman: voice coordinator for the factory floor.
//
// Extension host responsibilities:
//   1. Compute the live floor digest on demand and return it to the webview,
//      which forwards it to the realtime model as a tool result.
// (Audio I/O + the Realtime WebSocket live in foreman.audio.ts.)

import * as vscode from 'vscode';
import {
  buildForemanDigest,
  ForemanDigest,
  ForemanTerminal,
  ForemanCloudTask,
  ForemanTeamRollup,
  MAX_DETAILED_AGENTS,
} from '../core/foreman.digest';
import { prefixToAgentType } from '../core/utils';
import { UnifiedTask, CycleInfo } from '../core/tasks';
import { summarizeCycle } from '../core/foreman.cycle';
import {
  listLocalSessions,
  readSessionEvents,
  listCloudTasks,
  listTeams,
  getTeamStatus,
  getLastSourcesError,
  getCloudTask,
  listRoutines,
  listDevices,
  getUsage,
  SessionLite,
  SessionEvent,
  CloudTaskLite,
  TeamLite,
} from './foreman.sources';
import { readLiveTerminals, LiveTerminal } from './foreman.registry';
import {
  FOREMAN_MODEL,
  FOREMAN_VOICE,
  FOREMAN_SYSTEM_PROMPT,
  FOREMAN_TOOLS,
  ForemanTool,
} from '../core/foreman.config';

// Re-export so existing importers (settings.vscode.ts) keep working without
// caring that the canonical home is now core/foreman.config.
export {
  FOREMAN_MODEL,
  FOREMAN_VOICE,
  FOREMAN_SYSTEM_PROMPT,
  FOREMAN_TOOLS,
  ForemanTool,
};


// Two canonical sources for "what's on the factory floor":
//   1. Live terminals across EVERY IDE window (from the shared registry) -
//      authoritative for "actually running right now"
//   2. Local session metadata from agents-cli (topic, project, gitBranch,
//      tokenCount) - enrichment only, agents-cli doesn't know pid liveness
// Plus two auxiliary sources: cloud dispatches and team DAGs.
export async function computeBriefing(_workspacePath?: string): Promise<ForemanDigest> {
  const live = readLiveTerminals();
  const liveIds = new Set(live.map((t) => t.sessionId));

  const [sessions, cloud, teams] = await Promise.all([
    listLocalSessions({ since: '2h', limit: 30, all: true }),
    listCloudTasks(),
    listTeams(),
  ]);

  // Merge: every live terminal becomes an agent. Enrich with session metadata
  // if agents-cli has it (matched by sessionId).
  const sessionsById = new Map(sessions.map((s) => [s.id, s] as const));
  const agents: ForemanTerminal[] = live.map((t) =>
    liveTerminalToForemanTerminal(t, sessionsById.get(t.sessionId))
  );
  // Also include recently-active sessions that AREN'T currently open as live
  // terminals - they may have been closed in the last 2h and are worth
  // mentioning as "just finished" context.
  for (const s of sessions) {
    if (liveIds.has(s.id)) continue;
    agents.push(sessionToForemanTerminal(s, false));
  }

  // Enrich the most-recently-started live agents with REAL activity from the
  // same normalized feed focus() reads (agents sessions <id> --json), so
  // briefing and focus never disagree about what an agent is doing. Without
  // this, every live agent is a hardcoded status:'working' with no last_tool -
  // a hung agent looks identical to a productive one, and the 'waiting' concern
  // can never fire. Capped at the detailed-row limit so the extra per-session
  // round-trips don't stall the voice turn.
  await enrichLiveAgentsFromFeed(agents);

  const cloudDigest: ForemanCloudTask[] = cloud
    .filter((c) => c.status === 'running' || c.status === 'needs_review' || c.status === 'completed')
    .slice(0, 10)
    .map((c) => ({
      id: c.id,
      provider: c.provider,
      agent: c.agent,
      status: c.status,
      prompt: c.prompt,
      repo: c.repo ?? null,
      updated: c.updatedAt ?? '',
    }));

  const teamDigest: ForemanTeamRollup[] = teams.slice(0, 10).map((t) => ({
    name: t.task_name,
    running: t.running,
    pending: t.pending,
    completed: t.completed,
    failed: t.failed,
  }));

  const digest = buildForemanDigest(agents, cloudDigest, teamDigest);
  // If every source came back empty AND the sources layer logged an error,
  // surface it so the foreman can narrate the real problem instead of saying
  // "floor is empty" when the floor is actually unreachable.
  if (agents.length === 0 && cloudDigest.length === 0 && teamDigest.length === 0) {
    const err = getLastSourcesError();
    if (err) {
      digest.concerns.unshift(`agents-cli unreachable: ${err}`);
    }
  }
  return digest;
}

// Fill in real activity (last_tool, recent tools/files, true last-activity
// time) for the most-recent live agents by reading the SAME normalized event
// feed focus() uses. Runs readSessionEvents + summarizeTail - one code path,
// so briefing and focus can never diverge. Setting status=null hands status
// derivation back to deriveStatus (working/waiting/idle from real activity)
// instead of the fake hardcoded 'working'.
async function enrichLiveAgentsFromFeed(agents: ForemanTerminal[]): Promise<void> {
  const targets = agents
    .filter((a) => a.openInIde && a.sessionId)
    .sort((x, y) => (y.startedAtMs ?? 0) - (x.startedAtMs ?? 0))
    .slice(0, MAX_DETAILED_AGENTS);
  await Promise.all(
    targets.map(async (a) => {
      const events = await readSessionEvents(a.sessionId as string, 30);
      if (!events.length) return;
      const tail = summarizeTail(events);
      a.lastActivityMs = tail.lastEventAtMs ?? a.lastActivityMs;
      a.lastTool = tail.lastTool;
      a.lastFilePath = tail.lastFile;
      a.recentTools = tail.recentTools;
      a.recentFiles = tail.recentFiles;
      a.filesEdited = tail.filesEdited;
      a.toolCalls = tail.toolCalls;
      a.status = null; // deriveStatus computes real status from lastActivityMs
    })
  );
}

function sessionToForemanTerminal(s: SessionLite, openInIde: boolean): ForemanTerminal {
  const startedAt = s.timestamp ? Date.parse(s.timestamp) : null;
  return {
    name: expand(s.agent),
    kind: s.agent,
    label: s.label ?? null,
    sessionId: s.id,
    project: s.project ?? null,
    openInIde,
    startedAtMs: startedAt,
    lastActivityMs: startedAt,
    lastTool: null,
    status: null,
    task: s.topic ?? null,
    recentFiles: [],
    recentTools: [],
    filesEdited: 0,
    toolCalls: 0,
  };
}

// Primary path: a live VS Code terminal is definitely running. If agents-cli
// has session metadata for its sessionId, merge it in for project/topic/etc.
function liveTerminalToForemanTerminal(t: LiveTerminal, s?: SessionLite): ForemanTerminal {
  const startedAt = s?.timestamp ? Date.parse(s.timestamp) : t.startedAtMs;
  return {
    name: expand(t.kind),
    kind: t.kind,
    label: t.label ?? s?.label ?? null,
    sessionId: t.sessionId,
    project: s?.project ?? (t.cwd ? t.cwd.split('/').pop() ?? null : null),
    openInIde: true,
    startedAtMs: startedAt,
    lastActivityMs: startedAt,
    lastTool: null,
    status: 'working',     // a live pid means working by definition
    task: s?.topic ?? null,
    recentFiles: [],
    recentTools: [],
    filesEdited: 0,
    toolCalls: 0,
  };
}

function expand(kind: string): string {
  switch (kind) {
    case 'claude': return 'Claude';
    case 'codex': return 'Codex';
    case 'gemini': return 'Gemini';
    case 'opencode': return 'OpenCode';
    case 'openclaw': return 'OpenClaw';
    default: return kind;
  }
}

// Deep detail for one agent. Matches by label substring, kind, or session id
// prefix. Reads the normalized event tail from agents-cli for the truly live
// bits (last tool, last file, recent tool calls) that the lean briefing skips.
export async function computeFocus(who: string, _workspacePath?: string): Promise<unknown> {
  const q = (who ?? '').trim().toLowerCase();
  if (!q) return { error: 'no query' };

  const local = await listLocalSessions({ since: '6h', limit: 60, all: true });
  const matches = local.filter((s) => {
    if (s.label && s.label.toLowerCase().includes(q)) return true;
    if (s.topic && s.topic.toLowerCase().includes(q)) return true;
    if (s.agent.toLowerCase() === q) return true;
    if (s.id.toLowerCase().startsWith(q)) return true;
    if (s.shortId && s.shortId.toLowerCase().startsWith(q)) return true;
    return false;
  });

  if (matches.length === 0) {
    return {
      error: `no agent matching "${who}"`,
      available: local.slice(0, 10).map((s) => s.label ?? s.topic ?? `${s.agent} ${s.shortId}`),
    };
  }

  // Ambiguous: N agents match (e.g. "focus on Claude" with three Claudes).
  // Return the candidates instead of silently picking one, mirroring
  // message_agent's disambiguation contract so the model reads them back and
  // asks which one - never reports an arbitrary agent as if it were the answer.
  if (matches.length > 1) {
    return {
      ambiguous: true,
      query: who,
      candidates: matches.slice(0, 6).map((s) => ({
        who: s.label ?? s.shortId,
        kind: s.agent,
        label: s.label ?? null,
        project: s.project ?? null,
        task: s.topic ?? null,
      })),
    };
  }

  const match = matches[0];

  const events = await readSessionEvents(match.id, 30);
  const tail = summarizeTail(events);
  const openIds = new Set(readLiveTerminals().map((t) => t.sessionId));
  const startedMs = match.timestamp ? Date.parse(match.timestamp) : Date.now();
  const lastActivityMs = tail.lastEventAtMs ?? startedMs;

  return {
    kind: match.agent,
    label: match.label ?? null,
    project: match.project ?? null,
    git_branch: match.gitBranch ?? null,
    open_in_ide: openIds.has(match.id),
    elapsed: humanElapsedFromMs(Date.now() - startedMs),
    since_last_activity: humanElapsedFromMs(Date.now() - lastActivityMs),
    status: tail.status,
    task: match.topic ?? null,
    token_count: match.tokenCount ?? null,
    last_tool: tail.lastTool,
    last_file: tail.lastFile,
    last_bash: tail.lastBash,
    recent_tools: tail.recentTools,
    recent_files: tail.recentFiles,
    files_edited: tail.filesEdited,
    tool_calls: tail.toolCalls,
  };
}

// Per-teammate breakdown of one team DAG (name, type, status, duration).
async function computeTeamDetail(team: string): Promise<unknown> {
  const mates = await getTeamStatus(team);
  if (mates.length === 0) return { error: `no team matching "${team}", or it has no teammates` };
  return {
    team,
    teammates: mates.map((m) => ({
      name: m.name,
      kind: m.agent_type,
      status: m.status,
      duration: m.duration ?? undefined,
    })),
  };
}

async function computeCloudStatus(id: string): Promise<unknown> {
  const task = await getCloudTask(id);
  if (!task) return { error: `no cloud task "${id}"` };
  return {
    id: task.id,
    provider: task.provider,
    agent: task.agent,
    status: task.status,
    repo: task.repo ?? undefined,
    prompt: task.prompt || undefined,
  };
}

// Rate-limit posture per agent. usage has no --json, so this reads view --json
// and reports the tightest window per agent (see getUsage).
async function computeQuota(): Promise<unknown> {
  const usage = await getUsage();
  if (usage.length === 0) return { error: 'no usage data available' };
  const now = Date.now();
  return {
    agents: usage.map((u) => {
      const resetMs = u.soonestResetAt ? Date.parse(u.soonestResetAt) : NaN;
      return {
        agent: u.agent,
        plan: u.plan ?? undefined,
        status: u.usageStatus ?? undefined,
        used_percent: u.maxUsedPercent,
        resets_in: Number.isFinite(resetMs) && resetMs > now
          ? humanElapsedFromMs(resetMs - now)
          : undefined,
      };
    }),
  };
}

async function computeRoutines(): Promise<unknown> {
  const routines = await listRoutines();
  if (routines.length === 0) return { routines: [], note: 'no routines scheduled' };
  return {
    routines: routines.slice(0, 12).map((r) => ({
      name: r.name,
      agent: r.agent,
      schedule: r.scheduleHuman ?? r.schedule,
      enabled: r.enabled,
      overdue: r.overdue || undefined,
      next: r.nextRunHuman ?? undefined,
      last_status: r.lastStatus ?? undefined,
    })),
  };
}

async function computeFleet(): Promise<unknown> {
  const devices = await listDevices();
  if (devices.length === 0) return { machines: [], note: 'no devices registered' };
  return {
    machines: devices.map((d) => ({
      name: d.name,
      platform: d.platform,
      online: d.online,
      relay: d.relay ?? undefined,
    })),
  };
}

interface TailSummary {
  lastEventAtMs: number | null;
  status: 'idle' | 'working' | 'waiting' | 'blocked';
  lastTool: string | null;
  lastFile: string | null;
  lastBash: string | null;
  recentTools: string[];
  recentFiles: string[];
  filesEdited: number;
  toolCalls: number;
}

function summarizeTail(events: SessionEvent[]): TailSummary {
  const toolCallNames: string[] = [];
  const filesSeen: string[] = [];
  const filesEditedSet = new Set<string>();
  let lastTool: string | null = null;
  let lastFile: string | null = null;
  let lastBash: string | null = null;
  let lastEventAtMs: number | null = null;

  for (const e of events) {
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;
    if (ts && (!lastEventAtMs || ts > lastEventAtMs)) lastEventAtMs = ts;

    if (e.type === 'tool_use') {
      toolCallNames.push(e.tool ?? '');
      if (e.tool) lastTool = e.tool;
      if (e.path) {
        lastFile = e.path;
        filesSeen.push(e.path);
      }
      const isEdit = e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'MultiEdit';
      if (isEdit && e.path) filesEditedSet.add(e.path);
      if (e.tool === 'Bash' && e.args && typeof (e.args as { command?: unknown }).command === 'string') {
        lastBash = String((e.args as { command: string }).command).slice(0, 200);
      }
    }
  }

  const status: TailSummary['status'] =
    !lastEventAtMs ? 'idle'
    : Date.now() - lastEventAtMs < 60_000 ? 'working'
    : Date.now() - lastEventAtMs < 10 * 60_000 ? 'waiting'
    : 'idle';

  return {
    lastEventAtMs,
    status,
    lastTool,
    lastFile,
    lastBash,
    recentTools: dedup(toolCallNames).slice(-5),
    recentFiles: dedup(filesSeen).slice(-5),
    filesEdited: filesEditedSet.size,
    toolCalls: toolCallNames.length,
  };
}

function dedup<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function humanElapsedFromMs(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

// Convenience: read the OpenAI key from settings exactly once. Matches the
// existing `agents.openaiApiKey` setting used for commit message generation.
export function getOpenAIApiKey(): string {
  return vscode.workspace.getConfiguration('agents').get<string>('openaiApiKey', '').trim();
}

// Callbacks the caller supplies so foreman.vscode.ts doesn't have to import
// from settings.vscode / tasks.vscode (which would create a cycle through
// foreman.audio -> foreman.vscode).
export interface ForemanTaskDetails {
  id: string;
  title: string;
  description: string | null;
  priority: string | null;
  status: string | null;
  assignee: string | null;
  labels: string[];
  source: string;
  resolved_repo: string | null;
}

export interface ForemanDispatchOpts {
  id: string;
  agent?: string;
  target?: 'cloud' | 'local';
  repo?: string;
}

export interface ForemanDispatchResult {
  ok: boolean;
  message: string;
  dispatched?: { id: string; agent: string; target: string; repos: string[] };
}

export interface ForemanCreateTicketOpts {
  title: string;
  description?: string;
  priority?: string;
  labels?: string[];
  assign?: string;
}

export interface ForemanCreateTicketResult {
  ok: boolean;
  message: string;
  identifier?: string;
  title?: string;
}

export interface ForemanToolDeps {
  fetchCycleTasks?: () => Promise<{ tasks: UnifiedTask[]; cycleInfo: CycleInfo | null }>;
  fetchTaskDetails?: (id: string) => Promise<ForemanTaskDetails | null>;
  dispatchTask?: (opts: ForemanDispatchOpts) => Promise<ForemanDispatchResult>;
  spawnAgent?: (opts: { prompt: string; agent?: string; target?: string }) => Promise<{ ok: boolean; message: string }>;
  messageAgent?: (opts: { who: string; prompt: string }) => Promise<{ ok: boolean; message: string; candidates?: string[] }>;
  createTicket?: (opts: ForemanCreateTicketOpts) => Promise<ForemanCreateTicketResult>;
}

// Tool dispatch: runs a named Foreman tool and returns a JSON-serializable
// result the webview can forward back to the model as function_call_output.
export async function runForemanTool(
  name: string,
  args: unknown,
  workspacePath?: string,
  deps?: ForemanToolDeps
): Promise<unknown> {
  switch (name) {
    case 'briefing':
      return computeBriefing(workspacePath);
    case 'focus': {
      const who = (args && typeof args === 'object' && 'who' in args)
        ? String((args as { who?: unknown }).who ?? '')
        : '';
      return computeFocus(who, workspacePath);
    }
    case 'team_detail': {
      const team = (args && typeof args === 'object' && 'team' in args)
        ? String((args as { team?: unknown }).team ?? '').trim()
        : '';
      if (!team) return { error: 'no team named' };
      return computeTeamDetail(team);
    }
    case 'cloud_status': {
      const id = (args && typeof args === 'object' && 'id' in args)
        ? String((args as { id?: unknown }).id ?? '').trim()
        : '';
      if (!id) return { error: 'no cloud task id' };
      return computeCloudStatus(id);
    }
    case 'quota':
      return computeQuota();
    case 'routines':
      return computeRoutines();
    case 'fleet':
      return computeFleet();
    case 'cycle': {
      if (!deps?.fetchCycleTasks) {
        return { error: 'cycle tool unavailable: no task source wired' };
      }
      const { tasks, cycleInfo } = await deps.fetchCycleTasks();
      return summarizeCycle(tasks, cycleInfo);
    }
    case 'task_details': {
      if (!deps?.fetchTaskDetails) {
        return { error: 'task_details tool unavailable: no task source wired' };
      }
      const id = (args && typeof args === 'object' && 'id' in args)
        ? String((args as { id?: unknown }).id ?? '').trim()
        : '';
      if (!id) return { error: 'no ticket id' };
      const details = await deps.fetchTaskDetails(id);
      if (!details) return { error: `no ticket matching "${id}"` };
      return details;
    }
    case 'dispatch': {
      if (!deps?.dispatchTask) {
        return { ok: false, message: 'dispatch tool unavailable: no dispatcher wired' };
      }
      const a = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
      const id = String(a.id ?? '').trim();
      if (!id) return { ok: false, message: 'no ticket id' };
      const agent = typeof a.agent === 'string' ? a.agent : undefined;
      const target = a.target === 'local' ? 'local' : a.target === 'cloud' ? 'cloud' : undefined;
      const repo = typeof a.repo === 'string' && a.repo.trim() ? a.repo.trim() : undefined;
      return deps.dispatchTask({ id, agent, target, repo });
    }
    case 'spawn_agent': {
      if (!deps?.spawnAgent) {
        return { ok: false, message: 'spawn_agent tool unavailable' };
      }
      const a = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
      const prompt = String(a.prompt ?? '').trim();
      if (!prompt) return { ok: false, message: 'no prompt given' };
      const agent = typeof a.agent === 'string' && a.agent.trim() ? a.agent.trim() : undefined;
      const target = typeof a.target === 'string' && a.target.trim() ? a.target.trim() : undefined;
      return deps.spawnAgent({ prompt, agent, target });
    }
    case 'message_agent': {
      if (!deps?.messageAgent) {
        return { ok: false, message: 'message_agent tool unavailable' };
      }
      const a = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
      const who = String(a.who ?? '').trim();
      const prompt = String(a.prompt ?? '').trim();
      if (!who) return { ok: false, message: 'no agent named' };
      if (!prompt) return { ok: false, message: 'no message given' };
      return deps.messageAgent({ who, prompt });
    }
    case 'create_ticket': {
      if (!deps?.createTicket) {
        return { ok: false, message: 'create_ticket tool unavailable: no creator wired' };
      }
      const a = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
      const title = String(a.title ?? '').trim();
      if (!title) return { ok: false, message: 'no ticket title' };
      const description = typeof a.description === 'string' && a.description.trim() ? a.description.trim() : undefined;
      const priority = typeof a.priority === 'string' && a.priority.trim() ? a.priority.trim().toLowerCase() : undefined;
      const assign = typeof a.assign === 'string' && a.assign.trim() ? a.assign.trim() : undefined;
      const labels = Array.isArray(a.labels)
        ? (a.labels as unknown[])
            .filter((l) => typeof l === 'string' && l.trim().length > 0)
            .map((l) => (l as string).trim())
        : undefined;
      return deps.createTicket({ title, description, priority, labels, assign });
    }
    default:
      throw new Error(`Unknown Foreman tool: ${name}`);
  }
}


// Quiet prefix used in realtime instructions to remind the model to be tight.
// Exposed as a separate export so the webview can optionally override.
export { prefixToAgentType };
