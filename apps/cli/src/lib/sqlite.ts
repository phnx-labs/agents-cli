/**
 * Runtime-aware compatibility shim for SQLite.
 *
 * Picks `bun:sqlite` under Bun and `node:sqlite` under Node (>=22.5). Avoids
 * the native `better-sqlite3` addon entirely so there is no prebuild compile
 * and no Node/Bun ABI mismatch when the same source runs in tests (Bun) and
 * production (Node).
 *
 * Exposes the small better-sqlite3-shaped surface area the rest of the
 * codebase already uses: `prepare/exec/pragma/transaction/close` on the DB,
 * `run/get/all` on statements.
 */

import { createRequire } from 'module';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const require = createRequire(import.meta.url);

// Keep Node on createRequire() so Vitest doesn't try to prebundle the built-in
// sqlite module as a userland package during test collection.
const sqliteMod = isBun
  ? await import('bun:sqlite' as string)
  : require('node:sqlite');

// bun:sqlite exports `Database`; node:sqlite exports `DatabaseSync`.
const NativeDatabase: new (filename: string) => NativeDb =
  (sqliteMod as { Database?: unknown; DatabaseSync?: unknown }).Database as never
  ?? (sqliteMod as { DatabaseSync?: unknown }).DatabaseSync as never;

interface NativeStmt {
  run(...args: unknown[]): RunResult;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

interface NativeDb {
  prepare(sql: string): NativeStmt;
  exec(sql: string): void;
  close(): void;
}

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

function bindArgs(params: unknown[]): unknown[] {
  // Both bindings accept positional `(a, b, c)` and named `({ a, b, c })`
  // forms. Pass an object through unchanged so callers using named binds work.
  if (
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === 'object' &&
    !Array.isArray(params[0])
  ) {
    return [params[0]];
  }
  return params;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
class StatementImpl<_T = unknown> {
  constructor(private readonly inner: NativeStmt) {}

  run(...params: unknown[]): RunResult {
    return this.inner.run(...bindArgs(params));
  }

  get(...params: unknown[]): unknown {
    return this.inner.get(...bindArgs(params));
  }

  all(...params: unknown[]): unknown[] {
    return this.inner.all(...bindArgs(params));
  }
}

class Database {
  private readonly inner: NativeDb;

  constructor(filename: string) {
    this.inner = new NativeDatabase(filename);
  }

  prepare<T = unknown>(sql: string): StatementImpl<T> {
    return new StatementImpl<T>(this.inner.prepare(sql));
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  // node:sqlite has no dedicated `pragma()` and bun:sqlite's signature differs
  // slightly from better-sqlite3. `exec('PRAGMA ...')` works on both and is
  // sufficient for the setter pragmas (`journal_mode = WAL`) used here.
  // Reader pragmas in this codebase use `db.prepare(...).all()`.
  pragma(stmt: string): void {
    this.inner.exec(`PRAGMA ${stmt}`);
  }

  // Wrap fn in BEGIN IMMEDIATE/COMMIT, ROLLBACK on throw. Manual on both
  // runtimes because node:sqlite has no `db.transaction(fn)`.
  //
  // BEGIN IMMEDIATE (not BEGIN DEFERRED) is required for write transactions in
  // WAL mode. BEGIN DEFERRED upgrades the lock lazily on the first write; if
  // another writer already committed since the transaction started, SQLite
  // returns SQLITE_BUSY_SNAPSHOT (a sub-code of SQLITE_BUSY that the busy
  // handler does NOT retry). BEGIN IMMEDIATE claims the write lock upfront so
  // the busy handler fires correctly and respects busy_timeout.
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
    return (...args: Args): R => {
      this.inner.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(...args);
        this.inner.exec('COMMIT');
        return result;
      } catch (err) {
        try { this.inner.exec('ROLLBACK'); } catch { /* original error wins */ }
        throw err;
      }
    };
  }

  close(): void {
    this.inner.close();
  }
}

// Declaration merging keeps `Database.Database` / `Database.Statement<T>`
// type references at call sites working without rewrites.
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Database {
  export type Database = InstanceType<typeof DatabaseConstructor>;
  export type Statement<T = unknown> = StatementImpl<T>;
}

const DatabaseConstructor = Database;

export default Database;
