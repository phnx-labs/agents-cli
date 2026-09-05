/**
 * Session-summarizer service (PHNX-3939).
 *
 * The single daemon-owned executor that computes a per-session goal / progress
 * checkpoints / checklist and writes them to the transcript-keyed
 * `session_summaries` cache, from which the display/merge path serves them onto
 * the `sessions watch` stream. It NEVER runs on a request path.
 *
 * Off by default: `runSummarizerPass` no-ops unless `summarizer.enabled` and a
 * model endpoint (`summarizer.baseUrl` + `summarizer.model`) are configured, so a
 * daemon with the feature unconfigured makes zero model calls. Reader-gated and
 * bounded per tick like the other session services, so it costs nothing while no
 * one is watching.
 */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { runSummarizerPass } from '../summarizer/pass.js';

/** Slower than the state tick — a summary is a coarse signal, not live status. */
const SESSION_SUMMARIZER_TICK_MS = 20_000;
/** Hard cap per tick; a local model call is bounded, this leaves generous headroom. */
const SESSION_SUMMARIZER_DEADLINE_MS = 60_000;

export class SessionSummarizerService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'session-summarizer';
  readonly intervalMs = SESSION_SUMMARIZER_TICK_MS;
  readonly deadlineMs = SESSION_SUMMARIZER_DEADLINE_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No handles to open — each tick reads config + the warm session cache fresh.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release.
  }

  protected async onTick(ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    const r = await runSummarizerPass({ signal });
    if (r.disabled) return; // off / unconfigured — stay silent
    if (r.computed > 0 || r.skipped > 0) {
      ctx.log('INFO', `session-summarizer: computed ${r.computed}, skipped ${r.skipped}, reused ${r.reused}`);
    }
  }
}
