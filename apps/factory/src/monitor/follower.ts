// Monitor follower runtime — foundation 3/3 of the centralized-monitor epic (#64).
//
// EVERY window (leader and non-leader alike) runs one follower. It:
//   1. holds a persistent, auto-reconnecting connection to the monitor (#66);
//   2. REPORTS this window's terminal tuples over the request channel — the
//      cross-window successor to today's `publishLiveTerminals` registry write
//      (extension.ts), which stays as the disconnected-case fallback;
//   3. SUBSCRIBES to the monitor's merged snapshot facts and resolves each
//      pid/sessionId back to THIS window's own `vscode.Terminal`.
//
// The Terminal resolution stays window-local by design (epic #64): the follower
// never imports the `tracked`/`editorTerminals` maps — the wiring layer injects
// a `resolver` closure over them. That also keeps this module vscode-free and
// testable against a real socket with a plain Map resolver (see follower.test.ts).

import {
  MonitorBroadcastClient,
  MonitorBroadcastClientOptions,
} from './broadcast';
import { MonitorEvent } from './broadcastTypes';
import {
  ArmAgentRequest,
  ArmShellAdoptionRequest,
  isTuplesSnapshot,
  MONITOR_OP,
  ReportTuplesAck,
  ReportTuplesRequest,
  SnapshotWatch,
  SnapshotWatchRequest,
  TerminalTuple,
  WatchdogWatch,
  WatchdogWatchRequest,
} from './protocol';

/** Lookup key for resolving a broadcast tuple back to a local terminal. */
export interface TerminalKey {
  pid?: number | null;
  sessionId?: string | null;
}

/** Maps a pid/sessionId to this window's terminal handle, or undefined. */
export type TerminalResolver<T> = (key: TerminalKey) => T | undefined;

/** A monitor tuple paired with the local terminal it resolved to. */
export interface ResolvedFact<T> {
  tuple: TerminalTuple;
  terminal: T;
}

export type FactListener<T> = (
  resolved: ResolvedFact<T>[],
  event: MonitorEvent,
) => void;

export interface MonitorFollowerOptions<T> {
  /** computeWindowId(sessionId, pid) of this window. */
  windowId: string;
  /** Resolves a broadcast tuple back to this window's terminal handle. */
  resolver: TerminalResolver<T>;
  /** Inject a pre-built client (tests); otherwise one is created. */
  client?: MonitorBroadcastClient;
  /** Socket path for the auto-created client. */
  socketPath?: string;
  /** Extra options for the auto-created client (backoff, onStateChange). */
  clientOptions?: MonitorBroadcastClientOptions;
  /** Fired for every snapshot fact, with the locally-resolved subset. */
  onFacts?: FactListener<T>;
}

export class MonitorFollower<T> {
  private readonly windowId: string;
  private readonly resolver: TerminalResolver<T>;
  private readonly client: MonitorBroadcastClient;
  private readonly ownsClient: boolean;
  private readonly listeners = new Set<FactListener<T>>();
  private unsubscribe?: () => void;

  constructor(options: MonitorFollowerOptions<T>) {
    this.windowId = options.windowId;
    this.resolver = options.resolver;
    this.ownsClient = !options.client;
    this.client =
      options.client ??
      new MonitorBroadcastClient({
        socketPath: options.socketPath,
        ...options.clientOptions,
      });
    if (options.onFacts) this.listeners.add(options.onFacts);
  }

  /** True once the persistent connection to the monitor is established. */
  get connected(): boolean {
    return this.client.connected;
  }

  /** Connect (and stay connected) and begin dispatching resolved facts. */
  start(): void {
    this.unsubscribe = this.client.subscribe((event) =>
      this.handleEvent(event),
    );
    this.client.connect();
  }

