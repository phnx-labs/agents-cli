// Monitor host runtime — foundation 3/3 of the centralized-monitor epic (#64),
// extended by the migrations (#68, #69).
//
// The elected leader (#65) == the monitor. While this window holds the lease it
// runs ONE `MonitorBroadcastServer` (#66); followers connect to it, report their
// terminal tuples, and receive the merged snapshot back as a broadcast fact.
// When `detectors` is enabled the host ALSO runs the centralized work:
//   - a ReadinessDetector (#68) fed the union of all windows' shell pids, which
//     broadcasts tabReady/shellReady/promptReady/agentReady + ShellAdoptionInfo
//     facts keyed by pid;
//   - a SessionWatcher (#69) that watches each session root once and broadcasts
//     parsed session + warmth facts.
// Followers map every fact back to their own terminals window-locally.
//
// Kept vscode-free so it runs and tests in a plain process against real Unix
// sockets and real subprocesses/files (see *.test.ts).

import * as path from 'path';
import { MonitorBroadcastServer } from './broadcast';
import { MonitorEvent } from './broadcastTypes';
import {
  ArmAck,
  ArmAgentRequest,
  ArmShellAdoptionRequest,
  MONITOR_FACT,
  MONITOR_OP,
  MonitorRequest,
  PanelSnapshotPayload,
  ReadinessFactPayload,
  ReportTuplesAck,
  SessionFactPayload,
  SessionWarmthPayload,
  ShellAdoptionFactPayload,
  SnapshotReply,
  SnapshotWatchRequest,
  TerminalTuple,
  TuplesSnapshotPayload,
  WatchdogStallPayload,
  WatchdogVersionsPayload,
  WatchdogWatchRequest,
} from './protocol';
import { ReadinessDetector } from './readinessDetector';
import { SessionWatcher } from './sessionWatcher';
import { WatcherRoot } from './sessionParse';
import { WatchdogDetector } from './watchdogDetector';
import { SnapshotDetector } from './snapshotDetector';
import { AgentsViewJsonAgent } from '../core/resumeInBest';

/** Enable + configure the centralized detectors (#68, #69). */
export interface MonitorDetectorOptions {
  /** Run the pid-keyed readiness detector. Default true. */
  readiness?: boolean;
  /** Run the machine-wide session watcher. Default true. */
  session?: boolean;
  /** Override the session-watcher roots (tests). */
  sessionRoots?: WatcherRoot[];
  /** Session-watcher debounce (tests). */
  sessionDebounceMs?: number;
  /** Run the sessionId-keyed watchdog stall detector (#70). Default true. */
  watchdog?: boolean;
  /** Watchdog stat cadence (tests). */
  watchdogTickMs?: number;
  /** Watchdog `agents view` cadence (tests). */
  watchdogViewPollMs?: number;
  /** Inject the `agents view` fetcher (tests). */
  watchdogFetchView?: (agentKey: string) => Promise<AgentsViewJsonAgent | null>;
  /** Run the panel/floor snapshot detector (#71). Default true. */
  snapshot?: boolean;
  /** Snapshot recompute cadence (tests). */
  snapshotTickMs?: number;
  /**
   * Inject the vscode-coupled `agents teams list` fetcher (#71). The wiring layer
   * (extension.ts) supplies `listTeamsForCwd`; omitted in tests/standalone so the
   * snapshot fact simply carries no teams.
   */
  snapshotFetchTeams?: (cwd: string) => Promise<unknown[]>;
}

export interface MonitorHostOptions {
  /** Override the broadcast socket path (tests). */
  socketPath?: string;
  /**
   * Run the centralized probes/watchers (#68, #69). Omit (or undefined) to run
   * a tuple-only host — the foundation behavior used by the #67 tests.
   */
  detectors?: MonitorDetectorOptions;
}

export class MonitorHost {
  private readonly server: MonitorBroadcastServer;
  // windowId -> that window's last-reported tuple slice. The union across all
  // slices is the global terminal set the monitor broadcasts. Slices are keyed
  // by window so a re-report replaces (never appends) a window's terminals.
  private readonly slices = new Map<string, TerminalTuple[]>();
  private running = false;

  private readonly detectorOpts?: MonitorDetectorOptions;
  private readinessDetector?: ReadinessDetector;
  private sessionWatcher?: SessionWatcher;
  private watchdogDetector?: WatchdogDetector;
  private snapshotDetector?: SnapshotDetector;

  constructor(options: MonitorHostOptions = {}) {
    this.detectorOpts = options.detectors;
    this.server = new MonitorBroadcastServer({
      socketPath: options.socketPath,
      onRequest: (payload) => this.handleRequest(payload),
    });
  }

  /** Number of currently-connected follower sockets. */
  get clientCount(): number {
    return this.server.clientCount;
  }

  /** Live session roots being watched (verification/tests). */
  get watchedRootCount(): number {
    return this.sessionWatcher?.watchedRootCount ?? 0;
  }

  /** Distinct sessions the watchdog detector is watching (verification/tests). */
  get watchedSessionCount(): number {
    return this.watchdogDetector?.watchedSessionCount ?? 0;
  }

  /** Distinct snapshot tuples the detector is computing (verification/tests). */
  get watchedSnapshotKeyCount(): number {
    return this.snapshotDetector?.watchedKeyCount ?? 0;
  }

  /** Bind the broadcast socket, start detectors, and begin serving followers. */
  async start(): Promise<void> {
    if (this.running) return;
    await this.server.start();
    this.running = true;
    this.startDetectors();
  }

