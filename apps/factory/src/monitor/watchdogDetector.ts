// Leader-side, sessionId-keyed watchdog detector (#70).
//
// The elected monitor runs ONE of these. Each window ARMS it with the set of
// agent sessions it owns (resolved session-file path + stall/dormant
// thresholds); the detector runs the SAME staleness check the per-window
// watchdog tick ran today — `fs.stat` the session file, compare its mtime to
// the stall threshold — but once per session instead of once per (window,
// terminal). When a session crosses its stall threshold it emits a stall fact
// the host broadcasts; the window that owns that session resolves it back to
// its own terminal and delivers the nudge/rotate (delivery stays per-window).
//
// It also polls `agents view <agentKey> --json` once machine-wide for the
// auto-rotate exhaustion check and broadcasts the parsed result, so windows
// stop each spawning that CLI on their own tick.
//
// vscode-free: it operates purely on session paths + agent keys, reuses the
// shared `agents` runner (core/agentsBin), and is driven by the host — so it
// runs and tests in a plain process against real files and subprocesses.

import * as fs from 'fs/promises';
import { AgentsViewJsonAgent } from '../core/resumeInBest';
import {
  WatchdogStallPayload,
  WatchdogVersionsPayload,
  WatchdogWatch,
} from './protocol';

/** How often the detector stats every watched session. */
export const WATCHDOG_DETECT_TICK_MS = 30_000;
/** How often `agents view --json` is polled per agent key. */
export const WATCHDOG_VIEW_POLL_MS = 60_000;

async function defaultFetchView(agentKey: string): Promise<AgentsViewJsonAgent | null> {
  try {
    const { runAgents } = await import('../core/agentsBin');
    const { stdout } = await runAgents(`view ${agentKey} --json`, {
      maxBuffer: 5 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as AgentsViewJsonAgent;
    if (!parsed || !Array.isArray(parsed.versions)) return null;
    return parsed;
  } catch (err) {
    console.warn(`[WATCHDOG] agents view ${agentKey} --json failed:`, err);
    return null;
  }
}

export interface WatchdogDetectorOptions {
  emitStall: (fact: WatchdogStallPayload) => void;
  emitVersions: (fact: WatchdogVersionsPayload) => void;
  /** Stat cadence (tests). */
  tickMs?: number;
  /** `agents view` cadence (tests). */
  viewPollMs?: number;
  /** Inject the view fetcher (tests); defaults to the real `agents view` CLI. */
  fetchView?: (agentKey: string) => Promise<AgentsViewJsonAgent | null>;
}

export class WatchdogDetector {
  private readonly emitStall: (fact: WatchdogStallPayload) => void;
  private readonly emitVersions: (fact: WatchdogVersionsPayload) => void;
  private readonly tickMs: number;
  private readonly viewPollMs: number;
  private readonly fetchView: (agentKey: string) => Promise<AgentsViewJsonAgent | null>;

  // windowId -> that window's last-reported watch slice. Merged by sessionId so
  // a session owned by two windows is still stat'd only once per tick.
  private readonly slices = new Map<string, WatchdogWatch[]>();
  private readonly lastViewPollAt = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private viewInFlight = false;
  private stopped = false;

  constructor(options: WatchdogDetectorOptions) {
    this.emitStall = options.emitStall;
    this.emitVersions = options.emitVersions;
    this.tickMs = options.tickMs ?? WATCHDOG_DETECT_TICK_MS;
    this.viewPollMs = options.viewPollMs ?? WATCHDOG_VIEW_POLL_MS;
    this.fetchView = options.fetchView ?? defaultFetchView;
  }

  /** Number of distinct sessions currently watched (test introspection). */
  get watchedSessionCount(): number {
    return this.mergeBySession().size;
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Replace one window's watch slice; the union drives the central tick. */
  setWatches(windowId: string, watches: WatchdogWatch[]): void {
    if (this.stopped) return;
    if (watches.length === 0) this.slices.delete(windowId);
    else this.slices.set(windowId, watches);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.slices.clear();
    this.lastViewPollAt.clear();
  }

  /** Run one detection pass immediately (tests); normally the timer drives it. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const merged = this.mergeBySession();

    for (const watch of merged.values()) {
      let mtimeMs: number;
      try {
        mtimeMs = (await fs.stat(watch.sessionFilePath)).mtimeMs;
      } catch {
        continue; // file missing/unreadable — nothing to report
      }
      const idleMs = now - mtimeMs;
      // Mirror classifyTerminal's `stalled` window: idle past the stall
      // threshold but not yet dormant. Cooldown/opt-out stay window-local.
      if (idleMs >= watch.stallMs && idleMs <= watch.dormantMs) {
        this.emitStall({
          sessionId: watch.sessionId,
          agentType: watch.agentType,
          idleMs,
          mtimeMs,
        });
      }
    }

    await this.pollViews(now, merged);
  }

  // Collapse every window's slice to one watch per sessionId. When two windows
  // register the same session, keep the tightest stall threshold so the session
  // is flagged as soon as ANY owner would have flagged it.
  private mergeBySession(): Map<string, WatchdogWatch> {
    const merged = new Map<string, WatchdogWatch>();
    for (const slice of this.slices.values()) {
      for (const w of slice) {
        const existing = merged.get(w.sessionId);
        if (!existing || w.stallMs < existing.stallMs) merged.set(w.sessionId, w);
      }
    }
    return merged;
  }

  private async pollViews(now: number, merged: Map<string, WatchdogWatch>): Promise<void> {
    if (this.viewInFlight) return;
    const keys = new Set<string>();
    for (const w of merged.values()) {
      if (w.rotateAgentKey) keys.add(w.rotateAgentKey);
    }
    const due = [...keys].filter(
      (k) => now - (this.lastViewPollAt.get(k) ?? 0) >= this.viewPollMs,
    );
    if (due.length === 0) return;

    this.viewInFlight = true;
    try {
      for (const agentKey of due) {
        this.lastViewPollAt.set(agentKey, now);
        const view = await this.fetchView(agentKey);
        if (this.stopped) return;
        if (view) this.emitVersions({ agentKey, view });
      }
    } finally {
      this.viewInFlight = false;
    }
  }
}
