// Wire protocol for the follower<->monitor tuple channel (foundation 3/3, #67).
//
// Followers REPORT their terminals as `(windowId, terminalId, pid, sessionId,
// workspacePath, agentType)` tuples to the elected monitor over the broadcast
// request channel (#66). The monitor keeps the union of every window's tuples
// and PUSHES the merged snapshot back as a fact, which each follower resolves
// against its own `vscode.Terminal` maps. These types are the single contract
// shared by `host.ts`, `follower.ts`, and the activation wiring — kept here so
// neither side hand-rolls (and drifts) the same shapes.

import { MonitorEvent } from './broadcastTypes';
import { AgentsViewJsonAgent } from '../core/resumeInBest';
import { WorktreeRef } from '../core/panel.helpers';

/** A single agent terminal as seen by the window that owns it. */
export interface TerminalTuple {
  /** computeWindowId(sessionId, pid) of the reporting window. */
  windowId: string;
  /** Internal tracking id of the terminal (e.g. "CC-1705123456789-1"). */
  terminalId: string;
  /** OS pid of the terminal's shell, or null before `processId` resolves. */
  pid: number | null;
  /** CLI session UUID, or null before the agent reports one. */
  sessionId: string | null;
  /** Workspace folder the terminal was opened in, or null. */
  workspacePath: string | null;
  /** 'claude' | 'codex' | 'gemini' | ..., or null when unknown. */
  agentType: string | null;
}

/** Request `op` discriminators carried on the persistent connection. */
export const MONITOR_OP = {
  /** Follower -> monitor: replace this window's tuple slice. */
  reportTuples: 'report-tuples',
  /** Follower -> monitor: pull the current merged tuple set. */
  snapshot: 'snapshot',
  /**
   * Follower -> monitor: arm agentReady detection for a shell pid (#68). The
   * monitor's readiness detector runs the process-state probe (and the
   * session-file fast path when agentKey+sessionId are known) once per pid and
   * broadcasts an `agentReady` fact. This is the cross-window successor to the
   * window-local `armAgentReady(terminal, …)` call.
   */
  armAgent: 'arm-agent',
  /**
   * Follower -> monitor: arm shell-adoption detection for a shell pid (#68).
   * The monitor walks the descendant tree once and broadcasts a
   * ShellAdoptionInfo fact when a known agent CLI appears.
   */
  armShellAdoption: 'arm-shell-adoption',
  /**
   * Follower -> monitor: replace this window's watchdog watch slice (#70). The
   * monitor's watchdog detector runs ONE machine-wide tick that stats each
   * registered session file and polls `agents view --json` per agent, then
   * broadcasts a `watchdog/stall` fact (and a `watchdog/versions` fact). The
   * window that owns the stalled session resolves the fact back to its own
   * terminal and delivers the nudge/rotate — detection is centralized, delivery
   * stays per-window. This is the cross-window successor to the window-local
   * `fs.stat`/`agents view` polling watchdog tick (watchdog.vscode.ts).
   */
  watchdogWatch: 'watchdog-watch',
  /**
   * Follower -> monitor: replace this window's panel-snapshot watch slice (#71).
   * The monitor's snapshot detector runs ONE machine-wide tick that computes the
   * GLOBAL per-tick work every visible panel/floor used to fork on its own 4s
   * poll — `git branch`/`git diff --numstat HEAD` per workspace, `git worktree
   * list`, `agents view <type> --json` usage per agent, and `agents teams list`
   * per cwd — then broadcasts ONE `panel-snapshot` fact. Windows render from the
   * broadcast instead of each spawning the subprocesses. This is the cross-window
   * successor to `buildSnapshot` (agentPanel) + `getWorkspaceGitInfo` (terminals);
   * the local compute stays as the disconnected-case fallback.
   */
  snapshotWatch: 'snapshot-watch',
} as const;

export interface ReportTuplesRequest {
  op: typeof MONITOR_OP.reportTuples;
  windowId: string;
  tuples: TerminalTuple[];
}

export interface SnapshotRequest {
  op: typeof MONITOR_OP.snapshot;
}

export interface ArmAgentRequest {
  op: typeof MONITOR_OP.armAgent;
  /** Shell pid (root of the process tree) to watch for an idle agent child. */
  pid: number;
  /** Known agent key, enabling the session-file fast path when paired with a sessionId. */
  agentKey?: string;
  sessionId?: string;
}

export interface ArmShellAdoptionRequest {
  op: typeof MONITOR_OP.armShellAdoption;
  /** Shell pid whose descendant tree is walked for a known agent CLI. */
  pid: number;
}

/** Agent kinds the watchdog detector monitors for stalls. */
export type WatchdogAgentType = 'claude' | 'codex' | 'gemini';

