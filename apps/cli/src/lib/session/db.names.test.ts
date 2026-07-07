import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB under a temp HOME before db.js/state.js capture the
// path at import time.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-dbnames-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, seedLabelsFromNames, syncLabels, ftsSearch, getSessionById } =
  await import('./db.js');
type SessionMeta = import('./types.js').SessionMeta;

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date().toISOString(),
    filePath: '',
    ...extra,
  };
}

describe('--name seeds the unified session label', () => {
  it('resolves `agents sessions <name>` to the run, exact match ranked top', () => {
    upsertSession(meta('run-alpha'), '');
    upsertSession(meta('run-beta'), '');
    // `--name` seeds the label by id — the same idempotent, re-applied-every-scan
    // path used in discovery (seedLabelsFromNames), keyed off the run-name sidecars.
    seedLabelsFromNames(new Map([['run-alpha', 'fix-bug'], ['run-beta', 'other']]));

    const hits = ftsSearch('fix-bug');
    expect(hits[0]?.sessionId).toBe('run-alpha');
    expect(hits[0]?.score).toBe(1_000_000);
    // The seed lands on the single `label` field, readable back — no separate `name`.
    expect(getSessionById('run-alpha')?.label).toBe('fix-bug');
  });

  it('matches a seeded name by prefix below an exact match', () => {
    upsertSession(meta('run-gamma'), '');
    seedLabelsFromNames(new Map([['run-gamma', 'nightly-audit']]));
    const hits = ftsSearch('nightly');
    const hit = hits.find(h => h.sessionId === 'run-gamma');
    expect(hit?.score).toBe(900_000);
  });

  it('an agent-generated title WINS over the --name seed (refine beats seed)', () => {
    upsertSession(meta('run-refine'), '');
    // Discovery order: the per-agent scan applies the generated title first...
    syncLabels(new Map([['run-refine', 'Real generated title']]));
    // ...then the seed pass runs — and must NOT clobber the real title.
    seedLabelsFromNames(new Map([['run-refine', 'my-seed']]));
    expect(getSessionById('run-refine')?.label).toBe('Real generated title');
    // The refined title resolves; the superseded seed no longer does.
    expect(ftsSearch('Real generated title')[0]?.sessionId).toBe('run-refine');
    expect(ftsSearch('my-seed').some(h => h.score >= 800_000)).toBe(false);
  });

  it('the seed shows until a title exists, and re-applies across a bare rescan', () => {
    upsertSession(meta('run-persist'), '');
    seedLabelsFromNames(new Map([['run-persist', 'keep-me']]));
    expect(getSessionById('run-persist')?.label).toBe('keep-me');
    // A bare rescan re-upserts with no label (label = excluded.label clears it)...
    upsertSession(meta('run-persist'), 'rescanned preview');
    // ...and the seed pass restores it every scan, so the handle stays resolvable.
    seedLabelsFromNames(new Map([['run-persist', 'keep-me']]));
    expect(getSessionById('run-persist')?.label).toBe('keep-me');
    expect(ftsSearch('keep-me')[0]?.sessionId).toBe('run-persist');
  });

  it('leaves unnamed runs resolvable by id only (no spurious handle match)', () => {
    upsertSession(meta('run-plain'), '');
    expect(getSessionById('run-plain')?.label).toBeUndefined();
    expect(ftsSearch('run-plain').some(h => h.score >= 800_000)).toBe(false);
  });
});
