#!/usr/bin/env tsx
// Benchmark harness for the sessions indexing pipeline.
//
// Measures:
//   A. Cold discover (index removed before the run)
//   B. Warm discover (index present from a prior run)
//   C. Picker keystroke (filterSessionsByQuery) — single call
//   D. Picker keystroke — 10 successive queries (simulates typing)
//   E. searchContentIndex alone (the per-keystroke bottleneck)
//
// Corpus: the index is whatever $HOME holds, so CI's `HOME="$(mktemp -d)"` run
// measures an EMPTY index — a floor for A/B, not a real-world number. Set
// BENCH_CORPUS=real (with BENCH_MODE=warm) to copy this machine's live index
// into a throwaway HOME and measure B/C/D/E against a populated one.
//
// Output: JSON on stdout. Intended to be run before and after the refactor
// so the numbers can be diffed directly.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { discoverSessions, searchContentIndex } from '../src/lib/session/discover.js';
import { filterSessionsByQuery } from '../src/commands/sessions.js';
import { getSessionsDbPath, getSessionsDir } from '../src/lib/state.js';

// Resolved through the same helpers the CLI itself uses. Re-deriving the path
// here is what let this benchmark drift onto a directory that no longer exists.
const SESSIONS_DIR = getSessionsDir();
const DB_PATH = getSessionsDbPath();

async function time<T>(fn: () => Promise<T> | T): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  return { ms, value };
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function removeIfExists(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // not there
  }
}

// BENCH_CORPUS=real: copy this machine's live index into a throwaway HOME and
// re-run there. Copying rather than measuring in place is what keeps discover's
// writes off the index `agents sessions` is serving.
function relaunchAgainstRealCorpusCopy(): never {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`BENCH_CORPUS=real: no index at ${DB_PATH} — run \`agents sessions\` once to build one.`);
    process.exit(1);
  }
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-perf-'));
  const destDir = path.join(tmpHome, '.agents', '.history', 'sessions');
  fs.mkdirSync(path.dirname(destDir), { recursive: true });

  console.error(`copying ${(fileSize(DB_PATH) / 1e6).toFixed(0)}MB index -> ${destDir}`);
  const copyStart = performance.now();
  fs.cpSync(SESSIONS_DIR, destDir, { recursive: true });
  console.error(`copied in ${((performance.now() - copyStart) / 1000).toFixed(1)}s`);

  let status: number;
  try {
    const child = spawnSync(process.execPath, [process.argv[1]], {
      stdio: 'inherit',
      env: { ...process.env, HOME: tmpHome, BENCH_CORPUS: 'copied' },
    });
    status = child.status ?? 1;
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
  process.exit(status);
}

