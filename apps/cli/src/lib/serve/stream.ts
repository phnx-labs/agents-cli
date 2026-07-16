/**
 * Live NDJSON event bridge for the iOS cockpit (RUSH-1732).
 *
 * A control-mode run (`defaultRunner`) is launched with `--json`, so the agent
 * harness emits one JSON event per line. We capture that stream to a per-session
 * logfile and replay it to the phone over SSE at `GET /api/session/:id/stream`,
 * normalized to the small event set the UI needs. The read is **offset-tailed**
 * — the same resumable pattern `hosts/progress.ts` uses for remote logs — so a
 * phone that drops mid-run reconnects with `?offset=<bytes>` (or the standard
 * `Last-Event-ID` header) and never loses or double-counts an event.
 *
 * Scope: this streams runs whose executor is the anchor itself (no `--host`).
 * Streaming a run offloaded to another box reuses `pullRemoteLogDelta` and is a
 * follow-up; see the changelog fragment.
 */
import fs from 'fs';
import path from 'path';
import { getCacheDir } from '../state.js';

/** Directory holding per-session NDJSON capture files. */
export function streamDir(): string {
  return path.join(getCacheDir(), 'serve', 'streams');
}

/** Capture-file path for a session id (id is sanitized to a safe filename). */
export function streamLogPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(streamDir(), `${safe}.ndjson`);
}

/** A normalized event handed to the phone. `raw` is the untouched harness line. */
export interface StreamEvent {
  /** UI-facing discriminator: message | tool_use | tool_result | result | error | system | unknown. */
  type: string;
  raw: unknown;
}

/** Event types that terminate a run's stream (close the SSE). */
const TERMINAL = new Set(['result', 'error']);

/**
 * Normalize one harness JSON line to a {@link StreamEvent}. Schemas differ per
 * agent (there is no unified enum in the CLI), so we key off the common `type`
 * field (Claude stream-json: `assistant` | `user` | `result` | `system`; a
 * tool-use lives inside an `assistant` message's content) and carry `raw`
 * through untouched so the client can render richer detail without the anchor
 * having to model every agent.
 */
export function normalizeEvent(obj: unknown): StreamEvent {
  const rec = obj as Record<string, unknown> | null;
  const t = rec && typeof rec.type === 'string' ? rec.type : 'unknown';
  return { type: t, raw: obj };
}

/** A parsed event paired with the byte offset immediately AFTER its line. */
export interface OffsetEvent {
  event: StreamEvent;
  /** Resume point: absolute byte offset just past this event's newline. */
  offset: number;
}

/** Result of one offset-tail read of a capture file. */
export interface ReadResult {
  events: OffsetEvent[];
  /** Byte offset advanced ONLY past complete newline-terminated lines. */
  newOffset: number;
  /** True once a terminal event (result/error) has been parsed. */
  done: boolean;
}

/**
 * Read complete NDJSON lines from `fromOffset`, byte-accurately. Each event
 * carries the exact byte offset past its own newline so an SSE client can set
 * `Last-Event-ID` per event and resume with neither loss nor duplication even
 * if the connection drops mid-batch. A trailing partial line (no newline yet)
 * is left unconsumed so the offset never splits a multi-byte event — the next
 * read picks it up once the harness flushes the newline. Non-JSON preamble
 * lines are skipped, not fatal.
 */
export function readNewEvents(file: string, fromOffset: number): ReadResult {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    // File not created yet (run still starting) — nothing to read, hold offset.
    return { events: [], newOffset: fromOffset, done: false };
  }
  if (fromOffset >= buf.length) return { events: [], newOffset: fromOffset, done: false };

  const slice = buf.subarray(fromOffset);
  const lastNl = slice.lastIndexOf(0x0a);
  if (lastNl < 0) return { events: [], newOffset: fromOffset, done: false }; // no complete line yet

  const events: OffsetEvent[] = [];
  let done = false;
  let lineStart = 0; // byte index within slice
  for (let i = 0; i <= lastNl; i++) {
    if (slice[i] !== 0x0a) continue;
    const lineBuf = slice.subarray(lineStart, i); // excludes the newline
    const endOffset = fromOffset + i + 1; // absolute byte offset just past '\n'
    lineStart = i + 1;
    const s = lineBuf.toString('utf-8').trim();
    if (!s) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      continue; // skip non-JSON (banner/preamble) lines
    }
    const ev = normalizeEvent(obj);
    events.push({ event: ev, offset: endOffset });
    if (TERMINAL.has(ev.type)) done = true;
  }
  return { events, newOffset: fromOffset + lastNl + 1, done };
}
