/**
 * Resource self-heal tick as a `PeriodicService` (RUSH-3193 P3).
 *
 * Fills missing resources, repairs invalid manifests, and fast-forwards
 * pristine stale plugins. Conservative 'safe' mode: never overwrites
 * hand-edited content. Does not run when the daemon's state directory no
 * longer exists — that is the state-dir self-check's signal to shut down;
 * background maintenance must not recreate the tree while it is mid-exit.
 *
 * The pre-migration inline timer also delayed its first fire by
 * `SELF_HEAL_KICKOFF_MS` (30s) so shims/PATH could settle shortly after daemon
 * start, without making launch itself busy. `startupDelayMs` below reproduces
 * that stagger through the supervisor's generic per-service contract
 * (`service.ts`) — every other tick still fires on the normal `intervalMs`
 * cadence; only self-heal's boot-time tick is deliberately staggered.
 */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { getDaemonDir } from '../state.js';
import * as fs from 'fs';

/** Matches the historical inline interval (daemon.ts SELF_HEAL_TICK_MS). Runs ~every 6h. */
const SELF_HEAL_TICK_MS = 6 * 60 * 60_000;
/** Hard cap per tick — a full resource repair sweep across every version home, short enough a hang never freezes the service for long relative to its 6h cadence. */
const SELF_HEAL_DEADLINE_MS = 10 * 60_000;
/** Matches the historical inline kickoff delay (daemon.ts SELF_HEAL_KICKOFF_MS). Staggers self-heal's first tick after shims/PATH settle, so launch itself isn't made busy. */
const SELF_HEAL_KICKOFF_MS = 30_000;

export class SelfHealService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'self-heal';
  readonly intervalMs = SELF_HEAL_TICK_MS;
  readonly deadlineMs = SELF_HEAL_DEADLINE_MS;
  readonly startupDelayMs = SELF_HEAL_KICKOFF_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections/handles to open — each tick re-checks the state dir itself.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup needed.
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    if (!fs.existsSync(getDaemonDir())) return;
    const { runSelfHeal, selfHealChangedAnything, selfHealNeedsAttention, summarizeSelfHeal } =
      await import('../self-heal/registry.js');
    if (!fs.existsSync(getDaemonDir())) return;
    const report = await runSelfHeal({ mode: 'safe' });
    if (selfHealChangedAnything(report) || selfHealNeedsAttention(report)) {
      ctx.log('INFO', `self-heal: ${summarizeSelfHeal(report)}`);
    }
  }
}
