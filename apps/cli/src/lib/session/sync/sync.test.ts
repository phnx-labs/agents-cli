import { describe, it, expect } from 'vitest';
import { selectSessionsToFetch, resolveMirrorWrite, reconcileCopies, deriveLastTs, type RemoteCopy } from './sync.js';
import { sourceSignature } from './manifest.js';
import { transcriptStats } from './crdt.js';
import { SYNC_AGENTS } from './agents.js';
import { toPosix } from '../../platform/index.js';

const claude = SYNC_AGENTS.find(s => s.id === 'claude')!;
const kimi = SYNC_AGENTS.find(s => s.id === 'kimi')!;

function copy(machine: string, sessionId: string, hash: string, relKey?: string): RemoteCopy {
  return { machine, entry: { relKey: relKey ?? `proj/${sessionId}.jsonl`, size: 1, hash, lastTs: '2026-06-20T00:00:00Z' } };
}

/** A copy with an explicit relKey + lastTs, for dir-shaped / LWW cases. */
function fileCopy(machine: string, relKey: string, hash: string, lastTs: string): RemoteCopy {
  return { machine, entry: { relKey, size: 1, hash, lastTs } };
}

function copies(...cs: Array<[string, RemoteCopy[]]>): Map<string, Map<string, RemoteCopy[]>> {
  const byAgent = new Map<string, RemoteCopy[]>(cs);
  return new Map([['claude', byAgent]]);
}

describe('selectSessionsToFetch', () => {
  it('skips sessions present in the local home (home wins)', () => {
    const c = copies(['s1', [copy('mac', 's1', 'h1')]]);
    const local = new Map([['claude', new Set(['s1'])]]);
    expect(selectSessionsToFetch(c, local, {})).toHaveLength(0);
  });

  it('returns remote-only sessions as pending', () => {
    const c = copies(['s1', [copy('mac', 's1', 'h1')]]);
    const pending = selectSessionsToFetch(c, new Map(), {});
    expect(pending.map(p => p.sessionId)).toEqual(['s1']);
    expect(pending[0].sig).toBe(sourceSignature(['h1']));
  });

  it('skips sessions whose source signature is unchanged (pull-state hit)', () => {
    const c = copies(['s1', [copy('mac', 's1', 'h1')]]);
    const state = { 'claude/s1': sourceSignature(['h1']) };
    expect(selectSessionsToFetch(c, new Map(), state)).toHaveLength(0);
  });

  it('re-fetches when a session grew (hash changed)', () => {
    const c = copies(['s1', [copy('mac', 's1', 'h2')]]);
    const state = { 'claude/s1': sourceSignature(['h1']) }; // old hash
    expect(selectSessionsToFetch(c, new Map(), state)).toHaveLength(1);
  });

  it('signature is order-independent across forked machines', () => {
    const ab = copies(['s1', [copy('a', 's1', 'h1'), copy('b', 's1', 'h2')]]);
    const ba = copies(['s1', [copy('b', 's1', 'h2'), copy('a', 's1', 'h1')]]);
    const sigAB = selectSessionsToFetch(ab, new Map(), {})[0].sig;
    const sigBA = selectSessionsToFetch(ba, new Map(), {})[0].sig;
    expect(sigAB).toBe(sigBA); // fork order must not force a re-pull
  });
});

describe('resolveMirrorWrite', () => {
  it('single copy: content verbatim, not flagged as merged', () => {
    const list = [copy('mac', 's1', 'h1')];
    const out = resolveMirrorWrite(claude, list, ['line1\nline2\n']);
    expect(out.content).toBe('line1\nline2\n');
    expect(out.merged).toBe(false);
    expect(toPosix(out.dest)).toContain('backups/claude/mac/projects/proj/s1.jsonl');
  });

  it('fork: unions content and picks a deterministic destination', () => {
    const e1 = JSON.stringify({ uuid: 'a', timestamp: '2026-06-20T10:00:00.000Z' });
    const e2 = JSON.stringify({ uuid: 'b', timestamp: '2026-06-20T10:00:01.000Z' });
    const listAB = [copy('zion', 's1', 'h1', 'p/zion.jsonl'), copy('s0', 's1', 'h2', 'p/s0.jsonl')];
    const listBA = [copy('s0', 's1', 'h2', 'p/s0.jsonl'), copy('zion', 's1', 'h1', 'p/zion.jsonl')];
    const a = e1 + '\n';
    const b = [e1, e2].join('\n') + '\n';

    const r1 = resolveMirrorWrite(claude, listAB, [a, b]);
    const r2 = resolveMirrorWrite(claude, listBA, [b, a]);

    expect(r1.merged).toBe(true);
    // smallest machine id ('s0') determines the canonical path, regardless of order
    expect(r1.dest).toBe(r2.dest);
    expect(toPosix(r1.dest)).toContain('backups/claude/s0/projects/p/s0.jsonl');
    // union is the superset b (a ⊆ b), byte-identical regardless of arg order
    expect(r1.content).toBe(b);
    expect(r2.content).toBe(b);
  });
});