/** One session the owning window asks the monitor to watch for a stall (#70). */
export interface WatchdogWatch {
  /** CLI session UUID — the key the stall fact is broadcast under. */
  sessionId: string;
  agentType: WatchdogAgentType;
  /** Absolute path to the session file the detector stats for staleness. */
  sessionFilePath: string;
  /** Idle threshold before a session counts as stalled. */
  stallMs: number;
  /** Beyond this the session is dormant — detector stays silent. */
  dormantMs: number;
  /** When set, the detector also polls `agents view <agentKey> --json`. */
  rotateAgentKey?: string;
}

export interface WatchdogWatchRequest {
  op: typeof MONITOR_OP.watchdogWatch;
  windowId: string;
  watches: WatchdogWatch[];
}

/** One workspace/agent tuple a window asks the monitor to snapshot (#71). */
export interface SnapshotWatch {
  /** Workspace root — `git branch`/`git diff --numstat` + worktree list keyed here. */
  workspaceRoot: string;
  /** Active terminal cwd — `agents teams list` keyed here. Defaults to workspaceRoot. */
  cwd?: string;
  /** Bound agent type — `agents view <type> --json` usage keyed here. */
  agentType?: string;
}

export interface SnapshotWatchRequest {
  op: typeof MONITOR_OP.snapshotWatch;
  windowId: string;
  watches: SnapshotWatch[];
}

export type MonitorRequest =
  | ReportTuplesRequest
  | SnapshotRequest
  | ArmAgentRequest
  | ArmShellAdoptionRequest
  | WatchdogWatchRequest
  | SnapshotWatchRequest;

export interface ReportTuplesAck {
  ok: true;
  windowId: string;
  count: number;
}

export interface SnapshotReply {
  tuples: TerminalTuple[];
}

/** Generic ack for the fire-and-forget arm ops. */
export interface ArmAck {
  ok: true;
}

/** The readiness milestones the monitor broadcasts, keyed by pid (#68). */
export type ReadinessEventName =
  | 'tabReady'
  | 'shellReady'
  | 'promptReady'
  | 'agentReady';

/** Event `type` the monitor broadcasts. */
export const MONITOR_FACT = {
  tuplesSnapshot: 'monitor.tuples-snapshot',
  /** A terminal readiness milestone reached for a shell pid (#68). */
  readiness: 'monitor.readiness',
  /** A known agent CLI was adopted under a shell pid (#68). */
  shellAdoption: 'monitor.shell-adoption',
  /** A new/changed session file was parsed by the machine-wide watcher (#69). */
  session: 'monitor.session',
  /** A tracked session file was written (warmth signal for kill/restart). */
  sessionWarmth: 'monitor.session-warmth',
  /** A watched session has gone idle past its stall threshold (#70). */
  watchdogStall: 'monitor.watchdog-stall',
  /** `agents view <agentKey> --json` polled once machine-wide (#70). */
  watchdogVersions: 'monitor.watchdog-versions',
  /** The merged panel/floor snapshot computed once machine-wide (#71). */
  panelSnapshot: 'monitor.panel-snapshot',
} as const;

export interface TuplesSnapshotPayload {
  tuples: TerminalTuple[];
}

/** A readiness milestone reached for a shell pid. */
export interface ReadinessFactPayload {
  pid: number;
  event: ReadinessEventName;
}

/** The mirror of `ShellAdoptionInfo` (terminalReadiness.ts), keyed by shell pid. */
export interface ShellAdoptionFactPayload {
  /** The shell pid whose descendant tree the agent was found in. */
  pid: number;
  agentKey: string;
  sessionId?: string;
  childPid: number;
}

/** Agent kinds the machine-wide session watcher recognizes. */
export type SessionAgentKind = 'claude' | 'codex' | 'gemini' | 'opencode';

/**
 * A new/changed session file parsed by the machine-wide watcher (#69). Carries
 * the same head metadata `sessionTracker` parses locally today, so a follower
 * runs the identical (window-local) correlation against its own terminals
 * without re-reading the file.
 */
export interface SessionFactPayload {
  agentType: SessionAgentKind;
  /** Absolute path to the session file. */
  filePath: string;
  /** session id derived from the filename. */
  fileSessionId: string;
  mtimeMs: number;
  forkedFromId?: string;
  codexCwd?: string;
  geminiProjectHash?: string;
  geminiSessionId?: string;
  opencodeDirectory?: string;
  opencodeSessionId?: string;
}

/** A tracked session file was written — keeps the follower's dormancy clock. */
export interface SessionWarmthPayload {
  filePath: string;
  ts: number;
}

/**
 * A watched session has been idle past its stall threshold (#70). Broadcast by
 * the leader's watchdog detector keyed by `sessionId`; the window that owns that
 * session resolves it to its own `vscode.Terminal` and runs the nudge pipeline.
 */
export interface WatchdogStallPayload {
  sessionId: string;
  agentType: WatchdogAgentType;
  /** How long the session file has been untouched (now - mtime). */
  idleMs: number;
  mtimeMs: number;
}

/**
 * The parsed result of one machine-wide `agents view <agentKey> --json` poll
 * (#70). Windows consume this for the auto-rotate exhaustion check instead of
 * each spawning the CLI; they fall back to a local fetch while disconnected.
 */
