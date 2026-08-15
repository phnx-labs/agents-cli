/**
 * Monitor action dispatch.
 *
 * On a fire, the monitor feeds the event to an action. Every `run`/`routine`
 * action goes through the *same* detached spawn cron and webhook fires use
 * (executeJobDetached, lib/runner.ts) — a monitor never duplicates spawn logic,
 * it synthesizes a JobConfig and hands it to the one dispatch seam. `notify`
 * routes the owner through the one channel seam (sendToOwner → lookupTransport,
 * lib/notify.ts) — recipient from notify.owner, no hardcoded chat id, and an
 * unresolvable channel comes back as `ok: false` instead of exiting the daemon;
 * `webhook-out` POSTs the event.
 */

import { executeJobDetached } from '../runner.js';
import { readJob, type JobConfig } from '../routines.js';
import { sendToOwner } from '../notify.js';
import type { AgentId, Meta } from '../types.js';
import type { ActionConfig, MonitorConfig, MonitorEvent } from './config.js';

/** Outcome of a dispatched action. */
export interface DispatchResult {
  kind: ActionConfig['type'];
  ok: boolean;
  /** Run id for `run`/`routine` actions dispatched through executeJobDetached. */
  runId?: string;
  error?: string;
}

/** Replace `{event}` in a prompt with the fired event summary. */
export function injectEvent(prompt: string, event: MonitorEvent): string {
  return prompt.replace(/\{event\}/g, event.summary);
}

/**
 * Dispatch a monitor's action for a fired event. `run` synthesizes a JobConfig
 * (event injected into the prompt, action fields mapped onto the routines shape,
 * runOn → host placement) and calls executeJobDetached — the exact path routines
 * use. `routine` fires an existing routine with the event injected. `notify` and
 * `webhook-out` are terminal side-effects.
 */
export async function dispatchAction(
  monitor: MonitorConfig,
  event: MonitorEvent,
  meta?: Meta,
): Promise<DispatchResult> {
  const action = monitor.action;

  if (action.type === 'run') {
    const job: JobConfig = {
      name: monitor.name,
      agent: action.agent as AgentId,
      mode: action.mode ?? 'auto',
      effort: action.effort ?? 'auto',
      timeout: action.timeout ?? '10m',
      enabled: true,
      prompt: injectEvent(action.prompt ?? '', event),
      ...(monitor.variables ? { variables: monitor.variables } : {}),
      ...(monitor.version ? { version: monitor.version } : {}),
      ...(monitor.runOn ? { host: monitor.runOn } : {}),
    };
    try {
      const runMeta = await executeJobDetached(job);
      if (runMeta.status === 'skipped' || runMeta.status === 'blocked' || runMeta.status === 'failed') {
        return { kind: 'run', ok: false, runId: runMeta.runId, error: runMeta.errorMessage ?? runMeta.status };
      }
      return { kind: 'run', ok: true, runId: runMeta.runId };
    } catch (err) {
      return { kind: 'run', ok: false, error: (err as Error).message };
    }
  }

  if (action.type === 'routine') {
    const routine = action.routine ? readJob(action.routine) : null;
    if (!routine) {
      return { kind: 'routine', ok: false, error: `routine '${action.routine}' not found` };
    }
    // Inject the event into the routine's prompt so the fired routine sees it.
    const fired: JobConfig = { ...routine, prompt: injectEvent(routine.prompt ?? '', event) };
    try {
      const runMeta = await executeJobDetached(fired);
      if (runMeta.status === 'skipped' || runMeta.status === 'blocked' || runMeta.status === 'failed') {
        return { kind: 'routine', ok: false, runId: runMeta.runId, error: runMeta.errorMessage ?? runMeta.status };
      }
      return { kind: 'routine', ok: true, runId: runMeta.runId };
    } catch (err) {
      return { kind: 'routine', ok: false, error: (err as Error).message };
    }
  }

  if (action.type === 'notify') {
    const result = await sendToOwner(event.summary, {
      ...(meta ? { meta } : {}),
      ...(action.notifyChannel ? { channel: action.notifyChannel } : {}),
    });
    return { kind: 'notify', ok: result.ok, ...(result.ok ? {} : { error: result.error }) };
  }

  // webhook-out
  if (!action.url) return { kind: 'webhook-out', ok: false, error: 'action.url is required' };
  try {
    const res = await fetch(action.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    return { kind: 'webhook-out', ok: res.ok, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) };
  } catch (err) {
    return { kind: 'webhook-out', ok: false, error: (err as Error).message };
  }
}
