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

/** One workspace/agent tuple a window asks the monitor to snapshot (#71). */
export type MonitorRequest =
  | ReportTuplesRequest
  | SnapshotRequest
  | ArmAgentRequest
  | ArmShellAdoptionRequest;

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
  /** Versioned session state emitted by the agents-cli watch stream. */
  sessionCli: 'monitor.session-cli',
} as const;

export interface SessionCliFactPayload {
  /** Adapter seam for Track B: accept canonical `v` and legacy `version`. */
  version?: 1;
  v?: 1;
  type: 'reset' | 'agent.upsert' | 'attention.upsert' | 'attention.remove' | 'activity.append' | 'scope' | 'heartbeat';
  streamId: string;
  sequence: number;
  capturedAt: number;
  scope: string;
  agents?: unknown[];
  attention?: unknown[] | unknown;
  agent?: unknown;
  resolution?: unknown;
  event?: unknown;
  rowKey?: string;
  status?: 'available' | 'unavailable';
  reason?: string;
}

export function isSessionCliFact(
  event: MonitorEvent,
): event is MonitorEvent & { payload: SessionCliFactPayload } {
  const payload = event.payload as SessionCliFactPayload | undefined;
  return event.type === MONITOR_FACT.sessionCli
    && !!payload
    && (payload.v === 1 || payload.version === 1)
    && typeof payload.streamId === 'string'
    && Number.isInteger(payload.sequence)
    && typeof payload.type === 'string';
}

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