  /** Stop serving, stop detectors, drop all tuple slices, and unlink the socket. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.readinessDetector?.stop();
    this.readinessDetector = undefined;
    this.sessionWatcher?.stop();
    this.sessionWatcher = undefined;
    this.watchdogDetector?.stop();
    this.watchdogDetector = undefined;
    this.snapshotDetector?.stop();
    this.snapshotDetector = undefined;
    this.slices.clear();
    await this.server.close();
  }

  /** The union of every window's reported tuples. */
  snapshot(): TerminalTuple[] {
    const out: TerminalTuple[] = [];
    for (const slice of this.slices.values()) out.push(...slice);
    return out;
  }

  private startDetectors(): void {
    const opts = this.detectorOpts;
    if (!opts) return;
    if (opts.readiness !== false) {
      this.readinessDetector = new ReadinessDetector({
        emit: (fact) => this.broadcastReadiness(fact),
        emitAdoption: (fact) => this.broadcastShellAdoption(fact),
      });
      this.syncDetectorPids();
    }
    if (opts.session !== false) {
      this.sessionWatcher = new SessionWatcher({
        emit: (fact) => this.broadcastSession(fact),
        emitWarmth: (fact) => this.broadcastSessionWarmth(fact),
        roots: opts.sessionRoots,
        debounceMs: opts.sessionDebounceMs,
      });
      this.sessionWatcher.start();
    }
    if (opts.watchdog !== false) {
      this.watchdogDetector = new WatchdogDetector({
        emitStall: (fact) => this.broadcastWatchdogStall(fact),
        emitVersions: (fact) => this.broadcastWatchdogVersions(fact),
        tickMs: opts.watchdogTickMs,
        viewPollMs: opts.watchdogViewPollMs,
        fetchView: opts.watchdogFetchView,
      });
      this.watchdogDetector.start();
    }
    if (opts.snapshot !== false) {
      this.snapshotDetector = new SnapshotDetector({
        emit: (fact) => this.broadcastPanelSnapshot(fact),
        tickMs: opts.snapshotTickMs,
        fetchTeams: opts.snapshotFetchTeams,
      });
      this.snapshotDetector.start();
    }
  }

  private handleRequest(
    payload: unknown,
  ): ReportTuplesAck | SnapshotReply | ArmAck {
    const req = payload as MonitorRequest | undefined;
    const op = req?.op;
    if (req && op === MONITOR_OP.reportTuples) {
      this.slices.set(req.windowId, req.tuples ?? []);
      this.syncDetectorPids();
      this.broadcastSnapshot();
      return { ok: true, windowId: req.windowId, count: req.tuples?.length ?? 0 };
    }
    if (req && op === MONITOR_OP.snapshot) {
      return { tuples: this.snapshot() };
    }
    if (req && op === MONITOR_OP.armAgent) {
      const r = req as ArmAgentRequest;
      this.readinessDetector?.armAgent(r.pid, r.agentKey, r.sessionId);
      return { ok: true };
    }
    if (req && op === MONITOR_OP.armShellAdoption) {
      const r = req as ArmShellAdoptionRequest;
      this.readinessDetector?.armShellAdoption(r.pid);
      return { ok: true };
    }
    if (req && op === MONITOR_OP.watchdogWatch) {
      const r = req as WatchdogWatchRequest;
      this.watchdogDetector?.setWatches(r.windowId, r.watches ?? []);
      return { ok: true };
    }
    if (req && op === MONITOR_OP.snapshotWatch) {
      const r = req as SnapshotWatchRequest;
      this.snapshotDetector?.setWatches(r.windowId, r.watches ?? []);
      return { ok: true };
    }
    throw new Error(`Unknown monitor request op: ${JSON.stringify(op)}`);
  }

  private syncDetectorPids(): void {
    if (!this.readinessDetector) return;
    const pids = new Set<number>();
    for (const slice of this.slices.values()) {
      for (const t of slice) {
        if (typeof t.pid === 'number') pids.add(t.pid);
      }
    }
    this.readinessDetector.setPids(pids);
  }

  private broadcast(type: string, payload: unknown): void {
    const event: MonitorEvent = { type, payload, ts: Date.now() };
    this.server.broadcast(event);
  }

  private broadcastSnapshot(): void {
    const payload: TuplesSnapshotPayload = { tuples: this.snapshot() };
    this.broadcast(MONITOR_FACT.tuplesSnapshot, payload);
  }

  private broadcastReadiness(payload: ReadinessFactPayload): void {
    this.broadcast(MONITOR_FACT.readiness, payload);
  }

  private broadcastShellAdoption(payload: ShellAdoptionFactPayload): void {
    this.broadcast(MONITOR_FACT.shellAdoption, payload);
  }

  private broadcastSession(payload: SessionFactPayload): void {
    // Feed the session-file fast path so an armed agentReady can resolve from
    // the file appearing (mirrors armSessionFileFastPath).
    this.readinessDetector?.noteSessionFile(path.basename(payload.filePath));
    this.broadcast(MONITOR_FACT.session, payload);
  }

  private broadcastSessionWarmth(payload: SessionWarmthPayload): void {
    this.broadcast(MONITOR_FACT.sessionWarmth, payload);
  }

  private broadcastWatchdogStall(payload: WatchdogStallPayload): void {
    this.broadcast(MONITOR_FACT.watchdogStall, payload);
  }

  private broadcastWatchdogVersions(payload: WatchdogVersionsPayload): void {
    this.broadcast(MONITOR_FACT.watchdogVersions, payload);
  }

  private broadcastPanelSnapshot(payload: PanelSnapshotPayload): void {
    this.broadcast(MONITOR_FACT.panelSnapshot, payload);
  }
}
