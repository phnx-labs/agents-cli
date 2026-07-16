/**
 * Verifies the offset-tail NDJSON parser that backs `GET /api/session/:id/stream`.
 * The load-bearing properties: byte-accurate resume offsets (so an SSE client
 * never loses or double-counts an event across a reconnect), a trailing partial
 * line left unconsumed until its newline arrives, terminal-event detection, and
 * multi-byte UTF-8 correctness. Uses real temp files (readNewEvents takes a path).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readNewEvents, normalizeEvent } from './stream.js';

let tmp: string | null = null;
function tmpFile(contents = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-stream-'));
  tmp = dir;
  const f = path.join(dir, 'run.ndjson');
  fs.writeFileSync(f, contents);
  return f;
}
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('normalizeEvent', () => {
  it('keys off type and carries raw through untouched', () => {
    const ev = normalizeEvent({ type: 'assistant', message: { x: 1 } });
    expect(ev.type).toBe('assistant');
    expect(ev.raw).toEqual({ type: 'assistant', message: { x: 1 } });
  });
  it('falls back to unknown when type is absent', () => {
    expect(normalizeEvent({ nope: true }).type).toBe('unknown');
    expect(normalizeEvent(null).type).toBe('unknown');
  });
});

describe('readNewEvents', () => {
  it('returns nothing for a not-yet-created file, holding the offset', () => {
    const r = readNewEvents(path.join(os.tmpdir(), 'does-not-exist-xyz.ndjson'), 0);
    expect(r).toEqual({ events: [], newOffset: 0, done: false });
  });

  it('parses complete lines and skips non-JSON preamble', () => {
    const f = tmpFile('rotation banner line\n{"type":"system"}\n{"type":"assistant"}\n');
    const r = readNewEvents(f, 0);
    expect(r.events.map((e) => e.event.type)).toEqual(['system', 'assistant']);
    expect(r.done).toBe(false);
  });

  it('gives each event the exact byte offset past its newline (resume point)', () => {
    const l1 = '{"type":"system"}\n';
    const l2 = '{"type":"assistant"}\n';
    const f = tmpFile(l1 + l2);
    const r = readNewEvents(f, 0);
    expect(r.events[0].offset).toBe(Buffer.byteLength(l1));
    expect(r.events[1].offset).toBe(Buffer.byteLength(l1 + l2));
    expect(r.newOffset).toBe(Buffer.byteLength(l1 + l2));
  });

  it('leaves a trailing partial line unconsumed until its newline arrives', () => {
    const complete = '{"type":"system"}\n';
    const f = tmpFile(complete + '{"type":"assist'); // no newline yet
    const r1 = readNewEvents(f, 0);
    expect(r1.events.map((e) => e.event.type)).toEqual(['system']);
    expect(r1.newOffset).toBe(Buffer.byteLength(complete)); // partial NOT consumed

    // Harness flushes the rest of the line + newline.
    fs.appendFileSync(f, 'ant"}\n');
    const r2 = readNewEvents(f, r1.newOffset);
    expect(r2.events.map((e) => e.event.type)).toEqual(['assistant']);
  });

  it('resumes from a mid-file offset without replaying earlier events', () => {
    const l1 = '{"type":"system"}\n';
    const f = tmpFile(l1 + '{"type":"assistant"}\n');
    const r = readNewEvents(f, Buffer.byteLength(l1));
    expect(r.events.map((e) => e.event.type)).toEqual(['assistant']);
  });

  it('flags done when a terminal result event is seen', () => {
    const f = tmpFile('{"type":"assistant"}\n{"type":"result"}\n');
    const r = readNewEvents(f, 0);
    expect(r.done).toBe(true);
  });

  it('computes byte offsets correctly across multi-byte UTF-8', () => {
    const l1 = '{"type":"assistant","t":"café ☕"}\n'; // multi-byte chars
    const l2 = '{"type":"result"}\n';
    const f = tmpFile(l1 + l2);
    const r = readNewEvents(f, 0);
    expect(r.events[0].offset).toBe(Buffer.byteLength(l1));
    expect(r.events[1].offset).toBe(Buffer.byteLength(l1 + l2));
    // Resuming at the first event's byte offset yields exactly the second line.
    const r2 = readNewEvents(f, r.events[0].offset);
    expect(r2.events.map((e) => e.event.type)).toEqual(['result']);
  });
});