export interface WatchdogVersionsPayload {
  agentKey: string;
  view: AgentsViewJsonAgent;
}

/** Per-workspace git facts (`git branch --show-current` + `git diff --numstat HEAD`). */
export interface GitNumstat {
  branch: string | null;
  /** Keyed by BOTH the relative and the absolute path, mirroring getWorkspaceGitInfo. */
  numstat: Record<string, { added: number; removed: number }>;
}

/**
 * The merged panel/floor snapshot the leader's snapshot detector computes once
 * per tick and broadcasts (#71). Each map is keyed so a follower looks up only
 * the slice its visible panel needs:
 *   - gitByRoot / worktreesByRoot — keyed by workspace root
 *   - teamsByCwd                  — keyed by the active terminal cwd
 *   - usageByAgent                — keyed by agent type (the raw `agents view`)
 *
 * `teamsByCwd` carries `unknown[]` so this wire type stays vscode-free; the
 * consumer casts each entry back to its `TeamWithMates`.
 */
export interface PanelSnapshotPayload {
  gitByRoot: Record<string, GitNumstat>;
  worktreesByRoot: Record<string, WorktreeRef[]>;
  teamsByCwd: Record<string, unknown[]>;
  usageByAgent: Record<string, AgentsViewJsonAgent>;
  ts: number;
}

/** Narrow a raw broadcast event to a tuples-snapshot fact. */
export function isTuplesSnapshot(
  event: MonitorEvent,
): event is MonitorEvent & { payload: TuplesSnapshotPayload } {
  return (
    event.type === MONITOR_FACT.tuplesSnapshot &&
    !!event.payload &&
    Array.isArray((event.payload as TuplesSnapshotPayload).tuples)
  );
}

/** Narrow a raw broadcast event to a readiness fact. */
export function isReadinessFact(
  event: MonitorEvent,
): event is MonitorEvent & { payload: ReadinessFactPayload } {
  const p = event.payload as ReadinessFactPayload | undefined;
  return (
    event.type === MONITOR_FACT.readiness &&
    !!p &&
    typeof p.pid === 'number' &&
    typeof p.event === 'string'
  );
}

/** Narrow a raw broadcast event to a shell-adoption fact. */
export function isShellAdoptionFact(
  event: MonitorEvent,
): event is MonitorEvent & { payload: ShellAdoptionFactPayload } {
  const p = event.payload as ShellAdoptionFactPayload | undefined;
  return (
    event.type === MONITOR_FACT.shellAdoption &&
    !!p &&
    typeof p.pid === 'number' &&
    typeof p.agentKey === 'string' &&
    typeof p.childPid === 'number'
  );
}

/** Narrow a raw broadcast event to a session fact. */
export function isSessionFact(
  event: MonitorEvent,
): event is MonitorEvent & { payload: SessionFactPayload } {
  const p = event.payload as SessionFactPayload | undefined;
  return (
    event.type === MONITOR_FACT.session &&
    !!p &&
    typeof p.agentType === 'string' &&
    typeof p.filePath === 'string'
  );
}

/** Narrow a raw broadcast event to a session-warmth fact. */
export function isSessionWarmth(
  event: MonitorEvent,
): event is MonitorEvent & { payload: SessionWarmthPayload } {
  const p = event.payload as SessionWarmthPayload | undefined;
  return (
    event.type === MONITOR_FACT.sessionWarmth &&
    !!p &&
    typeof p.filePath === 'string'
  );
}

/** Narrow a raw broadcast event to a watchdog stall fact (#70). */
export function isWatchdogStall(
  event: MonitorEvent,
): event is MonitorEvent & { payload: WatchdogStallPayload } {
  const p = event.payload as WatchdogStallPayload | undefined;
  return (
    event.type === MONITOR_FACT.watchdogStall &&
    !!p &&
    typeof p.sessionId === 'string' &&
    typeof p.idleMs === 'number'
  );
}

/** Narrow a raw broadcast event to a panel-snapshot fact (#71). */
export function isPanelSnapshot(
  event: MonitorEvent,
): event is MonitorEvent & { payload: PanelSnapshotPayload } {
  const p = event.payload as PanelSnapshotPayload | undefined;
  return (
    event.type === MONITOR_FACT.panelSnapshot &&
    !!p &&
    typeof p.gitByRoot === 'object' &&
    typeof p.worktreesByRoot === 'object' &&
    typeof p.usageByAgent === 'object'
  );
}

/** Narrow a raw broadcast event to a watchdog versions fact (#70). */
export function isWatchdogVersions(
  event: MonitorEvent,
): event is MonitorEvent & { payload: WatchdogVersionsPayload } {
  const p = event.payload as WatchdogVersionsPayload | undefined;
  return (
    event.type === MONITOR_FACT.watchdogVersions &&
    !!p &&
    typeof p.agentKey === 'string' &&
    !!p.view &&
    Array.isArray((p.view as AgentsViewJsonAgent).versions)
  );
}
