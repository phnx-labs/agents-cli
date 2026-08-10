import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { decideFire, evaluateMonitorOnce, MonitorEngine, shouldEscalateDrought } from './engine.js';
import { writeState, readState, readLiveness, getMonitorHistoryDir } from './state.js';
import type { MonitorConfig } from './config.js';

function monitor(partial: Partial<MonitorConfig>): MonitorConfig {
  return {
    name: partial.name!,
    enabled: true,
    source: { type: 'command', command: 'echo x' },
    condition: { mode: 'on-change' },
    action: { type: 'notify', notifyChannel: 'telegram' },
    ...partial,
  } as MonitorConfig;
}

const names: string[] = [];
function uniq(tag: string): string {
  const n = `test-engine-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  names.push(n);
  return n;
}

afterEach(() => {
  for (const n of names.splice(0)) {
    try { fs.rmSync(getMonitorHistoryDir(n), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('decideFire — every mode', () => {
  it('always fires', () => {
    const m = monitor({ name: uniq('every'), condition: { mode: 'every' } });
    const d = decideFire(m, { raw: 'anything' });
    expect(d.fire).toBe(true);
    expect(d.event).not.toBeNull();
    expect(d.persist).toBe(false);
  });
});

describe('decideFire — on-change mode', () => {
  it('does NOT fire on the first observation (silent baseline) but marks it to persist', () => {
    const m = monitor({ name: uniq('onchange') });
    const d = decideFire(m, { raw: 'first' });
    expect(d.fire).toBe(false);
    expect(d.persist).toBe(true);
  });

  it('fires when the value differs from the stored baseline', () => {
    const name = uniq('onchange');
    const m = monitor({ name });
    writeState(name, 'baseline');
    expect(decideFire(m, { raw: 'baseline' }).fire).toBe(false);
    expect(decideFire(m, { raw: 'changed' }).fire).toBe(true);
  });
});

describe('decideFire — match mode', () => {
  it('fires once on a match, then stays silent until the matched token changes', () => {
    const name = uniq('match');
    const m = monitor({ name, condition: { mode: 'match', match: 'fail' } });

    // No match → no fire.
    expect(decideFire(m, { raw: 'all green' }).fire).toBe(false);

    // First match fires.
    const first = decideFire(m, { raw: 'build 1 fail' });
    expect(first.fire).toBe(true);

    // Persist the fired value (what the engine does on fire), then re-observe.
    writeState(name, first.value, m.condition.dedupeKey);
    expect(decideFire(m, { raw: 'build 2 fail' }).fire).toBe(false); // same matched token 'fail'
  });
});

describe('evaluateMonitorOnce — real command source, no side effects', () => {
  it('evaluates a command source and reports a fire decision without writing state', async () => {
    const name = uniq('once');
    const m = monitor({ name, source: { type: 'command', command: 'echo alive' }, condition: { mode: 'every' } });
    const { observation, decision } = await evaluateMonitorOnce(m);
    expect(observation?.raw).toBe('alive');
    expect(decision?.fire).toBe(true);
    // Dry-run must not persist.
    expect(fs.existsSync(getMonitorHistoryDir(name))).toBe(false);
  });
});

describe('MonitorEngine.runMonitor — liveness heartbeat (RUSH-2485)', () => {
  const engine = new MonitorEngine();

  it('records a heartbeat on a poll that matches NOTHING — the core bug', async () => {
    // A match-mode monitor whose regex never matches used to leave zero trace:
    // decideFire returns fire:false/persist:false, so writeState was never called
    // and `view` showed state:null, indistinguishable from "never polled".
    const name = uniq('nomatch');
    const m = monitor({
      name,
      source: { type: 'command', command: 'echo all-green' },
      condition: { mode: 'match', match: 'FAILURE' },
    });
    await engine.runMonitor(m);
    // The fix: a liveness heartbeat exists even though nothing fired or persisted.
    const live = readLiveness(name);
    expect(live).not.toBeNull();
    expect(live!.checkCount).toBe(1);
    expect(live!.consecutiveErrors).toBe(0);
    expect(live!.lastError).toBeUndefined();
    // And change-detection state is still absent — it never fired.
    expect(readState(name)).toBeNull();

    // A second poll advances the heartbeat.
    await engine.runMonitor(m);
    expect(readLiveness(name)!.checkCount).toBe(2);
  });

  it('records a heartbeat AND a fire when the action runs (webhook-out to an unreachable URL)', async () => {
    const name = uniq('fire');
    const m = monitor({
      name,
      source: { type: 'command', command: 'echo tick' },
      condition: { mode: 'every' },
      // Unreachable URL: the action attempt fails fast, no owner is touched, and a
      // single failure stays below the drought threshold so no owner notify fires.
      action: { type: 'webhook-out', url: 'http://127.0.0.1:1/' },
    });
    await engine.runMonitor(m);
    const live = readLiveness(name);
    expect(live!.checkCount).toBe(1);
    // The fired action failed, so this check counts as a failure for drought.
    expect(live!.consecutiveErrors).toBe(1);
    expect(live!.lastError).toContain('webhook-out');
    // It fired, so lastFiredAt is recorded regardless of the action outcome.
    expect(readState(name)!.lastFiredAt).toBeTruthy();
  });

  it('records NO liveness for a push-only source (ws) — those deliver via subscribe', async () => {
    const name = uniq('push');
    const m = monitor({ name, source: { type: 'ws', wsUrl: 'ws://127.0.0.1:1/' }, condition: { mode: 'every' } });
    await engine.runMonitor(m);
    expect(readLiveness(name)).toBeNull();
  });
});

describe('shouldEscalateDrought', () => {
  it('escalates once a run of failed checks crosses the threshold', () => {
    expect(shouldEscalateDrought({ consecutiveErrors: 4 })).toBe(false);
    expect(shouldEscalateDrought({ consecutiveErrors: 5 })).toBe(true);
  });
  it('does not escalate again once notified for this drought', () => {
    expect(shouldEscalateDrought({ consecutiveErrors: 9, droughtNotifiedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
  });
});
