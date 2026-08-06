/**
 * Benchmark for the session-index query hot path in db.ts: the listing
 * (`querySessions`, db.ts:2596), the id / short-id lookups (`getSessionById`
 * db.ts:3202, `findSessionsByShortIds` db.ts:3240, `findSessionsById`
 * db.ts:3216), full-text search (`ftsSearch`, db.ts:3308) and the paginator
 * count (`countSessions`, db.ts:2647). These back `agents sessions`
 * (listing/preview), the `--active` scanner's tmux short-id resolution, and the
 * interactive type-ahead search — the frequent operational paths named in the
 * task. (There is no `src/lib/session/index.ts`; db.ts is the session-index
 * query module, so the bench lives beside it.)
 *
 * No mocking, real data. Setup takes a consistent `VACUUM INTO` snapshot of THIS
 * machine's real `~/.agents/.history/sessions/sessions.db` (6,635 sessions /
 * 65,488 tool_calls / 6,633 FTS rows at schema v37 when this was written) into a
 * throwaway temp file, and points db.ts at it via the `AGENTS_SESSIONS_DB` test
 * seam (state.ts:592) set BEFORE the dynamic import so db.ts:29
 * `const DB_PATH = getSessionsDbPath()` captures it. The snapshot is a faithful
 * copy of the real index — every row, real `file_path`s, the real FTS content —
 * so `querySessions`'s existence check (findMissingFilePaths, db.ts:2562) does
 * its REAL `readdirSync` over the ~735 distinct transcript directories those
 * rows point at on this disk. The snapshot (not the live db) is used for two
 * reasons: (1) `querySessions({})` runs a purge WRITE transaction
 * (db.ts:2635 `db.transaction(() => purgeToolCalls(...))`) for every row whose
 * `file_path` has vanished, and 443 of 6,513 local transcripts on this box are
 * already gone, so running it against the live index would delete real
 * tool_call evidence; (2) it avoids WAL contention with the live daemon writer.
 * That 443/6,513-stale state is real and is exactly why the WITH-existence-check
 * listing is the dominant cost measured below.
 *
 * The dominant, measured cost driver in `querySessions` is the existence check,
 * not the SQL: the same query with `skipExistenceCheck: true` (db.ts:2622,
 * the warm-cache path the picker's small result sets use) skips
 * findMissingFilePaths entirely, and the delta between the two `full listing`
 * benches below is the ~735-directory `readdirSync` sweep plus the stale-row
 * purge transaction. Every uncached `db.prepare(sql)` in these functions
 * re-compiles its statement each call — db.ts builds the SQL string dynamically
 * (db.ts:2620) and never caches the compiled statement, so `getSessionById`
 * (a fixed `SELECT * FROM sessions WHERE id = ?`, db.ts:3204) re-prepares on
 * every lookup; that is isolated by the id-lookup group.
 *
 * This file is NOT wired into `vitest run` — vitest.config.ts:11 includes only
 * `*.test.ts`, so a `*.bench.ts` adds no CI assertion or flakiness; run it
 * explicitly with `npx vitest bench --run` from apps/cli.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, bench } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { getSessionsDbPath } from '../state.js';

// Snapshot the REAL index into a throwaway file and point db.ts at it BEFORE
// importing db.js, so its module-level DB_PATH capture (db.ts:29) resolves here.
const REAL_DB = path.join(os.homedir(), '.agents', '.history', 'sessions', 'sessions.db');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-dbbench-'));
const SNAPSHOT = path.join(TMP, 'sessions.db');
const haveRealDb = fs.existsSync(REAL_DB) && fs.statSync(REAL_DB).size > 0;
if (haveRealDb) {
  const src = new DatabaseSync(REAL_DB, { readOnly: true });
  // A single transactional snapshot of committed + WAL state into one file.
  src.exec(`VACUUM INTO '${SNAPSHOT.replace(/'/g, "''")}'`);
  src.close();
  process.env.AGENTS_SESSIONS_DB = SNAPSHOT;
}

// Dynamic import so the AGENTS_SESSIONS_DB seam above is set first.
const dbmod = await import('./db.js');
const { querySessions, countSessions, getSessionById, findSessionsById, findSessionsByShortIds, ftsSearch, closeDB } = dbmod;

// Real ids / short-ids pulled from the snapshot for the lookup benches — actual
// rows, not synthesized keys. Reads through the warm skip-existence path so this
// setup itself does no fs sweep.
const sample = haveRealDb ? querySessions({ limit: 40, skipExistenceCheck: true }) : [];
const realId = sample[0]?.id ?? '';
const realShortIds = sample.map((s) => s.shortId).filter((s): s is string => !!s).slice(0, 20);
const realIdPrefix = realId ? realId.slice(0, 8) : '';

afterAll(() => {
  try { closeDB(); } catch { /* already closed */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe.skipIf(!haveRealDb)('querySessions — session listing (agents sessions)', () => {
  // The real operational default: unfiltered fleet listing WITH the existence
  // check (findMissingFilePaths readdir sweep + stale-row purge). Dominant cost.
  bench('full listing, existence check ON (readdir ~735 dirs + purge stale rows)', () => {
    querySessions({});
  });

  // Same SELECT + rowToMeta over the same ~6.6k rows, existence check OFF —
  // isolates the SQL + row mapping from the fs sweep above.
  bench('full listing, skipExistenceCheck (SQL + rowToMeta only, no fs)', () => {
    querySessions({ skipExistenceCheck: true });
  });

  // The interactive picker's real path: newest 15 (PICKER_RECENT_COUNT). The
  // LIMIT over-fetches limit+16 rows (db.ts:2603) so only ~31 rows are existence-
  // checked — the cheap, common case.
  bench('recent 15 (interactive picker path, existence check ON)', () => {
    querySessions({ limit: 15 });
  });

  bench('filtered agent=claude, limit 50', () => {
    querySessions({ agent: 'claude', limit: 50 });
  });

  bench('sortBy=cost, limit 50 (priciest-first, unindexed expression sort)', () => {
    querySessions({ sortBy: 'cost', limit: 50 });
  });
});

describe.skipIf(!haveRealDb)('countSessions — paginator count', () => {
  bench('countSessions({}) — COUNT(*) over the whole index', () => {
    countSessions({});
  });
});

describe.skipIf(!haveRealDb)('id / short-id lookup (pid->session context, tmux scan resolution)', () => {
  bench('getSessionById — indexed PK lookup, re-prepares each call (db.ts:3204)', () => {
    getSessionById(realId);
  });

  bench('findSessionsById — exact-first-then-prefix (db.ts:3216)', () => {
    findSessionsById(realIdPrefix);
  });

  bench('findSessionsByShortIds — batch 20 short ids in one IN query (tmux scan, db.ts:3240)', () => {
    findSessionsByShortIds(realShortIds);
  });
});

describe.skipIf(!haveRealDb)('ftsSearch — interactive full-text + label search', () => {
  bench('ftsSearch("rush") — multi-term content + label tiers', () => {
    ftsSearch('rush');
  });

  bench('ftsSearch("a") — single-char label type-ahead (FTS label column)', () => {
    ftsSearch('a');
  });

  bench('ftsSearch("session index perf") — 3-term OR query', () => {
    ftsSearch('session index perf');
  });
});
