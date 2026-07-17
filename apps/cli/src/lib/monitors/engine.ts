/**
 * Monitor evaluate/fire loop.
 *
 * Modeled on the routines daemon: a single MonitorEngine lives inside runDaemon()
 * beside the cron JobScheduler. On each tick it evaluates every enabled monitor
 * that is DUE and owned by this device, applies the condition through the native
 * state-diff store, and on a fire dispatches the action, writes a fire record, and
 * updates state. A per-monitor rate limit auto-pauses a firehose.
 *
 * v1 covers the poll model (command, poll, poll-http, file, device). Push sources
 * (ws, webhook) return null from `evaluate` — they deliver through `subscribe` /
 * the webhook receiver, wired in a follow-up; the engine treats them as inert.
 */

import {
  listMonitors,
  monitorRunsOnThisDevice,
  parseInterval,
  setMonitorEnabled,
  type MonitorConfig,
  type MonitorEvent,
} from './config.js';
import { evaluateSource, type Observation } from './sources/index.js';
import {
  hasChanged,
  readState,
  writeState,
  recordFireTime,
  writeFireRecord,
} from './state.js';
import { dispatchAction, type DispatchResult } from './dispatch.js';

/** How often the engine wakes to check which monitors are due. */
const TICK_MS = 5_000;
/** Default evaluation cadence for sources that carry no explicit interval. */
const DEFAULT_INTERVAL_MS = 60_000;

/** The fire/no-fire decision for one observation, plus what to persist. */
export interface FireDecision {
  fire: boolean;
  /** The value whose de-dupe signature is stored on persist. */
  value: string;
  /** The de-dupe key (regex) applied to the value, if any. */
  dedupeKey?: string;
  /** Persist `value` as the new baseline even when not firing (on-change baseline). */
  persist: boolean;
  /** The event to dispatch, present iff `fire`. */
  event: MonitorEvent | null;
}

function truncateSummary(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 240 ? oneLine.slice(0, 240) + '…' : oneLine;
}

function buildEvent(monitor: MonitorConfig, summary: string, payload: Record<string, unknown>): MonitorEvent {
  return { monitorName: monitor.name, firedAt: new Date().toISOString(), summary, payload };
}

/**
 * Apply a monitor's condition to an observation. Pure (reads state, never
 * writes), so both the tick loop and the `test` dry-run share it.
 */
export function decideFire(monitor: MonitorConfig, observation: Observation): FireDecision {
  const cond = monitor.condition;
  const raw = observation.raw;
  const payload = observation.meta ?? {};
  const dedupeKey = cond.dedupeKey;

  if (cond.mode === 'every') {
    return {
      fire: true,
      value: raw,
      dedupeKey,
      persist: false,
      event: buildEvent(monitor, truncateSummary(raw), payload),
    };
  }

  if (cond.mode === 'match') {
    let matched: RegExpExecArray | null = null;
    try {
      matched = new RegExp(cond.match ?? '').exec(raw);
    } catch {
      matched = null;
    }
    if (!matched) {
      return { fire: false, value: raw, dedupeKey, persist: false, event: null };
    }
    const matchedValue = matched[0];
    const changed = hasChanged(monitor.name, matchedValue, dedupeKey);
    return {
      fire: changed,
      value: matchedValue,
      dedupeKey,
      persist: changed,
      event: changed ? buildEvent(monitor, truncateSummary(matchedValue), payload) : null,
    };
  }

  // on-change (default): the first observation establishes a silent baseline;
  // thereafter fire when the de-dupe signature differs from last-seen.
  const prior = readState(monitor.name);
  if (!prior) {
    return { fire: false, value: raw, dedupeKey, persist: true, event: null };
  }
  const changed = hasChanged(monitor.name, raw, dedupeKey);
  return {
    fire: changed,
    value: raw,
    dedupeKey,
    persist: changed,
    event: changed ? buildEvent(monitor, truncateSummary(raw), payload) : null,
  };
}

/** One evaluation of a monitor's source + condition, without side effects. Used by `test`. */
export async function evaluateMonitorOnce(
  monitor: MonitorConfig,
): Promise<{ observation: Observation | null; decision: FireDecision | null }> {
  const observation = await evaluateSource(monitor.source);
  if (!observation) return { observation: null, decision: null };
  return { observation, decision: decideFire(monitor, observation) };
}

