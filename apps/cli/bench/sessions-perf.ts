#!/usr/bin/env tsx
// Benchmark harness for the sessions indexing pipeline.
//
// Measures:
//   A. Cold discover (index files removed before the run)
//   B. Warm discover (index files present from a prior run)
//   C. Picker keystroke (filterSessionsByQuery) — single call
//   D. Picker keystroke — 10 successive queries (simulates typing)
//   E. loadBM25Index alone (the per-keystroke bottleneck)
//
// Output: JSON on stdout. Intended to be run before and after the refactor
// so the numbers can be diffed directly.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { discoverSessions, searchContentIndex } from '../src/lib/session/discover.js';
import { filterSessionsByQuery } from '../src/commands/sessions.js';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.agents', 'sessions');
const INDEX_PATH = path.join(SESSIONS_DIR, 'index.jsonl');
const CONTENT_INDEX_PATH = path.join(SESSIONS_DIR, 'content_index.jsonl');
const DB_PATH = path.join(SESSIONS_DIR, 'sessions.db');

const QUERIES = [
  'rush',
  'rush deploy',
  'group chat bill',
  'session search',
  'sqlite',
  'benchmark',
  'openclaw',
  'phoenix cli',
  'deploy a2a endpoint',
  'yaml agent',
];

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

async function main() {
  const mode = (process.env.BENCH_MODE || 'full').toLowerCase();

  const pre = {
    indexJsonlBytes: fileSize(INDEX_PATH),
    contentIndexJsonlBytes: fileSize(CONTENT_INDEX_PATH),
    sessionsDbBytes: fileSize(DB_PATH),
  };

  // ------------------------------------------------------------------
  // A. Cold discover
  // ------------------------------------------------------------------
  if (mode === 'full' || mode === 'cold') {
    // Backup and remove existing indexes (JSONL + SQLite + WAL/SHM) to simulate first-run cost.
    const COLD_PATHS = [
      INDEX_PATH,
      CONTENT_INDEX_PATH,
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
    indexJsonlBytes: fileSize(INDEX_PATH),
    contentIndexJsonlBytes: fileSize(CONTENT_INDEX_PATH),
    sessionsDbBytes: fileSize(DB_PATH),
  };

  const result = {
    node: process.version,
    timestamp: new Date().toISOString(),
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
