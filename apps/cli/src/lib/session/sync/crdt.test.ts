import { describe, it, expect } from 'vitest';
import { mergeTranscripts, parseTranscript, transcriptStats } from './crdt.js';

/** Build a Claude-style event line. */
function ev(uuid: string, ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'user', uuid, timestamp: ts, ...extra });
}

const e1 = ev('a', '2026-06-20T10:00:00.000Z');
const e2 = ev('b', '2026-06-20T10:00:01.000Z');
const e3 = ev('c', '2026-06-20T10:00:02.000Z');
const e4 = ev('d', '2026-06-20T10:00:03.000Z');

describe('mergeTranscripts — verbatim fast paths (the 99% case)', () => {
  it('returns the single source unchanged, byte-for-byte', () => {
    const f = [e1, e2, e3].join('\n') + '\n';
    expect(mergeTranscripts([f])).toBe(f);
  });

  it('returns identical sources unchanged', () => {
    const f = [e1, e2].join('\n') + '\n';
    expect(mergeTranscripts([f, f])).toBe(f);
  });

  it('returns the superset verbatim when one side is a prefix of the other', () => {
    const short = [e1, e2].join('\n') + '\n';
    const long = [e1, e2, e3, e4].join('\n') + '\n';
    // order of args must not matter — superset wins either way
    expect(mergeTranscripts([short, long])).toBe(long);
    expect(mergeTranscripts([long, short])).toBe(long);
  });

  it('preserves legitimately duplicated lines (paired queue-operation entries)', () => {
    const dup = JSON.stringify({ type: 'queue-operation', timestamp: '2026-06-20T09:00:00.000Z' });
    const f = [dup, dup, e1].join('\n') + '\n';
    // single source: verbatim, both dups kept
    expect(mergeTranscripts([f])).toBe(f);
    // subset (one dup) merged with full: superset (two dups) wins verbatim
    const subset = [dup, e1].join('\n') + '\n';
    expect(mergeTranscripts([subset, f])).toBe(f);
  });
});

describe('mergeTranscripts — true fork union (the rare cross-machine resume)', () => {
  it('unions divergent branches losslessly, ordered by timestamp', () => {
    // common prefix e1,e2 ; machine A adds e3 ; machine B adds e4
    const a = [e1, e2, e3].join('\n') + '\n';
    const b = [e1, e2, e4].join('\n') + '\n';
    const merged = mergeTranscripts([a, b]);
    const lines = merged.trimEnd().split('\n');
    expect(lines).toEqual([e1, e2, e3, e4]); // sorted by ts, nothing lost
  });

  it('is commutative — arg order does not change the result', () => {
    const a = [e1, e3].join('\n') + '\n';
    const b = [e2, e4].join('\n') + '\n';
    expect(mergeTranscripts([a, b])).toBe(mergeTranscripts([b, a]));
  });

  it('is deterministic regardless of input line order within a fork', () => {
    const a = [e3, e1].join('\n') + '\n'; // intentionally unsorted
    const b = [e4, e2].join('\n') + '\n';
    const m1 = mergeTranscripts([a, b]);
    const m2 = mergeTranscripts([b, a]);
    expect(m1).toBe(m2);
    expect(m1.trimEnd().split('\n')).toEqual([e1, e2, e3, e4]);
  });

  it('is idempotent — merging the merge yields the same bytes', () => {
    const a = [e1, e2, e3].join('\n') + '\n';
    const b = [e1, e2, e4].join('\n') + '\n';
    const once = mergeTranscripts([a, b]);
    expect(mergeTranscripts([once])).toBe(once);
    expect(mergeTranscripts([once, a])).toBe(once); // a is now a subset of `once`
    expect(mergeTranscripts([once, once])).toBe(once);
  });

  it('keeps the higher multiplicity of a duplicated line across a fork', () => {
    const dup = JSON.stringify({ type: 'x', timestamp: '2026-06-20T08:00:00.000Z' });
    const a = [dup, e1].join('\n') + '\n';
    const b = [dup, dup, e2].join('\n') + '\n';
    const merged = mergeTranscripts([a, b]).trimEnd().split('\n');
    expect(merged.filter(l => l === dup).length).toBe(2); // max(1,2)
    expect(merged).toContain(e1);
    expect(merged).toContain(e2);
  });
});

describe('mergeTranscripts — edge cases', () => {
  it('handles empty and blank inputs', () => {
    expect(mergeTranscripts([])).toBe('');
    expect(mergeTranscripts(['', ''])).toBe('');
    const f = e1 + '\n';
    expect(mergeTranscripts(['', f])).toBe(f);
  });

  it('tolerates non-JSON / no-timestamp lines without dropping them', () => {
    const a = ['not json', e1].join('\n') + '\n';
    const b = [e2].join('\n') + '\n';
    const merged = mergeTranscripts([a, b]).trimEnd().split('\n');
    expect(merged).toContain('not json');
    expect(merged).toContain(e1);
    expect(merged).toContain(e2);
  });

  it('handles Codex-style lines (no uuid, top-level timestamp)', () => {
    const c1 = JSON.stringify({ type: 'response_item', timestamp: '2026-06-20T10:00:00.000Z', payload: { type: 'message', n: 1 } });
    const c2 = JSON.stringify({ type: 'response_item', timestamp: '2026-06-20T10:00:01.000Z', payload: { type: 'message', n: 2 } });
    const a = [c1].join('\n') + '\n';
    const b = [c1, c2].join('\n') + '\n';
    expect(mergeTranscripts([a, b])).toBe(b); // c1 ⊆ {c1,c2}: superset verbatim
  });
});

describe('parseTranscript / transcriptStats', () => {
  it('counts events and finds the latest timestamp', () => {
    const f = [e1, e3, e2].join('\n') + '\n';
    expect(parseTranscript(f)).toHaveLength(3);
    expect(transcriptStats(f)).toEqual({ events: 3, lastTs: '2026-06-20T10:00:02.000Z' });
  });
});
