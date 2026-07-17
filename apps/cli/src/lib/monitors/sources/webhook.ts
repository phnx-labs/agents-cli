/**
 * Webhook source evaluator.
 *
 * Webhooks are push-based (an inbound signed HTTP delivery), so the poll-model
 * `evaluate` returns null. When a delivery arrives, the receiver matches it
 * against monitors with `matchWebhook`, which reuses the github/linear matchers
 * from lib/triggers/webhook.ts by projecting the monitor's webhook filters onto a
 * synthesized JobConfig-shaped trigger.
 */

import { jobMatchesWebhook, type IncomingWebhook } from '../../triggers/webhook.js';
import type { JobConfig, JobTrigger } from '../../routines.js';
import type { MonitorSource, MonitorConfig } from '../config.js';
import type { Observation } from './types.js';

/** Push-only: nothing to snapshot on a poll tick. */
export function evaluate(_source: MonitorSource): Promise<Observation | null> {
  return Promise.resolve(null);
}

/** Project a monitor's webhook source onto a JobTrigger for the shared matcher. */
export function monitorTrigger(source: MonitorSource): JobTrigger | null {
  const w = source.webhook;
  if (!w) return null;
  if (w.source === 'github') {
    return {
      type: 'github_event',
      event: w.event as JobTrigger extends { event: infer E } ? E : never,
      ...(w.repo ? { repo: w.repo } : {}),
      ...(w.branch ? { branch: w.branch } : {}),
    } as JobTrigger;
  }
  return {
    type: 'linear_event',
    event: w.event as JobTrigger extends { event: infer E } ? E : never,
    ...(w.action ? { action: w.action } : {}),
    ...(w.teamKey ? { teamKey: w.teamKey } : {}),
    ...(w.label ? { label: w.label } : {}),
  } as JobTrigger;
}

/**
 * True when an incoming webhook matches this monitor's webhook source — reuses
 * the routines matcher (lib/triggers/webhook.ts) so github/linear filter
 * semantics stay in one place.
 */
export function matchWebhook(monitor: MonitorConfig, webhook: IncomingWebhook): boolean {
  const trigger = monitorTrigger(monitor.source);
  if (!trigger) return false;
  const shim = { name: monitor.name, trigger } as unknown as JobConfig;
  return jobMatchesWebhook(shim, webhook);
}
