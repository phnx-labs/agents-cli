import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from '../sqlite.js';
import { closeUsageDb, recordUsage } from './usage-db.js';
import { buildTrendsDashboard } from './dashboard.js';
import { recipeHarnessMix, recipeToolsPerSession, trendsWindow } from './recipes.js';

const tmpDirs: string[] = [];
let prevNoTrack: string | undefined;
let prevUsageDb: string | undefined;
let prevSessionsDb: string | undefined;

function pin(): { usage: string; sessions: string } {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-trends-dash-'));
  tmpDirs.push(d);
  const usage = path.join(d, 'usage.db');
  const sessions = path.join(d, 'sessions.db');
  process.env.AGENTS_USAGE_DB = usage;
  process.env.AGENTS_SESSIONS_DB = sessions;
  const db = new Database(sessions);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      short_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      model TEXT,
      token_count INTEGER,
      output_tokens INTEGER,
      duration_ms INTEGER,
      machine TEXT,
      tool_call_count INTEGER,
      file_path TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO sessions (id, short_id, agent, timestamp, model, token_count, output_tokens, duration_ms, machine, tool_call_count, file_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run('s1', 's1', 'claude', now, 'claude-opus-4', 1000, 200, 60000, 'box-a', 12, '/tmp/a.jsonl');
  insert.run('s2', 's2', 'claude', now, 'claude-sonnet-4', 800, 100, 30000, 'box-a', 4, '/tmp/b.jsonl');
  insert.run('s3', 's3', 'codex', now, 'gpt-5', 500, 50, 120000, 'box-b', null, '/tmp/c.jsonl');
  db.close();
  return { usage, sessions };
}

beforeEach(() => {
  prevNoTrack = process.env.AGENTS_NO_USAGE_TRACK;
  prevUsageDb = process.env.AGENTS_USAGE_DB;
  prevSessionsDb = process.env.AGENTS_SESSIONS_DB;
  delete process.env.AGENTS_NO_USAGE_TRACK;
  closeUsageDb();
  pin();
});

afterEach(() => {
  closeUsageDb();
  if (prevNoTrack === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
  else process.env.AGENTS_NO_USAGE_TRACK = prevNoTrack;
  if (prevUsageDb === undefined) delete process.env.AGENTS_USAGE_DB;
  else process.env.AGENTS_USAGE_DB = prevUsageDb;
  if (prevSessionsDb === undefined) delete process.env.AGENTS_SESSIONS_DB;
  else process.env.AGENTS_SESSIONS_DB = prevSessionsDb;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tmpDirs.length = 0;
});

describe('trends recipes + dashboard', () => {
  it('harness-mix and tools-per-session read the sessions index', () => {
    const win = trendsWindow(7);
    const harness = recipeHarnessMix(win);
    expect(harness.empty).toBe(false);
    expect(harness.rows.some((r) => r.harness === 'claude' && r.sessions === 2)).toBe(true);
    expect(harness.rows.some((r) => r.harness === 'codex' && r.sessions === 1)).toBe(true);

    const tools = recipeToolsPerSession(win);
    expect(tools.empty).toBe(false);
    const all = tools.rows.find((r) => r.scope === '(all)');
    expect(all?.n).toBe(2);
    expect(all?.avg).toBe(8);
  });

  it('dashboard skips empty recipes and stays under the compute budget', () => {
    recordUsage({ kind: 'secret', name: 'npm', event: 'access' });
    const samples: number[] = [];
    for (let i = 0; i < 25; i++) {
      const dash = buildTrendsDashboard({ days: 7 });
      samples.push(dash.durationMs);
      expect(dash.sections.length).toBeGreaterThan(0);
      expect(dash.sections.every((s) => !s.empty)).toBe(true);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p99 = samples[Math.floor(samples.length * 0.99)];
    expect(p50).toBeLessThan(50);
    expect(p99).toBeLessThan(150);
  });
});
