// Leader-side, sessionId-keyed watchdog version poller (#70).
//
// The elected monitor runs ONE of these. Each window ARMS it with the agent
// keys it needs `agents view --json` polled for; the detector polls each key
// once machine-wide for the auto-rotate exhaustion check and broadcasts the
// parsed result, so windows stop each spawning that CLI on their own tick.
//
// (Autonomous stall detection + nudge injection were retired — the CLI daemon
// watchdog is the sole injector now — so this detector no longer stats session
// files for staleness; it carries only the rotate version poll.)
//
// vscode-free: it operates purely on agent keys, reuses the shared `agents`
// runner (core/agentsBin), and is driven by the host — so it runs and tests in
// a plain process against real subprocesses.

import { AgentsViewJsonAgent } from '../core/resumeInBest';
import {
  WatchdogVersionsPayload,
  WatchdogWatch,
} from './protocol';

/** How often the detector runs its version-poll pass. */
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
  emitVersions: (fact: WatchdogVersionsPayload) => void;
  /** Poll-pass cadence (tests). */
  tickMs?: number;
  /** `agents view` cadence (tests). */
  viewPollMs?: number;
  /** Inject the view fetcher (tests); defaults to the real `agents view` CLI. */
  fetchView?: (agentKey: string) => Promise<AgentsViewJsonAgent | null>;
}

export class WatchdogDetector {
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

  /** Run one poll pass immediately (tests); normally the timer drives it. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const merged = this.mergeBySession();
    await this.pollViews(now, merged);
  }

  // Collapse every window's slice to one watch per sessionId, so a session
  // owned by two windows contributes its rotate agent key only once.
  private mergeBySession(): Map<string, WatchdogWatch> {
    const merged = new Map<string, WatchdogWatch>();
    for (const slice of this.slices.values()) {
      for (const w of slice) {
        if (!merged.has(w.sessionId)) merged.set(w.sessionId, w);
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
