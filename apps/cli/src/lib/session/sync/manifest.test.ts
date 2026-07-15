import { describe, it, expect } from 'vitest';
import { manifestEntries, sourceSignature, type ManifestEntry } from './manifest.js';

const entry = (relKey: string, hash: string): ManifestEntry => ({ relKey, size: 1, hash, lastTs: '2026-07-15T00:00:00Z' });

describe('manifestEntries (RUSH-1466 backward-compat normalization)', () => {
  it('wraps a single-object entry (older CLI / file-shaped) into a length-1 list', () => {
    const single = entry('proj/abc.jsonl', 'h1');
    expect(manifestEntries(single)).toEqual([single]);
  });

  it('returns an array entry (dir-shaped) as-is', () => {
    const arr = [entry('s/state.json', 'h1'), entry('s/wire.jsonl', 'h2')];
    expect(manifestEntries(arr)).toBe(arr);
  });

  it('a session-wide signature spans all files, so any file change re-pulls the session', () => {
    const before = manifestEntries([entry('s/state.json', 'h1'), entry('s/wire.jsonl', 'h2')]);
    const after = manifestEntries([entry('s/state.json', 'h1'), entry('s/wire.jsonl', 'h2-grown')]);
    const sig = (es: ManifestEntry[]) => sourceSignature(es.map(e => e.hash));
    expect(sig(before)).not.toBe(sig(after)); // wire.jsonl grew -> signature changes -> re-fetch
  });
});
