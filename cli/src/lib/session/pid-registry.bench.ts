/**
 * Benchmark for the per-pid session registry read path (pid-registry.ts): the
 * pid->session lookup the headless `agents sessions --active` scanner uses to
 * attribute a `ps`-discovered agent process to its exact launch session
 * (pid-registry.ts docblock). `readPidSessionEntry` (pid-registry.ts:111) is one
 * file read + JSON.parse; `listPidSessionEntries` (pid-registry.ts:136) is a
 * `readdirSync` + a `readFileSync`+`JSON.parse` PER entry, called once per
 * active-sessions scan to index every recorded launch by tmuxPane.
 *
 * No mocking, realistic input. Setup points state.ts at a throwaway temp HOME
 * (state.ts:36 captures `process.env.HOME` at module load, so HOME is set BEFORE
 * the dynamic import) and seeds `~/.agents/.cache/terminals/by-pid/` (state.ts:146)
 * with SEED_COUNT real-shaped PidSessionEntry files — a busy fleet box
 * accumulates one per tracked `ag run` launch until dead pids are pruned. The
 * functions then do their real per-file readdir + read + parse over that
 * directory; nothing is stubbed. SEED_COUNT is the realistic-input knob, called
 * out here rather than hidden: 60 tracked launches models an actively-used box.
 *
 * Not wired into `vitest run` (vitest.config.ts:11 includes only `*.test.ts`);
 * run with `npx vitest bench --run` from cli.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, bench } from 'vitest';

const SEED_COUNT = 60;

// Redirect state.ts's HOME-derived paths to a throwaway dir BEFORE importing the
// module under test, then seed a realistic by-pid registry.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-pidbench-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const BY_PID = path.join(TMP, '.agents', '.cache', 'terminals', 'by-pid');
fs.mkdirSync(BY_PID, { recursive: true });
const AGENTS = ['claude', 'codex', 'grok', 'kimi', 'droid', 'antigravity'];
const seededPids: number[] = [];
for (let i = 0; i < SEED_COUNT; i++) {
  const pid = 100000 + i;
  seededPids.push(pid);
  const entry = {
    pid,
    agent: AGENTS[i % AGENTS.length],
    sessionId: `${'0'.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`,
    cwd: `/home/muqsit/src/github.com/muqsitnawaz/repo-${i % 7}`,
    actor: 'muqsit@zion',
    initiatedBy: i % 3 === 0 ? 'agent' : 'human',
    launchId: `launch-${i}-${'a'.repeat(8)}`,
    tmuxPane: `%${i}`,
    startedAtMs: 1_750_000_000_000 + i * 1000,
  };
  fs.writeFileSync(path.join(BY_PID, `${pid}.json`), JSON.stringify(entry), 'utf8');
}

const { readPidSessionEntry, listPidSessionEntries } = await import('./pid-registry.js');
const midPid = seededPids[Math.floor(SEED_COUNT / 2)];

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe(`pid-registry read path (${SEED_COUNT} seeded launches)`, () => {
  bench('readPidSessionEntry — single pid read + parse (pid-registry.ts:111)', () => {
    readPidSessionEntry(midPid);
  });

  bench('listPidSessionEntries — readdir + read + parse every entry (pid-registry.ts:136)', () => {
    listPidSessionEntries();
  });
});
