import { describe, it, expect } from 'vitest';
import { serializeSessionsJson } from './sessions.js';
import type { SessionMeta } from '../lib/session/types.js';

/**
 * `serializeSessionsJson` is the single seam both the local `agents sessions
 * --json` path and the new `--json --host` remote fan-out serialize through, so
 * a VS Code extension can `JSON.parse` a remote device's recent (historical,
 * non-active) sessions the same way it parses the local list. These assert the
 * output is a parseable `SessionMeta[]` array and that the internal-only
 * search/fan-out bookkeeping fields never leak into that public record.
 */

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'abcdef12-3456-7890-abcd-ef1234567890',
    shortId: 'abcdef12',
    agent: 'claude',
    timestamp: '2026-07-07T10:00:00.000Z',
    filePath: '/home/u/.agents/.history/sessions/abcdef12.jsonl',
    ...over,
  };
}

describe('serializeSessionsJson', () => {
  it('emits a parseable JSON array of SessionMeta (the shape a caller parses)', () => {
    const out = serializeSessionsJson([
      meta({ shortId: 'aaa', project: 'proj-a' }),
      meta({ id: 'ffff', shortId: 'bbb', project: 'proj-b' }),
    ]);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].shortId).toBe('aaa');
    expect(parsed[0].project).toBe('proj-a');
    expect(parsed[1].project).toBe('proj-b');
  });

  it('empty input serializes to an empty array (an offline/0-session host)', () => {
    // The --json --host fan-out contributes [] for a dead or session-less host,
    // so stdout must still be a valid empty array, never blank or a banner.
    const parsed = JSON.parse(serializeSessionsJson([]));
    expect(parsed).toEqual([]);
  });

  it('strips the internal _remote / _matchedTerms / _bm25Score fan-out+search fields', () => {
    // Remote rows come back tagged `_remote: true` from parseRemoteList; those
    // and the BM25 search bookkeeping are transient and must not leak to a
    // scripted consumer.
    const out = serializeSessionsJson([
      meta({ _remote: true, _matchedTerms: ['auth'], _bm25Score: 3.14, machine: 'mac-mini' }),
    ]);
    const row = JSON.parse(out)[0];
    expect(row).not.toHaveProperty('_remote');
    expect(row).not.toHaveProperty('_matchedTerms');
    expect(row).not.toHaveProperty('_bm25Score');
    // The real machine tag (a public field, not underscore-prefixed) survives so
    // a caller can still attribute each remote row to its host.
    expect(row.machine).toBe('mac-mini');
  });

  it('ends with a single trailing newline (line-oriented stdout contract)', () => {
    const out = serializeSessionsJson([meta()]);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});