async function main() {
  const mode = (process.env.BENCH_MODE || 'full').toLowerCase();

  if (process.env.BENCH_CORPUS === 'real') {
    if (mode !== 'warm') {
      console.error(
        'BENCH_CORPUS=real supports BENCH_MODE=warm only. Cold mode rebuilds the index by ' +
          'rescanning transcripts, which a copied index does not carry — measure first-run ' +
          'cost against the default corpus instead.',
      );
      process.exit(1);
    }
    relaunchAgainstRealCorpusCopy();
  }

  const pre = {
    sessionsDbBytes: fileSize(DB_PATH),
    walBytes: fileSize(DB_PATH + '-wal'),
  };

  // ------------------------------------------------------------------
  // A. Cold discover
  // ------------------------------------------------------------------
  if (mode === 'full' || mode === 'cold') {
    // Backup and remove the existing index (SQLite + WAL/SHM) to simulate first-run cost.
    const COLD_PATHS = [
      DB_PATH,
      DB_PATH + '-wal',
      DB_PATH + '-shm',
    ];
    const backup = COLD_PATHS
      .filter(p => fs.existsSync(p))
      .map(p => ({ src: p, bak: p + '.benchbak' }));
    for (const { src, bak } of backup) fs.renameSync(src, bak);

    try {
      const cold = await time(() =>
        discoverSessions({ all: true, cwd: process.cwd(), limit: 5000 }),
      );
      const sessionsCount = (cold.value as any[]).length;

      // Restore originals (discover wrote fresh indexes during the run — keep those)
      // so the warm run below uses real state, not the fresh-from-scan output.
      for (const { src, bak } of backup) {
        if (fs.existsSync(src)) removeIfExists(bak);
        else if (fs.existsSync(bak)) fs.renameSync(bak, src);
      }

      console.error(`A. cold discover: ${cold.ms.toFixed(0)}ms, ${sessionsCount} sessions`);
      (globalThis as any).__A = { ms: cold.ms, sessionsCount };
    } finally {
      // safety net: restore any leftover .benchbak files if the run crashed
      for (const { src, bak } of backup) {
        if (!fs.existsSync(src) && fs.existsSync(bak)) fs.renameSync(bak, src);
      }
    }
  }

  // ------------------------------------------------------------------
  // B. Warm discover — runs with the index freshly populated from A
  // ------------------------------------------------------------------
  const warmRuns: number[] = [];
  let warmSessions: any[] = [];
  for (let i = 0; i < 3; i++) {
    const warm = await time(() =>
      discoverSessions({ all: true, cwd: process.cwd(), limit: 5000 }),
    );
    warmRuns.push(warm.ms);
    warmSessions = warm.value as any[];
  }
  const warmMs = Math.min(...warmRuns);
  console.error(`B. warm discover (best of 3): ${warmMs.toFixed(0)}ms, ${warmSessions.length} sessions`);

  // ------------------------------------------------------------------
  // C. Single keystroke (filterSessionsByQuery) — using already-loaded sessions
  // ------------------------------------------------------------------
  const singleQuery = 'rush deploy';
  const singleKey = await time(() => filterSessionsByQuery(warmSessions, singleQuery));
  console.error(`C. single keystroke ("${singleQuery}"): ${singleKey.ms.toFixed(1)}ms, ${singleKey.value.length} matches`);

  // ------------------------------------------------------------------
  // D. 10 successive keystrokes (simulates typing a query char by char)
  // ------------------------------------------------------------------
  const typingQueries = [
    'r', 'ru', 'rus', 'rush', 'rush ',
    'rush d', 'rush de', 'rush dep', 'rush depl', 'rush deploy',
  ];
  const perKey: number[] = [];
  let lastMatches = 0;
  for (const q of typingQueries) {
    const r = await time(() => filterSessionsByQuery(warmSessions, q));
    perKey.push(r.ms);
    lastMatches = r.value.length;
  }
  const typingTotal = perKey.reduce((a, b) => a + b, 0);
  const typingAvg = typingTotal / perKey.length;
  console.error(
    `D. 10 successive keystrokes: total ${typingTotal.toFixed(0)}ms, avg ${typingAvg.toFixed(1)}ms/key, final matches ${lastMatches}`,
  );

  // ------------------------------------------------------------------
  // E. searchContentIndex alone (the heaviest component of D)
  // ------------------------------------------------------------------
  const contentRuns: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await time(() => searchContentIndex(warmSessions, 'rush deploy yaml'));
    contentRuns.push(r.ms);
  }
  const contentBest = Math.min(...contentRuns);
  console.error(`E. searchContentIndex best of 5: ${contentBest.toFixed(1)}ms`);

  const post = {
    sessionsDbBytes: fileSize(DB_PATH),
    walBytes: fileSize(DB_PATH + '-wal'),
  };

  const result = {
    node: process.version,
    timestamp: new Date().toISOString(),
    corpus: process.env.BENCH_CORPUS === 'copied' ? 'real (copied)' : 'whatever $HOME holds',
    sessionsDbPath: DB_PATH,
    sessionsCount: warmSessions.length,
    pre,
    post,
    A_coldDiscoverMs: (globalThis as any).__A?.ms,
    B_warmDiscoverMs: warmMs,
    B_warmDiscoverAllRunsMs: warmRuns,
    C_singleKeystrokeMs: singleKey.ms,
    C_singleKeystrokeMatches: singleKey.value.length,
    D_typingTotalMs: typingTotal,
    D_typingAvgMsPerKey: typingAvg,
    D_typingPerKeyMs: perKey,
    E_searchContentBestMs: contentBest,
    E_searchContentAllRunsMs: contentRuns,
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
