import { describe, it, expect } from 'bun:test';
import * as path from 'path';
import { formatEvent, parseEvents, trimToLast, WatchdogEvent, WATCHDOG_LOG_PATH } from './watchdogLog';

describe('WATCHDOG_LOG_PATH', () => {
  it('uses the cache logs location shared by watchdog readers and writers', () => {
    expect(WATCHDOG_LOG_PATH.endsWith(path.join('.agents', '.cache', 'logs', 'watchdog.log'))).toBe(true);
  });
});

describe('formatEvent', () => {
  it('serializes event to JSON', () => {
    const ev: WatchdogEvent = {
      ts: 1714400000000,
      kind: 'nudge',
      message: 'continue',
      terminalId: 'CC-1234',
      agentType: 'claude',
      reason: 'stalled 90s',
    };
    const json = formatEvent(ev);
    const parsed = JSON.parse(json);
    expect(parsed.ts).toBe(1714400000000);
    expect(parsed.kind).toBe('nudge');
    expect(parsed.message).toBe('continue');
    expect(parsed.terminalId).toBe('CC-1234');
    expect(parsed.agentType).toBe('claude');
    expect(parsed.reason).toBe('stalled 90s');
  });
});

describe('parseEvents', () => {
  it('returns empty array for empty input', () => {
    expect(parseEvents('')).toEqual([]);
    expect(parseEvents('   ')).toEqual([]);
  });

  it('parses valid JSONL lines', () => {
    const log = [
      JSON.stringify({ ts: 1000, kind: 'tick', message: 'stalled 30s' }),
      JSON.stringify({ ts: 2000, kind: 'decision', message: 'nudge', terminalId: 'CC-1' }),
      JSON.stringify({ ts: 3000, kind: 'nudge', message: 'continue', reason: 'waiting' }),
    ].join('\n');
    const events = parseEvents(log);
    expect(events.length).toBe(3);
    expect(events[0].kind).toBe('tick');
    expect(events[1].terminalId).toBe('CC-1');
    expect(events[2].reason).toBe('waiting');
  });

  it('skips malformed lines', () => {
    const log = [
      'not json',
      JSON.stringify({ ts: 1000, kind: 'tick', message: 'ok' }),
      '{ broken json',
      JSON.stringify({ ts: 2000, kind: 'nudge', message: 'ok2' }),
    ].join('\n');
    const events = parseEvents(log);
    expect(events.length).toBe(2);
  });

  it('skips lines with invalid ts', () => {
    const log = JSON.stringify({ ts: 'not-a-number', kind: 'tick', message: 'x' });
    expect(parseEvents(log)).toEqual([]);
  });

  it('skips lines with unknown kind', () => {
    const log = JSON.stringify({ ts: 1000, kind: 'unknown', message: 'x' });
    expect(parseEvents(log)).toEqual([]);
  });

  it('parses all valid kinds', () => {
    const kinds = ['tick', 'decision', 'nudge', 'rotate', 'error'] as const;
    const log = kinds.map((k, i) => JSON.stringify({ ts: i * 1000, kind: k, message: k })).join('\n');
    const events = parseEvents(log);
    expect(events.length).toBe(5);
    expect(events.map((e) => e.kind)).toEqual([...kinds]);
  });

  it('handles optional fields', () => {
    const log = JSON.stringify({ ts: 1000, kind: 'tick', message: 'hi' });
    const [ev] = parseEvents(log);
    expect(ev.terminalId).toBeUndefined();
    expect(ev.agentType).toBeUndefined();
    expect(ev.reason).toBeUndefined();
  });

  it('round-trips tailLines, stalledForMs, lastUserMessage, lastAssistantMessage, nudgeText', () => {
    const original: WatchdogEvent = {
      ts: 4000,
      kind: 'decision',
      message: 'nudge',
      terminalId: 'CC-2',
      agentType: 'claude',
      reason: 'stalled 90s',
      tailLines: ['{"type":"user"}', '{"type":"assistant"}'],
      stalledForMs: 90000,
      lastUserMessage: 'fix the bug',
      lastAssistantMessage: 'looking at auth.ts',
      nudgeText: 'continue',
    };
    const [parsed] = parseEvents(formatEvent(original));
    expect(parsed.tailLines).toEqual(original.tailLines);
    expect(parsed.stalledForMs).toBe(90000);
    expect(parsed.lastUserMessage).toBe('fix the bug');
    expect(parsed.lastAssistantMessage).toBe('looking at auth.ts');
    expect(parsed.nudgeText).toBe('continue');
  });
});

describe('trimToLast', () => {
  it('returns unchanged if under limit', () => {
    const text = 'line1\nline2\nline3\n';
    expect(trimToLast(text, 5)).toBe('line1\nline2\nline3\n');
  });

  it('trims to last N lines when over limit', () => {
    const text = 'a\nb\nc\nd\ne\n';
    expect(trimToLast(text, 3)).toBe('c\nd\ne\n');
  });

  it('handles text without trailing newline', () => {
    const text = 'a\nb\nc';
    expect(trimToLast(text, 2)).toBe('b\nc\n');
  });

  it('handles empty input', () => {
    expect(trimToLast('', 5)).toBe('');
  });

  it('handles whitespace-only lines', () => {
    const text = 'a\n  \nb\n\nc\n';
    expect(trimToLast(text, 2)).toBe('b\nc\n');
  });
});
