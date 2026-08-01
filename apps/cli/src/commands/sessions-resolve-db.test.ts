/**
 * `resolveSessionQuery` must answer a complete session id from the INDEX, not
 * only from the pool it was handed.
 *
 * The discovered pool is a minority of the index — it re-walks live agent homes
 * and skips whole classes of indexed session (measured on a real index: 2,798 of
 * 7,614 rows, leaving 1,315 sessions whose transcript is on disk invisible to
 * it). An earlier revision declared a complete id absent whenever the pool
 * missed, which turned those into a confident "No session with id X on this
 * machine" plus a pointer to go look on another host.
 *
 * These drive the real DB (isolated under a temp HOME, no mocks) with an EMPTY
 * pool, which is exactly the case the pool-only lookup got wrong.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB under a temp HOME before db.js/state.js capture the
// path at import time.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-resolve-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, closeDB } = await import('../lib/session/db.js');
const { resolveSessionQuery } = await import('./sessions.js');
type SessionMeta = import('../lib/session/types.js').SessionMeta;

// querySessions (behind findSessionsById) drops rows whose transcript is gone,
// which is what keeps "on this machine" truthful — so the fixture writes a real
// file rather than pointing at a path that does not exist.
function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  const filePath = path.join(TEST_HOME, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date().toISOString(),
    filePath,
    ...extra,
  };
}

afterAll(() => {
  // Close before removing the tree: Windows refuses to unlink an open file, so
  // a leaked connection (plus its WAL sidecars) fails the whole suite there with
  // EBUSY before a single assertion is reported.
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('resolveSessionQuery falls back to the index for a complete id', () => {
  const indexed = 'a7c1d88d-b543-48c1-993d-dd5cd8e210c9';

  it('finds an indexed session the discovered pool never returned', () => {
    upsertSession(meta(indexed, { topic: 'old but present' }), '');
    const r = resolveSessionQuery([], indexed);
    expect(r.matches.map(s => s.id)).toEqual([indexed]);
    expect(r.completeId).toBe(true);
    expect(r.byId).toBe(true);
  });

  it('finds a session_-prefixed id from a non-discovered agent', () => {
    const rushId = 'session_001fa16e-9f97-453d-b0f0-5c35317bcd04';
    upsertSession(meta(rushId, { agent: 'rush', topic: 'competitive watch' }), '');
    expect(resolveSessionQuery([], rushId).matches.map(s => s.id)).toEqual([rushId]);
  });

  it('still reports a genuinely absent id as no match', () => {
    const absent = '2feeb449-5c73-4f1c-9163-8459e7aafeea';
    const r = resolveSessionQuery([], absent);
    expect(r.matches).toEqual([]);
    expect(r.completeId).toBe(true);
  });

  it('does not consult the index for a search phrase', () => {
    // A phrase must keep the ranked text path; reaching for an id lookup here
    // would resurrect the id/content confusion this whole change removes.
    const r = resolveSessionQuery([], 'old but present');
    expect(r.completeId).toBe(false);
    expect(r.byId).toBe(false);
  });

  it('a short/partial id resolves by id only — never fuzzy-matches content', () => {
    // Reproduces the bug: a bare hex short-id ("d3470b57") used to skip the id
    // path (isCompleteSessionId only caught full UUIDs) and fall to content
    // search, surfacing every transcript that merely MENTIONS the string — e.g.
    // a resume prompt echoing the parent id. It must resolve by id: no id starts
    // with "d3470b57" here, so the answer is "no match", not the mentioner.
    const mentioner = 'b91c2f0e-1111-2222-3333-444455556666';
    upsertSession(meta(mentioner, { topic: 'resume previous work: d3470b57' }), 'resume previous work d3470b57 earlier');
    const r = resolveSessionQuery([], 'd3470b57');
    expect(r.matches).toEqual([]);
    expect(r.byId).toBe(true);
    expect(r.completeId).toBe(false);
  });

  it('a short id that IS a real session prefix resolves to that session by id', () => {
    const full = 'd3470b57-2af6-4c11-b1de-3fab94f43603';
    upsertSession(meta(full, { topic: 'the real one' }), '');
    const r = resolveSessionQuery([], 'd3470b57');
    expect(r.matches.map(s => s.id)).toEqual([full]);
    expect(r.byId).toBe(true);
  });
});
