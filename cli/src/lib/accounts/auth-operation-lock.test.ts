import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { acquireAuthOperationLock, authLockFilePath } from './auth-operation-lock.js';

const require = createRequire(import.meta.url);
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-operation-lock-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('native authentication exclusion', () => {
  it('refuses overlapping operations, then permits retry', () => {
    const first = acquireAuthOperationLock('codex', root);
    try {
      expect(() => acquireAuthOperationLock('codex', root)).toThrow(/in progress/);
      acquireAuthOperationLock('claude', root).release();
    } finally { first.release(); }
    first.release();
    acquireAuthOperationLock('codex', root).release();
  });

  it('excludes a real competing process without relying on in-memory state', () => {
    const first = acquireAuthOperationLock('codex', root);
    try {
      const output = execFileSync(process.execPath, ['-e',
        'const lock = require(process.argv[1]); try { lock.lockSync(process.argv[2])(); process.exit(2); } catch (e) { if (e.code !== "ELOCKED") throw e; console.log("excluded"); }',
        require.resolve('proper-lockfile'), authLockFilePath('codex', root)], { encoding: 'utf8' });
      expect(output.trim()).toBe('excluded');
    } finally { first.release(); }
  });

  it('fails closed when the lock target cannot be created', () => {
    const blocker = path.join(root, 'not-a-directory');
    fs.writeFileSync(blocker, 'owned data');
    expect(() => acquireAuthOperationLock('codex', blocker)).toThrow();
    expect(fs.readFileSync(blocker, 'utf8')).toBe('owned data');
  });

  it('does not take over an unreadable or foreign lock directory', () => {
    const target = authLockFilePath('codex', root);
    fs.writeFileSync(target, '{}');
    fs.mkdirSync(`${target}.lock`);
    fs.writeFileSync(path.join(`${target}.lock`, 'foreign'), 'preserve');
    expect(() => acquireAuthOperationLock('codex', root)).toThrow(/in progress/);
    expect(fs.readFileSync(path.join(`${target}.lock`, 'foreign'), 'utf8')).toBe('preserve');
  });
});
