import { describe, it, expect } from 'vitest';
import { buildMonitorViewJson } from './monitors.js';
import type { MonitorConfig } from '../lib/monitors/config.js';
import type { MonitorState, FireRecord } from '../lib/monitors/state.js';

const config: MonitorConfig = {
  name: 'ci',
  enabled: true,
  source: { type: 'poll', command: 'gh pr checks', interval: '30s' } as MonitorConfig['source'],
  condition: { mode: 'match', match: 'fail' } as MonitorConfig['condition'],
  action: { type: 'notify', notifyChannel: 'telegram' } as MonitorConfig['action'],
};

const state: MonitorState = {
  monitorName: 'ci',
  lastHash: 'abc',
  lastValue: 'all green',
  lastSeenAt: '2026-07-21T00:00:00Z',
  lastFiredAt: '2026-07-20T00:00:00Z',
};

function fire(n: number): FireRecord {
  return { monitorName: 'ci', firedAt: `2026-07-2${n}T00:00:00Z`, summary: `fire ${n}`, payload: {} };
}

describe('buildMonitorViewJson', () => {
  it('carries the config, state, and the most recent fires verbatim', () => {
    const payload = buildMonitorViewJson('ci', config, state, [fire(1), fire(2)]);
    expect(payload.name).toBe('ci');
    expect(payload.config).toBe(config);
    expect(payload.state).toBe(state);
    expect(payload.recentFires).toEqual([fire(1), fire(2)]);
  });

  it('keeps only the last five fires', () => {
    const fires = [1, 2, 3, 4, 5, 6, 7].map(fire);
    const payload = buildMonitorViewJson('ci', config, state, fires);
    expect(payload.recentFires).toHaveLength(5);
    expect(payload.recentFires.map((f) => f.summary)).toEqual([
      'fire 3', 'fire 4', 'fire 5', 'fire 6', 'fire 7',
    ]);
  });

  it('normalizes a missing state to null', () => {
    const payload = buildMonitorViewJson('ci', config, null, []);
    expect(payload.state).toBeNull();
    expect(payload.recentFires).toEqual([]);
  });
});