describe('resolveMirrorWrite / reconcileCopies — C1 containment propagates to the caller', () => {
  // mirrorPath() rejects unsafe peer-controlled machine/relKey; that rejection
  // surfaces here, at the exact call the pullAndReconcile loop now wraps in a
  // per-session try/catch so one bad manifest entry can't wedge the whole tick.
  it('resolveMirrorWrite throws on a relKey that escapes the mirror root', () => {
    const list = [copy('mac', 's1', 'h1', '../../../../../../.ssh/authorized_keys')];
    expect(() => resolveMirrorWrite(claude, list, ['ssh-ed25519 AAAA...\n'])).toThrow();
  });

  it('reconcileCopies throws on a traversal relKey (the sync.ts:363 sink)', () => {
    const list = [copy('mac', 's1', 'h1', 'p/../../../../etc/cron.d/x')];
    expect(() => reconcileCopies(claude, list, ['* * * * * root sh\n'])).toThrow();
  });

  it('reconcileCopies throws on a malicious machine segment', () => {
    const list = [copy('..', 's1', 'h1', 'p/s1.jsonl')];
    expect(() => reconcileCopies(claude, list, ['x\n'])).toThrow();
  });

  it('a benign relKey still resolves without throwing', () => {
    const list = [copy('mac', 's1', 'h1', 'proj/s1.jsonl')];
    expect(() => resolveMirrorWrite(claude, list, ['x\n'])).not.toThrow();
  });
});

describe('reconcileCopies', () => {
  it('all copies present: unions and resolves a write', () => {
    const list = [copy('zion', 's1', 'h1', 'p/zion.jsonl'), copy('s0', 's1', 'h2', 'p/s0.jsonl')];
    const out = reconcileCopies(claude, list, ['a\n', 'a\nb\n']);
    expect(out).not.toBeNull();
    expect(out!.merged).toBe(true);
    expect(toPosix(out!.dest)).toContain('backups/claude/s0/projects/p/s0.jsonl');
  });

  it('single complete copy: resolves a verbatim, non-merged write', () => {
    const list = [copy('mac', 's1', 'h1')];
    const out = reconcileCopies(claude, list, ['line1\n']);
    expect(out).not.toBeNull();
    expect(out!.content).toBe('line1\n');
    expect(out!.merged).toBe(false);
  });

  // Regression for the pull-state poisoning bug: a fork where one copy 404s
  // (null) must NOT resolve a write. The caller skips both the mirror write and
  // the pull-state stamp, so the session retries next tick instead of
  // persisting a partial union and abandoning the missing branch forever.
  it('returns null when ANY listed copy is missing (incomplete fork fetch)', () => {
    const list = [copy('zion', 's1', 'h1', 'p/zion.jsonl'), copy('s0', 's1', 'h2', 'p/s0.jsonl')];
    expect(reconcileCopies(claude, list, ['a\n', null])).toBeNull();
    expect(reconcileCopies(claude, list, [null, 'a\nb\n'])).toBeNull();
    expect(reconcileCopies(claude, list, [null, null])).toBeNull();
  });

  it('returns null when nothing was fetched', () => {
    const list = [copy('mac', 's1', 'h1')];
    expect(reconcileCopies(claude, list, [null])).toBeNull();
  });
});

