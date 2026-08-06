/**
 * Benchmark for the SessionStart-hook state reader (hook-sessions.ts): the
 * two on-disk sources `agents sessions --active` joins a `ps`-discovered pid
 * against on every ~3s poll (active.ts:1490 "The ~3s poll must not re-read
 * the dir ... per candidate") and exec.ts:1953/1708 reads once per
 * `--host`-dispatched non-Claude run --
 *
 *   - loadHookSessionIndex() (hook-sessions.ts:126) -- readdirSync + one
 *     readFileSync+JSON.parse PER FILE over ~/.agents/.cache/terminals/sessions/.
 *   - readStateSessionRecord() (hook-sessions.ts:81) -- ONE targeted
 *     readFileSync+JSON.parse over ~/.agents/.cache/state/sessions/<pid>.json,
 *     never a directory scan (hook-sessions.ts:66-67).
 *   - resolveHookSessionRecord() (hook-sessions.ts:183) -- the pure
 *     launchId -> terminalId -> pid -> childPids priority chain both
 *     exec.ts:1708 and active.ts:1533-1541/1637-1642 run per candidate over
 *     the pre-built index.
 *
 * No mocking of the read path itself -- every bench below calls the real
 * exported functions against real on-disk JSON files with the real
 * HookSessionRecord/state-record shapes. What IS controlled is HOME (state.ts:36
 * captures `process.env.HOME` at module load, so it's set BEFORE the dynamic
 * import below, exactly like pid-registry.bench.ts), because the two real counts
 * on THIS box, measured directly before writing this file
 * (`ls ~/.agents/.cache/terminals/sessions | wc -l` and
 * `ls ~/.agents/.cache/state/sessions | wc -l`, 2026-08-06), are:
 *
 *   - ~/.agents/.cache/terminals/sessions/  ->  0 files
 *   - ~/.agents/.cache/state/sessions/      ->  5021 files
 *
 * which is exactly what the module docblock predicts: the `terminals/sessions/`
 * writer, @agents/session-tracker, "is NOT deployed on the fleet -- its dir is
 * empty there" (hook-sessions.ts:8-9), while `state/sessions/` is "an unpruned
 * graveyard (thousands of dead-pid files)" (hook-sessions.ts:66). Because the
 * real terminals/sessions/ dir is permanently empty in production, benching it
 * unmodified would only prove "readdir on an empty dir is fast" -- not useful.
 * So loadHookSessionIndex() is seeded at pid-registry.bench.ts's SEED_COUNT (60,
 * "an actively-used box") as the stated counterfactual: what the scan would cost
 * if the writer package were ever deployed. readStateSessionRecord() IS seeded at
 * this box's REAL measured count (5021) -- not a guess, the actual current
 * graveyard size -- since that dir already accumulates on every real fleet box.
 *
 * Not wired into `vitest run` (vitest.config.ts:18 includes only `*.test.ts`);
 * run with `npx vitest bench --run` from apps/cli.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, bench } from 'vitest';

// Redirect state.ts's HOME-derived paths to a throwaway dir BEFORE importing the
// module under test (see pid-registry.bench.ts for the same pattern + rationale).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-hooksessbench-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const TERMINALS_SESSIONS_DIR = path.join(TMP, '.agents', '.cache', 'terminals', 'sessions');
const STATE_SESSIONS_DIR = path.join(TMP, '.agents', '.cache', 'state', 'sessions');
fs.mkdirSync(TERMINALS_SESSIONS_DIR, { recursive: true });
fs.mkdirSync(STATE_SESSIONS_DIR, { recursive: true });

const AGENTS = ['claude', 'codex', 'grok', 'kimi', 'droid', 'antigravity'];

// -- terminals/sessions/: counterfactual scale (real fleet count is 0) --
const TERMINALS_SEED_COUNT = 60;
const seededTerminalsPids: number[] = [];
let midLaunchId = '';
for (let i = 0; i < TERMINALS_SEED_COUNT; i++) {
  const pid = 200000 + i;
  seededTerminalsPids.push(pid);
  const launchId = `launch-${i}-${'a'.repeat(8)}`;
  if (i === Math.floor(TERMINALS_SEED_COUNT / 2)) midLaunchId = launchId;
  const record = {
    session_id: `${'1'.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`,
    agent: AGENTS[i % AGENTS.length],
    cwd: `/home/muqsit/src/github.com/muqsitnawaz/repo-${i % 7}`,
    pid,
    launch_id: launchId,
    terminal_id: `%${i}`,
    ts: 1_780_000_000 + i,
  };
  fs.writeFileSync(path.join(TERMINALS_SESSIONS_DIR, `${pid}.json`), JSON.stringify(record), 'utf8');
}

// -- state/sessions/: seeded at THIS box's REAL measured graveyard size --
const STATE_SEED_COUNT = 5021;
const midStatePid = 300000 + Math.floor(STATE_SEED_COUNT / 2);
for (let i = 0; i < STATE_SEED_COUNT; i++) {
  const pid = 300000 + i;
  const record = { session_id: `${'2'.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`, cwd: '/home/muqsit', pid, ts: 1_780_000_000 + i };
  fs.writeFileSync(path.join(STATE_SESSIONS_DIR, `${pid}.json`), JSON.stringify(record), 'utf8');
}

const { loadHookSessionIndex, readStateSessionRecord, resolveHookSessionRecord, resolveHookSessionId } = await import('./hook-sessions.js');

const index = loadHookSessionIndex();
const midTerminalsPid = seededTerminalsPids[Math.floor(TERMINALS_SEED_COUNT / 2)];

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe(`loadHookSessionIndex — terminals/sessions/ scan (hook-sessions.ts:126, ${TERMINALS_SEED_COUNT} seeded files — counterfactual scale; REAL fleet count is 0, writer package not deployed)`, () => {
  bench('readdirSync + read+parse every entry', () => {
    loadHookSessionIndex();
  });
});

describe(`readStateSessionRecord — targeted single-pid read (hook-sessions.ts:81, state/sessions/ seeded at THIS box's REAL measured scale: ${STATE_SEED_COUNT} files)`, () => {
  bench('HIT — pid present, no staleness check', () => {
    readStateSessionRecord(midStatePid);
  });

  bench('HIT — pid present, WITH startedAtMs freshness check (the exec.ts/active.ts call shape)', () => {
    readStateSessionRecord(midStatePid, (1_780_000_000 + Math.floor(STATE_SEED_COUNT / 2)) * 1000);
  });

  bench('MISS — untracked pid (the common case, hook-sessions.ts:90)', () => {
    readStateSessionRecord(999_999_999);
  });
});

describe('resolveHookSessionRecord / resolveHookSessionId — priority-chain Map lookup over the pre-built index (hook-sessions.ts:183,207)', () => {
  bench('direct pid hit (no launchId/terminalId — active.ts:1637 fallback shape)', () => {
    resolveHookSessionRecord(index, { pid: midTerminalsPid, kind: AGENTS[Math.floor(TERMINALS_SEED_COUNT / 2) % AGENTS.length] });
  });

  bench('launchId hit (priority path exec.ts:1708/active.ts:1534 take first)', () => {
    resolveHookSessionId(index, { pid: 0, kind: AGENTS[Math.floor(TERMINALS_SEED_COUNT / 2) % AGENTS.length], launchId: midLaunchId });
  });

  bench('miss — all keys absent (a hookless harness, or the hook hasn\'t landed yet)', () => {
    resolveHookSessionRecord(index, { pid: 1, kind: 'claude' });
  });
});
