/**
 * CRDT merge for agent transcripts.
 *
 * A transcript (Claude JSONL, Codex JSONL, …) is an append-only log of
 * immutable events: each line is written once and never rewritten, and Claude
 * already tolerates branches within one file (parentUuid fan-out). That makes a
 * transcript a grow-only set (G-Set) of events, and merging two copies of the
 * same session is a set union — associative, commutative, idempotent. Two
 * machines that each appended to the same session therefore converge to the
 * exact same merged file regardless of sync order or timing, with zero conflict
 * resolution and zero data loss.
 *
 * Events are identified by the SHA-256 of their raw line bytes. We deliberately
 * do NOT key on a per-event `uuid`: Codex lines carry no id, and because an
 * event is written exactly once and then copied verbatim across machines, the
 * raw bytes are a stable, agent-agnostic identity. Multiplicity is preserved
 * (some transcripts contain legitimately identical lines, e.g. paired
 * `queue-operation` entries) by taking the per-hash max count across sources.
 */

import * as crypto from 'crypto';

export interface ParsedEvent {
  /** Original line bytes, exactly as stored (no trailing newline). */
  raw: string;
  /** SHA-256 of `raw` — the event's identity. */
  hash: string;
  /** Top-level ISO `timestamp`, or '' when absent/unparseable. */
  ts: string;
}

/** Extract the top-level `timestamp` field both Claude and Codex stamp per line. */
function lineTimestamp(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    const ts = obj?.timestamp;
    return typeof ts === 'string' ? ts : '';
  } catch {
    return '';
  }
}

/** Parse a transcript's raw text into events, skipping blank lines. */
export function parseTranscript(content: string): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    out.push({
      raw: line,
      hash: crypto.createHash('sha256').update(line).digest('hex'),
      ts: lineTimestamp(line),
    });
  }
  return out;
}

/** Order events deterministically across machines: by timestamp, then hash. */
function compareEvents(a: ParsedEvent, b: ParsedEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.hash !== b.hash) return a.hash < b.hash ? -1 : 1;
  return 0;
}

/**
 * Merge copies of the same session into one transcript via G-Set union.
 *
 * Returns a source VERBATIM (no reordering, byte-identical) for the common
 * cases — one source, all sources identical, or one source a superset of the
 * rest — so the steady state never rewrites unchanged files. Only a true fork
 * (each side holds events the other lacks) produces a reordered union, sorted
 * by (timestamp, hash) so every machine derives identical bytes.
 */
export function mergeTranscripts(contents: string[]): string {
  const sources = contents.filter(c => c.length > 0);
  if (sources.length === 0) return '';
  if (sources.length === 1) return sources[0];

  const parsed = sources.map(parseTranscript);

  // Per-source multiset of event hashes.
  const counts = parsed.map(events => {
    const m = new Map<string, number>();
    for (const e of events) m.set(e.hash, (m.get(e.hash) ?? 0) + 1);
    return m;
  });

  // Global max count per hash + a representative event for raw bytes / ts.
  const maxCount = new Map<string, number>();
  const rep = new Map<string, ParsedEvent>();
  for (let i = 0; i < parsed.length; i++) {
    for (const e of parsed[i]) if (!rep.has(e.hash)) rep.set(e.hash, e);
    for (const [h, c] of counts[i]) maxCount.set(h, Math.max(maxCount.get(h) ?? 0, c));
  }

  // Superset fast path: a source whose multiset already equals the global max
  // is the union — return it byte-for-byte (covers identical/subset/prefix).
  for (let i = 0; i < sources.length; i++) {
    let isSuperset = true;
    for (const [h, c] of maxCount) {
      if ((counts[i].get(h) ?? 0) !== c) {
        isSuperset = false;
        break;
      }
    }
    if (isSuperset) return sources[i];
  }

  // True fork: emit each distinct event maxCount times, deterministically ordered.
  const distinct = [...rep.values()].sort(compareEvents);
  const lines: string[] = [];
  for (const e of distinct) {
    const n = maxCount.get(e.hash) ?? 1;
    for (let k = 0; k < n; k++) lines.push(e.raw);
  }
  const trailing = sources.some(s => s.endsWith('\n')) ? '\n' : '';
  return lines.join('\n') + trailing;
}

/** Count distinct + total events across copies (for logging / manifest stats). */
export function transcriptStats(content: string): { events: number; lastTs: string } {
  const parsed = parseTranscript(content);
  let lastTs = '';
  for (const e of parsed) if (e.ts > lastTs) lastTs = e.ts;
  return { events: parsed.length, lastTs };
}
