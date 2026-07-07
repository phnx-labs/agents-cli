import { describe, it, expect } from 'vitest';
import { selectSessionsToFetch, resolveMirrorWrite, reconcileCopies, type RemoteCopy } from './sync.js';
import { sourceSignature } from './manifest.js';
import { SYNC_AGENTS } from './agents.js';
import { toPosix } from '../../platform/index.js';

const claude = SYNC_AGENTS.find(s => s.id === 'claude')!;

function copy(machine: string, sessionId: string, hash: string, relKey?: string): RemoteCopy {
  return { machine, entry: { relKey: relKey ?? `proj/${sessionId}.jsonl`, size: 1, hash, lastTs: '2026-06-20T00:00:00Z' } };
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