type LogFn = (level: string, message: string) => void;

/** The durable monitor engine. One instance per daemon. */
export class MonitorEngine {
  private timer: NodeJS.Timeout | null = null;
  private monitors: MonitorConfig[] = [];
  private lastEval = new Map<string, number>();
  private ticking = false;

  constructor(private logFn: LogFn = () => {}) {}

  /** Load owned+enabled monitors and start the tick loop. */
  start(): void {
    this.loadAll();
    this.logFn('INFO', `Monitor engine started (${this.monitors.length} monitor(s) on this device)`);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  /** Reload monitor configs (SIGHUP). */
  reload(): void {
    this.loadAll();
    this.logFn('INFO', `Monitor engine reloaded (${this.monitors.length} monitor(s) on this device)`);
  }

  /** Stop the tick loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private loadAll(): void {
    this.monitors = listMonitors().filter((m) => m.enabled && monitorRunsOnThisDevice(m));
  }

  private intervalMs(monitor: MonitorConfig): number {
    if (monitor.source.interval) return parseInterval(monitor.source.interval) ?? DEFAULT_INTERVAL_MS;
    return DEFAULT_INTERVAL_MS;
  }

  private isDue(monitor: MonitorConfig, now: number): boolean {
    const last = this.lastEval.get(monitor.name) ?? 0;
    return now - last >= this.intervalMs(monitor);
  }

  /** Evaluate every due monitor once. Overlap-guarded so a slow cycle never stacks. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const monitor of this.monitors) {
        if (!this.isDue(monitor, now)) continue;
        this.lastEval.set(monitor.name, now);
        await this.runMonitor(monitor);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runMonitor(monitor: MonitorConfig): Promise<void> {
    try {
      const { observation, decision } = await evaluateMonitorOnce(monitor);
      if (!observation || !decision) return;
      if (decision.fire && decision.event) {
        await this.fire(monitor, decision, decision.event);
      } else if (decision.persist) {
        // Silent baseline / no-change: record the value so we don't re-fire.
        writeState(monitor.name, decision.value, decision.dedupeKey);
      }
    } catch (err) {
      this.logFn('ERROR', `monitor '${monitor.name}' evaluation failed: ${(err as Error).message}`);
    }
  }

  private async fire(monitor: MonitorConfig, decision: FireDecision, event: MonitorEvent): Promise<void> {
    const now = Date.now();
    let fireTimes: number[] | undefined;

    // Firehose guard: auto-pause a monitor that exceeds its rate limit.
    if (monitor.rateLimit) {
      const windowMs = parseInterval(monitor.rateLimit.per) ?? 60_000;
      fireTimes = recordFireTime(monitor.name, now, windowMs);
      if (fireTimes.length > monitor.rateLimit.max) {
        // Record the tripped event in fire history too, so `agents monitors runs`
        // reflects what `view`'s `lastFiredAt` shows — the firehose event the guard
        // exists to surface must not be invisible in the fire log.
        writeFireRecord(event, { action: monitor.action.type, ok: false, error: 'rate limited — auto-paused' });
        writeState(monitor.name, decision.value, decision.dedupeKey, { lastFiredAt: event.firedAt, fireTimes });
        try {
          setMonitorEnabled(monitor.name, false);
        } catch { /* best-effort pause */ }
        this.logFn(
          'WARN',
          `monitor '${monitor.name}' exceeded rate limit (${monitor.rateLimit.max}/${monitor.rateLimit.per}) — auto-paused`,
        );
        this.loadAll();
        return;
      }
    }

    let result: DispatchResult;
    try {
      result = await dispatchAction(monitor, event);
    } catch (err) {
      result = { kind: monitor.action.type, ok: false, error: (err as Error).message };
    }

    writeFireRecord(event, {
      ...(result.runId ? { runId: result.runId } : {}),
      action: result.kind,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
    });
    writeState(monitor.name, decision.value, decision.dedupeKey, { lastFiredAt: event.firedAt, fireTimes });

    this.logFn(
      result.ok ? 'INFO' : 'ERROR',
      `monitor '${monitor.name}' fired → ${result.kind}` +
        (result.runId ? ` (run: ${result.runId})` : '') +
        (result.ok ? '' : ` FAILED: ${result.error}`),
    );
  }
}
