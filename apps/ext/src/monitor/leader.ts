// Monitor leader election — foundation 1/3 of the centralized-monitor epic (#64).
//
// Elects exactly ONE "monitor" owner across all open IDE windows using the
// lease file in `./lease.ts`. The winner runs the heavy global probes/watches
// (later migration issues); every other window is a thin follower. When the
// leader window dies, another claims within one heartbeat.
//
// Identity is `computeWindowId(sessionId, pid)`: a window RELOAD changes
// process.pid, so the windowId changes too — leadership is therefore LOST and
// must be re-elected, never silently continued (see foreman.registry.ts:49).
//
// Kept vscode-free: the wiring layer (extension.ts) supplies selfId/pid, so
// this module — and the lease logic it drives — runs and tests in plain
// subprocesses (see leader.test.ts).

import {
  MonitorLease,
  canClaim,
  readLease,
  writeLease,
  releaseLease,
  LEASE_FILE,
} from './lease';

export interface Disposable {
  dispose(): void;
}

export interface LeaderOptions {
  /** Stable per-window identity, e.g. computeWindowId(sessionId, pid). */
  selfId: string;
  /** OS pid recorded in the lease for liveness checks on takeover. */
  pid: number;
  /** How often we renew (as leader) or re-attempt a claim (as follower). */
  heartbeatMs?: number;
  /**
   * Lease lifetime. Must exceed heartbeatMs so a healthy leader always renews
   * before its own lease expires; defaults to 3x heartbeat.
   */
  ttlMs?: number;
  /** Override the lease file path (tests). */
  leaseFile?: string;
  /** Fired synchronously whenever isLeader() flips. */
  onChange?: (isLeader: boolean) => void;
}

const DEFAULT_HEARTBEAT_MS = 2_000;

export class MonitorLeader {
  private readonly selfId: string;
  private readonly pid: number;
  private readonly heartbeatMs: number;
  private readonly ttlMs: number;
  private readonly leaseFile: string;
  private readonly listeners = new Set<(isLeader: boolean) => void>();

  private leader = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: LeaderOptions) {
    this.selfId = opts.selfId;
    this.pid = opts.pid;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.ttlMs = opts.ttlMs ?? this.heartbeatMs * 3;
    this.leaseFile = opts.leaseFile ?? LEASE_FILE;
    if (opts.onChange) this.listeners.add(opts.onChange);
  }

  /** Begin the heartbeat loop. Runs one tick immediately. */
  start(): this {
    if (this.timer) return this;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.heartbeatMs);
    // Don't keep the process alive solely for the lease loop.
    (this.timer as any)?.unref?.();
    return this;
  }

  isLeader(): boolean {
    return this.leader;
  }

  onLeadershipChange(cb: (isLeader: boolean) => void): Disposable {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }

  /** Stop heartbeating and, if we hold the lease, release it for fast handoff. */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.leader) {
      try {
        releaseLease(this.selfId, this.leaseFile);
      } catch {
        /* best effort — TTL expiry is the backstop */
      }
    }
    this.setLeader(false);
  }

  private tick(): void {
    const now = Date.now();
    let lease: MonitorLease | undefined;
    try {
      lease = readLease(this.leaseFile);
    } catch {
      lease = undefined;
    }

    if (!canClaim(lease, this.selfId, now)) {
      this.setLeader(false);
      return;
    }

    try {
      writeLease(
        { leaderId: this.selfId, pid: this.pid, expiresAt: now + this.ttlMs },
        this.leaseFile,
      );
    } catch {
      this.setLeader(false);
      return;
    }

    // Read back: under concurrent claims the last rename wins. Whoever does not
    // see their own id steps down, so the cluster converges to a single leader.
    const after = readLease(this.leaseFile);
    this.setLeader(after?.leaderId === this.selfId);
  }

  private setLeader(next: boolean): void {
    if (next === this.leader) return;
    this.leader = next;
    for (const cb of this.listeners) {
      try {
        cb(next);
      } catch {
        /* a listener must not break the loop */
      }
    }
  }
}

// ---- Module singleton: one elector per extension host -----------------------

let active: MonitorLeader | undefined;

/** Construct, start, and register the process-wide monitor elector. */
export function electLeader(opts: LeaderOptions): MonitorLeader {
  active?.dispose();
  active = new MonitorLeader(opts).start();
  return active;
}

/** Synchronous read of whether THIS window currently owns the monitor. */
export function isLeader(): boolean {
  return active?.isLeader() ?? false;
}

/** Subscribe to leadership changes on the active elector. */
export function onLeadershipChange(
  cb: (isLeader: boolean) => void,
): Disposable {
  if (!active) return { dispose: () => {} };
  return active.onLeadershipChange(cb);
}

/** Tear down the active elector (graceful handoff). */
export function disposeLeader(): void {
  active?.dispose();
  active = undefined;
}
