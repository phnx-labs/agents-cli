import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { decideFire, evaluateMonitorOnce } from './engine.js';
import { writeState, getMonitorHistoryDir } from './state.js';
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
