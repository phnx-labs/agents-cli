/**
 * The session index writes its rows with a named-parameter bind
 * (`upsertSessionStmt` in session/db.ts). bun:sqlite only matches such an
 * object when its keys carry the SQL sigil unless the DB is opened with
 * `strict: true` — without it every parameter stays NULL and `sessions.short_id`
 * (NOT NULL) rejects the row, so no session ever reaches the index when the CLI
 * runs as the standalone Bun binary. The suite itself runs under Node, so the
 * bun half has to be exercised in a real `bun` subprocess.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from './sqlite.js';

const SCHEMA = 'CREATE TABLE t (id TEXT PRIMARY KEY, short_id TEXT NOT NULL, count INTEGER)';
const INSERT = 'INSERT INTO t (id, short_id, count) VALUES (@id, @short_id, @count)';

describe('sqlite shim named-parameter binds', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-shim-test-'));
    dbPath = path.join(dir, 'test.db');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('binds bare object keys on the current runtime', () => {
    const db = new Database(dbPath);
    db.exec(SCHEMA);
    db.prepare(INSERT).run({ id: 'sess-1', short_id: 'sess-1'.slice(0, 4), count: 7 });
    expect(db.prepare('SELECT id, short_id, count FROM t').all()).toEqual([
      { id: 'sess-1', short_id: 'sess', count: 7 },
    ]);
    db.close();
  });

  it('binds bare object keys under bun, the runtime the standalone binary embeds', () => {
    const modulePath = path.resolve(process.cwd(), 'src/lib/sqlite.ts');
    const script = `
      import Database from ${JSON.stringify(modulePath)};
      const db = new Database(${JSON.stringify(dbPath)});
      db.exec(${JSON.stringify(SCHEMA)});
      db.prepare(${JSON.stringify(INSERT)}).run({ id: 'sess-1', short_id: 'sess', count: 7 });
      db.close();
    `;
    execFileSync('bun', ['-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });

    // Read back from this (Node) process: the row must exist with real values,
    // not the all-NULL row a silent bind failure would have produced.
    const db = new Database(dbPath);
    expect(db.prepare('SELECT id, short_id, count FROM t').all()).toEqual([
      { id: 'sess-1', short_id: 'sess', count: 7 },
    ]);
    db.close();
  });

  it('still binds positional parameters on the current runtime', () => {
    const db = new Database(dbPath);
    db.exec(SCHEMA);
    db.prepare('INSERT INTO t (id, short_id, count) VALUES (?, ?, ?)').run('sess-2', 'sess', 3);
    expect(db.prepare('SELECT short_id FROM t WHERE id = ?').get('sess-2')).toEqual({ short_id: 'sess' });
    db.close();
  });
});
