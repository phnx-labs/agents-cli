import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-sidecar-'));
process.env.HOME = TEST_HOME;

const { writeSessionActorRecord, readSessionActorRecord, loadSessionActorIndex } = await import('./actor-sidecar.js');
const { getDB, closeDB, upsertSession, upsertSessionsBatch, getSessionById } = await import('./db.js');
type SessionMeta = import('./types.js').SessionMeta;

const FILES = path.join(TEST_HOME, 'files');
fs.mkdirSync(FILES, { recursive: true });

/**
 * RUSH-2019 (P3): the durable sessionId -> actor sidecar makes the session
 * scanner able to attribute a transcript to a person after the launching process
 * is gone. Two things must hold: the record round-trips on disk, and the DB
 * upsert JOINS it to fill the write-once actor column when the scanned meta
 * carries none.
 */
describe('session actor sidecar (RUSH-2019)', () => {
  it('round-trips a written record and skips one with no session id', () => {
    writeSessionActorRecord({ sessionId: 'sid-1', actor: 'ada@example.com', initiatedBy: 'human', startedAtMs: 1 });
    const got = readSessionActorRecord('sid-1');
    expect(got?.actor).toBe('ada@example.com');
    expect(got?.initiatedBy).toBe('human');
    // No id -> no file written, and a read of an absent id is undefined.
    writeSessionActorRecord({ sessionId: '', actor: 'x', initiatedBy: 'human', startedAtMs: 1 });
    expect(readSessionActorRecord('missing')).toBeUndefined();
  });

  it('loadSessionActorIndex surfaces every record keyed by session id', () => {
    writeSessionActorRecord({ sessionId: 'sid-a', actor: 'a@x.io', initiatedBy: 'human', startedAtMs: 1 });
    writeSessionActorRecord({ sessionId: 'sid-b', actor: 'b@x.io', initiatedBy: 'agent', startedAtMs: 2 });
    const idx = loadSessionActorIndex();
    expect(idx.get('sid-a')?.actor).toBe('a@x.io');
    expect(idx.get('sid-b')?.initiatedBy).toBe('agent');
  });

  it('refuses a session id with path separators (no write outside by-session/)', () => {
    // A caller-supplied `--session-id '../../evil'` must not escape the dir via
    // path.join; the write is dropped and the read finds nothing.
    writeSessionActorRecord({ sessionId: '../../evil', actor: 'mallory@x.io', initiatedBy: 'human', startedAtMs: 1 });
    expect(readSessionActorRecord('../../evil')).toBeUndefined();
    const escaped = path.join(TEST_HOME, '.agents', '.history', 'evil.json');
    expect(fs.existsSync(escaped)).toBe(false);
  });
});

/**
 * The DB join is the whole point: a scan builds a SessionMeta with NO actor (the
 * transcript can't carry one), upsertSession reads the sidecar and fills the
 * column — so `agents sessions` attributes historical sessions to a person.
 */
describe('upsertSession joins the actor sidecar (RUSH-2019)', () => {
  beforeAll(() => {
    fs.mkdirSync(FILES, { recursive: true });
    getDB(); // migrate a fresh home
  });
  afterAll(() => {
    closeDB();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  function scanMeta(id: string): SessionMeta {
    const filePath = path.join(FILES, `${id}.jsonl`);
    fs.writeFileSync(filePath, '');
    // No actor field — exactly what the transcript scanner produces.
    return { id, shortId: id.slice(0, 8), agent: 'claude', timestamp: '2026-08-01T10:00:00.000Z', filePath };
  }

  it('fills actor/initiatedBy from the sidecar when the scanned meta has none', () => {
    writeSessionActorRecord({ sessionId: 'joined-1', actor: 'grace@example.com', initiatedBy: 'human', startedAtMs: 1 });
    upsertSession(scanMeta('joined-1'), '');
    const meta = getSessionById('joined-1');
    expect(meta?.actor).toBe('grace@example.com');
    expect(meta?.initiatedBy).toBe('human');
  });

  it('leaves actor null when no sidecar record exists (honest unattributed row)', () => {
    upsertSession(scanMeta('joined-2'), '');
    const meta = getSessionById('joined-2');
    expect(meta?.actor).toBeUndefined();
  });

  it('an explicit meta.actor wins over the sidecar (caller-provided identity)', () => {
    writeSessionActorRecord({ sessionId: 'joined-3', actor: 'sidecar@example.com', initiatedBy: 'human', startedAtMs: 1 });
    const meta = { ...scanMeta('joined-3'), actor: 'explicit@example.com', initiatedBy: 'human' as const };
    upsertSession(meta, '');
    expect(getSessionById('joined-3')?.actor).toBe('explicit@example.com');
  });

  it('the batch scanner path joins the sidecar too (the real discover.ts flow)', () => {
    // upsertSessionsBatch is what every harness scanner in discover.ts calls.
    writeSessionActorRecord({ sessionId: 'batch-1', actor: 'linus@example.com', initiatedBy: 'human', startedAtMs: 1 });
    upsertSessionsBatch([
      { meta: scanMeta('batch-1'), content: '' }, // has a sidecar -> filled
      { meta: scanMeta('batch-2'), content: '' }, // no sidecar -> stays null
    ]);
    expect(getSessionById('batch-1')?.actor).toBe('linus@example.com');
    expect(getSessionById('batch-2')?.actor).toBeUndefined();
  });

  it('a rescan through the batch path does not clobber a stored owner', () => {
    writeSessionActorRecord({ sessionId: 'batch-3', actor: 'grace@example.com', initiatedBy: 'human', startedAtMs: 1 });
    upsertSessionsBatch([{ meta: scanMeta('batch-3'), content: '' }]);
    // Rescan: same id, new content, sidecar removed — the stored owner must persist
    // (ON CONFLICT excludes actor/initiated_by).
    fs.rmSync(path.join(TEST_HOME, '.agents', '.history', 'by-session', 'batch-3.json'), { force: true });
    upsertSessionsBatch([{ meta: { ...scanMeta('batch-3'), topic: 'rescanned' }, content: '' }]);
    const meta = getSessionById('batch-3');
    expect(meta?.topic).toBe('rescanned');
    expect(meta?.actor).toBe('grace@example.com');
  });
});