  /** Subscribe to resolved snapshot facts. Returns an unsubscribe function. */
  onFacts(listener: FactListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribe to EVERY raw broadcast event (readiness/session/etc.), not just
   * resolved tuple snapshots. The wiring layer uses this to route the migrated
   * facts (#68, #69) into terminalReadiness / sessionTracker. Returns an
   * unsubscribe function.
   */
  onMonitorEvent(listener: (event: MonitorEvent) => void): () => void {
    return this.client.subscribe(listener);
  }

  /**
   * Ask the monitor to arm agentReady detection for a shell pid (#68). No-op
   * (returns false) while disconnected so the caller keeps the local fallback.
   */
  async armAgent(pid: number, agentKey?: string, sessionId?: string): Promise<boolean> {
    if (!this.client.connected) return false;
    const request: ArmAgentRequest = { op: MONITOR_OP.armAgent, pid, agentKey, sessionId };
    try {
      await this.client.request(request);
      return true;
    } catch (err) {
      console.error('[MONITOR] armAgent failed:', err);
      return false;
    }
  }

  /**
   * Replace this window's watchdog watch slice on the monitor (#70). The leader
   * stats each registered session once and broadcasts a stall fact this window
   * resolves back to its own terminal. Returns false (rather than throwing)
   * while disconnected so the caller keeps running the local watchdog tick.
   */
  async setWatchdogWatches(watches: WatchdogWatch[]): Promise<boolean> {
    if (!this.client.connected) return false;
    const request: WatchdogWatchRequest = {
      op: MONITOR_OP.watchdogWatch,
      windowId: this.windowId,
      watches,
    };
    try {
      await this.client.request(request);
      return true;
    } catch (err) {
      console.error('[MONITOR] setWatchdogWatches failed:', err);
      return false;
    }
  }

  /**
   * Replace this window's panel-snapshot watch slice on the monitor (#71). The
   * leader computes git/worktree/usage/teams once and broadcasts a `panel-snapshot`
   * fact this window renders from. Returns false (rather than throwing) while
   * disconnected so the caller keeps computing the snapshot locally.
   */
  async setSnapshotWatches(watches: SnapshotWatch[]): Promise<boolean> {
    if (!this.client.connected) return false;
    const request: SnapshotWatchRequest = {
      op: MONITOR_OP.snapshotWatch,
      windowId: this.windowId,
      watches,
    };
    try {
      await this.client.request(request);
      return true;
    } catch (err) {
      console.error('[MONITOR] setSnapshotWatches failed:', err);
      return false;
    }
  }

  /** Ask the monitor to arm shell-adoption detection for a shell pid (#68). */
  async armShellAdoption(pid: number): Promise<boolean> {
    if (!this.client.connected) return false;
    const request: ArmShellAdoptionRequest = { op: MONITOR_OP.armShellAdoption, pid };
    try {
      await this.client.request(request);
      return true;
    } catch (err) {
      console.error('[MONITOR] armShellAdoption failed:', err);
      return false;
    }
  }

  /**
   * Report this window's terminal slice to the monitor. Returns false (rather
   * than throwing) when disconnected so the caller keeps the registry-file
   * fallback intact for the disconnected case.
   */
  async reportTuples(tuples: TerminalTuple[]): Promise<boolean> {
    if (!this.client.connected) return false;
    const request: ReportTuplesRequest = {
      op: MONITOR_OP.reportTuples,
      windowId: this.windowId,
      tuples,
    };
    try {
      const ack = (await this.client.request(request)) as ReportTuplesAck;
      return ack?.ok === true;
    } catch (err) {
      console.error('[MONITOR] reportTuples failed:', err);
      return false;
    }
  }

  /** Resolve a snapshot fact's tuples to this window's local terminals. */
  resolveFact(event: MonitorEvent): ResolvedFact<T>[] {
    if (!isTuplesSnapshot(event)) return [];
    const resolved: ResolvedFact<T>[] = [];
    for (const tuple of event.payload.tuples) {
      const terminal = this.resolver({
        pid: tuple.pid,
        sessionId: tuple.sessionId,
      });
      if (terminal !== undefined) resolved.push({ tuple, terminal });
    }
    return resolved;
  }

  /** Permanently stop: detach and (if we own it) close the client. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.listeners.clear();
    if (this.ownsClient) this.client.close();
  }

  private handleEvent(event: MonitorEvent): void {
    if (!isTuplesSnapshot(event)) return;
    const resolved = this.resolveFact(event);
    for (const listener of this.listeners) {
      try {
        listener(resolved, event);
      } catch (err) {
        console.error('[MONITOR] fact listener threw:', err);
      }
    }
  }
}
