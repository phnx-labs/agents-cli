import { describe, expect, it } from 'vitest';
import { selectWatchdogHistory } from './history.js';
import { parseWatchdogEvents } from './log.js';

describe('watchdog history', () => {
  it('keeps valid JSONL rows around corrupt rows', () => {
    const rows = parseWatchdogEvents([
      JSON.stringify({ ts: 10, kind: 'decision', message: 'leave', terminalId: 'abc' }),
      '{partial',
      JSON.stringify({ ts: 11, kind: 'unknown', message: 'wrong' }),
      JSON.stringify({ ts: 12, kind: 'nudge', message: 'continued', terminalId: 'abc' }),
    ].join('\n'));
    expect(rows.map((row) => row.ts)).toEqual([10, 12]);
  });

  it('filters, orders, limits, and never exposes raw transcript tails', () => {
    const history = selectWatchdogHistory([
      { ts: 100, kind: 'tick', message: 'heartbeat', tailLines: ['secret'] },
      { ts: 200, kind: 'decision', message: 'skip', terminalId: 'ABC-1', tailLines: ['secret'] },
      { ts: 300, kind: 'nudge', message: 'continue', terminalId: 'abc-2', tailLines: ['secret'] },
    ], { sessionId: 'abc', limit: 1, nowMs: 400, sinceMs: 250 });

    expect(history).toEqual([{
      ts: 300,
      kind: 'nudge',
      sessionId: 'abc-2',
      agent: undefined,
      message: 'continue',
      reason: undefined,
      stalledForMs: undefined,
      nudgeText: undefined,
    }]);
    expect(history[0]).not.toHaveProperty('tailLines');
  });

  it('includes heartbeat ticks only when requested', () => {
    const events = [{ ts: 100, kind: 'tick' as const, message: 'heartbeat' }];
    expect(selectWatchdogHistory(events)).toEqual([]);
    expect(selectWatchdogHistory(events, { includeTicks: true })).toHaveLength(1);
  });

  it('expands compact tick inspections into session history', () => {
    const events = [{
      ts: 100,
      kind: 'tick' as const,
      message: '2 live',
      inspections: [{ terminalId: 'session-1', agentType: 'claude', message: 'skip', reason: 'working' }],
    }];
    expect(selectWatchdogHistory(events, { sessionId: 'session-1' })).toEqual([{
      ts: 100,
      kind: 'inspection',
      sessionId: 'session-1',
      agent: 'claude',
      message: 'skip',
      reason: 'working',
      stalledForMs: undefined,
    }]);
  });

  it('reserves room for actions when a large inspection batch fills the limit', () => {
    const inspections = Array.from({ length: 60 }, (_, i) => ({
      terminalId: `session-${i}`,
      agentType: 'claude',
      message: 'skip',
      reason: 'active',
    }));
    const history = selectWatchdogHistory([
      { ts: 200, kind: 'tick', message: '60 live', inspections },
      { ts: 100, kind: 'nudge', message: 'continued', terminalId: 'action-session' },
    ], { limit: 50 });
    expect(history).toHaveLength(50);
    expect(history.some((entry) => entry.kind === 'nudge')).toBe(true);
  });
});
