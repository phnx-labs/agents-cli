/**
 * Real SQLite warehouse under a temp dir — no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  _resetPerfDbForTest,
  aggregateSamples,
  drainSpool,
  percentile,
  recordSample,
  shortSessionId,
} from './db.js';

describe('perf/db', () => {
  let tmp: string;
  let dbPath: string;
  let spoolPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-db-'));
    dbPath = path.join(tmp, 'perf.db');
    spoolPath = path.join(tmp, 'spool.jsonl');
    process.env.AGENTS_PERF_DB = dbPath;
    process.env.AGENTS_PERF_SPOOL = spoolPath;
    delete process.env.AGENTS_DISABLE_PERF;
    _resetPerfDbForTest(dbPath);
  });

  afterEach(() => {
    _resetPerfDbForTest(null);
    delete process.env.AGENTS_PERF_DB;
    delete process.env.AGENTS_PERF_SPOOL;
    delete process.env.AGENTS_DISABLE_PERF;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('shortSessionId strips session_ prefix and keeps 8 chars', () => {
    expect(shortSessionId('session_087bf3be-64f7-4bbc')).toBe('087bf3be');
    expect(shortSessionId('b0b06be0-c484-4db4-8031')).toBe('b0b06be0');
    expect(shortSessionId(undefined)).toBeUndefined();
  });

  it('percentile is linear and bounds-safe', () => {
    expect(percentile([1], 50)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10, 20, 30, 40, 50], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40, 50], 100)).toBe(50);
  });

  it('recordSample + aggregateSamples returns p50/p99 by kind+label', () => {
    const base = Date.now();
    for (const ms of [10, 20, 30, 40, 100]) {
      recordSample({
        tsMs: base,
        kind: 'hook.fire',
        label: 'inject-repo-inflight',
        durationMs: ms,
        sessionId: 'b0b06be0-c484-4db4-8031-1cf89563e6e1',
        agent: 'claude',
        machine: 'yosemite-s1',
        cache: ms === 10 ? 'hit' : 'miss',
      });
    }
    recordSample({
      tsMs: base,
      kind: 'command.end',
      label: 'sessions focus',
      durationMs: 5,
      agent: 'claude',
    });

    const hooks = aggregateSamples({ days: 1, kinds: ['hook.fire'] });
    expect(hooks).toHaveLength(1);
    expect(hooks[0].label).toBe('inject-repo-inflight');
    expect(hooks[0].n).toBe(5);
    expect(hooks[0].p50Ms).toBe(30);
    expect(hooks[0].maxMs).toBe(100);
    expect(hooks[0].cacheHitPct).toBe(20);
    expect(hooks[0].cacheMissPct).toBe(80);

    const cmds = aggregateSamples({ days: 1, kinds: ['command.end'] });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].label).toBe('sessions focus');
    expect(cmds[0].n).toBe(1);
  });

  it('drainSpool ingests bash-shaped NDJSON and empties the spool', () => {
    const line = JSON.stringify({
      ts_ms: Date.now(),
      kind: 'hook.fire',
      label: 'session-identity',
      duration_ms: 18,
      cache: 'none',
      exit_code: 0,
      machine: 'zion',
      hostname: 'zion.local',
    });
    fs.writeFileSync(spoolPath, line + '\n');
    const n = drainSpool();
    expect(n).toBe(1);
    expect(fs.readFileSync(spoolPath, 'utf-8')).toBe('');

    const rows = aggregateSamples({ days: 1, kinds: ['hook.fire'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('session-identity');
    expect(rows[0].meanMs).toBe(18);
  });

  it('AGENTS_DISABLE_PERF silences writes', () => {
    process.env.AGENTS_DISABLE_PERF = '1';
    _resetPerfDbForTest(dbPath);
    recordSample({ kind: 'hook.fire', label: 'x', durationMs: 1 });
    process.env.AGENTS_DISABLE_PERF = '0';
    _resetPerfDbForTest(dbPath);
    // re-enable and confirm empty
    delete process.env.AGENTS_DISABLE_PERF;
    _resetPerfDbForTest(dbPath);
    expect(aggregateSamples({ days: 1 })).toHaveLength(0);
  });

  it('fail-soft: empty label is ignored', () => {
    recordSample({ kind: 'hook.fire', label: '', durationMs: 10 });
    expect(aggregateSamples({ days: 1 })).toHaveLength(0);
  });
});
