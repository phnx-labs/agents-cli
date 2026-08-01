/**
 * Tests for the canonical watchdog.log writer (watchdog-brain-v2).
 *
 * The Factory Floor card reads this JSONL feed with the parser in
 * apps/factory/src/core/watchdogLog.ts. No cross-app import is allowed, so these
 * tests pin the SHAPE that reader consumes: one JSON object per line, a numeric
 * `ts`, a known `kind`, a string `message`, and the optional context fields —
 * plus the line-cap trim so the file never grows unbounded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendWatchdogEvents, trimToLast, formatEvent, type WatchdogEvent } from './log.js';

const KNOWN_KINDS = new Set(['tick', 'decision', 'nudge', 'rotate', 'error']);

let dir: string;
let logPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-log-'));
  logPath = path.join(dir, 'watchdog.log');
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function readLines(): Record<string, unknown>[] {
  const raw = fs.readFileSync(logPath, 'utf8');
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

describe('appendWatchdogEvents', () => {
  it('writes one Factory-shaped JSON object per line and appends across calls', () => {
    appendWatchdogEvents([
      { ts: 1, kind: 'decision', terminalId: 'CC-1', agentType: 'claude', message: 'parked on a question', reason: 'parked', stalledForMs: 360_000, nudgeText: 'Finish it.', tailLines: ['{"a":1}'] },
    ], { logPath });
    appendWatchdogEvents([
      { ts: 2, kind: 'nudge', terminalId: 'CC-1', message: 'nudged via inject (vscodium)', nudgeText: 'Finish it.' },
      { ts: 3, kind: 'tick', message: '1 live · 1 stalled · 1 nudged · 0 un-addressable' },
    ], { logPath });

    const lines = readLines();
    expect(lines).toHaveLength(3);
    for (const row of lines) {
      expect(typeof row.ts).toBe('number');
      expect(KNOWN_KINDS.has(row.kind as string)).toBe(true);
      expect(typeof row.message).toBe('string');
    }
    // Context fields survive the round-trip so the card can render them.
    expect(lines[0]).toMatchObject({ kind: 'decision', terminalId: 'CC-1', stalledForMs: 360_000, nudgeText: 'Finish it.' });
    expect((lines[0].tailLines as string[])[0]).toBe('{"a":1}');
    expect(lines[1]).toMatchObject({ kind: 'nudge', terminalId: 'CC-1' });
  });

  it('trims to the last maxLines so the file never grows unbounded', () => {
    const many: WatchdogEvent[] = Array.from({ length: 10 }, (_, i) => ({ ts: i, kind: 'tick', message: `t${i}` }));
    appendWatchdogEvents(many, { logPath, maxLines: 4 });
    const lines = readLines();
    expect(lines).toHaveLength(4);
    // The most-recent events are kept.
    expect(lines.map((l) => l.message)).toEqual(['t6', 't7', 't8', 't9']);
  });

  it('is a no-op for an empty event list', () => {
    appendWatchdogEvents([], { logPath });
    expect(fs.existsSync(logPath)).toBe(false);
  });
});

describe('trimToLast / formatEvent', () => {
  it('formatEvent emits compact single-line JSON', () => {
    const line = formatEvent({ ts: 1, kind: 'tick', message: 'hi' });
    expect(line).toBe('{"ts":1,"kind":"tick","message":"hi"}');
    expect(line).not.toContain('\n');
  });

  it('trimToLast keeps a trailing newline and caps the body', () => {
    const body = ['{"ts":1}', '{"ts":2}', '{"ts":3}'].join('\n') + '\n';
    expect(trimToLast(body, 2)).toBe('{"ts":2}\n{"ts":3}\n');
    expect(trimToLast(body, 10)).toBe('{"ts":1}\n{"ts":2}\n{"ts":3}\n');
  });
});
