// Monitor host runtime — foundation 3/3 of the centralized-monitor epic (#64),
// extended by the readiness and canonical CLI session-stream migrations.
//
// The elected leader (#65) == the monitor. While this window holds the lease it
// runs ONE `MonitorBroadcastServer` (#66); followers connect to it, report their
// terminal tuples, and receive the merged snapshot back as a broadcast fact.
// When `detectors` is enabled the host ALSO runs the centralized work:
//   - a ReadinessDetector (#68) fed the union of all windows' shell pids, which
//     broadcasts tabReady/shellReady/promptReady/agentReady + ShellAdoptionInfo
//     facts keyed by pid;
// Followers map every fact back to their own terminals window-locally.
//
// Kept vscode-free so it runs and tests in a plain process against real Unix
// sockets and real subprocesses/files (see *.test.ts).

import { MonitorBroadcastServer } from './broadcast';
import { MonitorEvent } from './broadcastTypes';
import {
  ArmAck,
  ArmAgentRequest,
  ArmShellAdoptionRequest,
  MONITOR_FACT,
  MONITOR_OP,
  MonitorRequest,
  ReadinessFactPayload,
  ReportTuplesAck,
  ShellAdoptionFactPayload,
  SnapshotReply,
  TerminalTuple,
  TuplesSnapshotPayload,
} from './protocol';
import { ReadinessDetector } from './readinessDetector';
import { SessionCliStream } from './sessionCliStream';
import { SessionCliReplay } from './sessionCliStream';
import type { SessionCliStreamOptions } from './sessionCliStream';
import type { Socket } from 'net';

/** Enable + configure the centralized presentation detectors. */
export interface MonitorDetectorOptions {
  /** Run the pid-keyed readiness detector. Default true. */
  readiness?: boolean;
  /** Consume the canonical agents-cli session stream. Default true. */
  sessionCli?: boolean;
  /**
   * Supply the watch child instead of spawning `agents sessions watch --json`.
   * `SessionCliStream` already accepts this; the host forwards it so a test can
   * drive the real stream/replay path from a real child process without
   * depending on an installed CLI.
   */
  spawnSessionWatch?: SessionCliStreamOptions['spawnWatch'];
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
  private sessionCliStream?: SessionCliStream;
  private readonly sessionCliReplay = new SessionCliReplay();

  constructor(options: MonitorHostOptions = {}) {
    this.detectorOpts = options.detectors;
    this.server = new MonitorBroadcastServer({
      socketPath: options.socketPath,
      // Forward the socket: handleRequest replays the retained session-cli reset
      // to THIS follower's socket, and without it that replay silently no-ops
      // (`if (socket)` below), leaving every follower window at zero sessions.
      onRequest: (payload, socket) => this.handleRequest(payload, socket),
    });
  }

  /** Number of currently-connected follower sockets. */
  get clientCount(): number {
    return this.server.clientCount;
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
    this.sessionCliStream?.stop();
    this.sessionCliStream = undefined;
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
    if (opts.sessionCli !== false) {
      this.sessionCliStream = new SessionCliStream({
        emit: (event) => {
          this.sessionCliReplay.ingest(event);
          this.broadcast(MONITOR_FACT.sessionCli, event);
        },
        onError: (message) => console.error(`[MONITOR] ${message}`),
        ...(opts.spawnSessionWatch ? { spawnWatch: opts.spawnSessionWatch } : {}),
      });
      this.sessionCliStream.start();
    }
    if (opts.readiness !== false) {
      this.readinessDetector = new ReadinessDetector({
        emit: (fact) => this.broadcastReadiness(fact),
        emitAdoption: (fact) => this.broadcastShellAdoption(fact),
      });
      this.syncDetectorPids();
    }
  }

  private handleRequest(
    payload: unknown,
    socket?: Socket,
  ): ReportTuplesAck | SnapshotReply | ArmAck {
    const req = payload as MonitorRequest | undefined;
    const op = req?.op;
    if (req && op === MONITOR_OP.reportTuples) {
      this.slices.set(req.windowId, req.tuples ?? []);
      this.syncDetectorPids();
      this.broadcastSnapshot();
      if (socket) {
        for (const event of this.sessionCliReplay.envelopes(req.windowId)) {
          this.server.sendTo(socket, { type: MONITOR_FACT.sessionCli, payload: event, ts: Date.now() });
        }
      }
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

}