// RUSH-1466: a dir-shaped session (Kimi) spans several files with different merge
// rules. Each file's copies share a relKey and are reconciled independently — the
// append-only wire.jsonl unions, the mutable state.json takes last-writer-wins.
describe('dir-shaped per-file reconcile', () => {
  it('append-only .jsonl file unions across a fork (G-Set)', () => {
    const rel = 'wd/session_x/agents/main/wire.jsonl';
    const list = [fileCopy('zion', rel, 'h1', '2026-06-20T10:00:00Z'), fileCopy('s0', rel, 'h2', '2026-06-20T10:00:00Z')];
    const e1 = JSON.stringify({ t: 1, timestamp: '2026-06-20T10:00:00.000Z' });
    const e2 = JSON.stringify({ t: 2, timestamp: '2026-06-20T10:00:01.000Z' });
    const out = resolveMirrorWrite(kimi, list, [e1 + '\n', [e1, e2].join('\n') + '\n']);
    expect(out.merged).toBe(true);
    expect(out.content).toBe([e1, e2].join('\n') + '\n'); // union = superset
    expect(toPosix(out.dest)).toContain('backups/kimi/s0/sessions/' + rel); // smallest machine canonical
  });

  it('mutable state.json is NOT line-unioned — last-writer-wins by (lastTs, hash)', () => {
    const rel = 'wd/session_x/state.json';
    const older = JSON.stringify({ title: 'old', messages: 3 });
    const newer = JSON.stringify({ title: 'new', messages: 5 });
    const list = [
      fileCopy('zion', rel, 'h-old', '2026-06-20T10:00:00Z'),
      fileCopy('s0', rel, 'h-new', '2026-06-20T12:00:00Z'), // later timestamp wins
    ];
    const out = resolveMirrorWrite(kimi, list, [older, newer]);
    expect(out.content).toBe(newer); // latest wins verbatim — never a corrupt line-merge
    expect(JSON.parse(out.content)).toEqual({ title: 'new', messages: 5 }); // still valid JSON
    // canonical path is deterministic (smallest machine) regardless of who won
    expect(toPosix(out.dest)).toContain('backups/kimi/s0/sessions/' + rel);
  });

  it('LWW tie on lastTs breaks by hash, deterministically', () => {
    const rel = 'wd/session_x/state.json';
    const ts = '2026-06-20T10:00:00Z';
    const list = [fileCopy('a', rel, 'hAAA', ts), fileCopy('b', rel, 'hZZZ', ts)];
    const out = resolveMirrorWrite(kimi, list, ['contentA', 'contentZ']);
    expect(out.content).toBe('contentZ'); // 'hZZZ' > 'hAAA'
  });

  it('single copy of any file is written verbatim (the common round-trip)', () => {
    const rel = 'wd/session_x/state.json';
    const out = resolveMirrorWrite(kimi, [fileCopy('zion', rel, 'h1', '2026-06-20T10:00:00Z')], ['{"a":1}']);
    expect(out.merged).toBe(false);
    expect(out.content).toBe('{"a":1}');
    expect(toPosix(out.dest)).toContain('backups/kimi/zion/sessions/' + rel);
  });

  it('LWW over a mutable blob is not flagged as a CRDT merge', () => {
    const rel = 'wd/session_x/state.json';
    const list = [
      fileCopy('zion', rel, 'h-old', '2026-06-20T10:00:00Z'),
      fileCopy('s0', rel, 'h-new', '2026-06-20T12:00:00Z'),
    ];
    const out = resolveMirrorWrite(kimi, list, ['{"m":3}', '{"m":5}']);
    expect(out.content).toBe('{"m":5}'); // newer still wins
    expect(out.merged).toBe(false); // but it's a pick, not a line-union
  });
});

// RUSH-1466 review regression: a manifest entry's lastTs is derived at PUSH time.
// For append-only logs it is the latest embedded event timestamp; for mutable
// blobs (state.json, task sidecars) transcriptStats returns '' — so lastTs must
// fall back to the file mtime, else last-writer-wins degrades to hash-wins and can
// silently keep the stale copy.
describe('deriveLastTs (per-file manifest recency)', () => {
  it('append-only .jsonl uses the latest embedded event timestamp', () => {
    const rel = 'wd/session_x/agents/main/wire.jsonl';
    const content = [
      JSON.stringify({ t: 1, timestamp: '2026-06-20T10:00:00.000Z' }),
      JSON.stringify({ t: 2, timestamp: '2026-06-20T10:05:00.000Z' }),
    ].join('\n') + '\n';
    expect(deriveLastTs(kimi, rel, content, Date.UTC(2000, 0, 1))).toBe('2026-06-20T10:05:00.000Z');
  });

  it('mutable state.json falls back to mtime, never the empty string', () => {
    const rel = 'wd/session_x/state.json';
    // Real Kimi state.json shape: updatedAt/createdAt, no top-level `timestamp`.
    const content = JSON.stringify({ title: 'x', updatedAt: '2026-07-15T00:00:00Z', messages: 5 });
    const mtime = Date.UTC(2026, 6, 15, 12, 0, 0);
    expect(transcriptStats(content).lastTs).toBe(''); // the bug this guards
    expect(deriveLastTs(kimi, rel, content, mtime)).toBe(new Date(mtime).toISOString());
  });

  it('newer state.json wins LWW once lastTs is derived from mtime (end-to-end)', () => {
    const rel = 'wd/session_x/state.json';
    const older = JSON.stringify({ title: 'old', messages: 3 });
    const newer = JSON.stringify({ title: 'new', messages: 5 });
    const tOld = Date.UTC(2026, 6, 15, 10, 0, 0);
    const tNew = Date.UTC(2026, 6, 15, 12, 0, 0);
    // Hashes chosen so hash-order ('h-old' > 'h-new') DISAGREES with time-order —
    // if lastTs were still '' for both, the stale copy would win. It must not.
    const list = [
      fileCopy('zion', rel, 'h-old', deriveLastTs(kimi, rel, older, tOld)),
      fileCopy('s0', rel, 'h-new', deriveLastTs(kimi, rel, newer, tNew)),
    ];
    const out = resolveMirrorWrite(kimi, list, [older, newer]);
    expect(out.content).toBe(newer);
  });
});
