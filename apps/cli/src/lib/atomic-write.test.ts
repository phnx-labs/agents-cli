/**
 * RUSH-2840: `atomicWriteJson` was duplicated four times across
 * feed/registry/team modules and had already started to drift. These tests
 * pin the consolidated behavior against the real filesystem (no mocking) and
 * are deliberately discriminating: they fail against a naive, non-atomic
 * `writeFile(target, ...)` implementation. See the mutation proof in the PR
 * description for a verified failing run against that mutant.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteJson } from './atomic-write.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
}

describe('atomicWriteJson()', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('creates the parent directory when missing', async () => {
    const base = tmpBase();
    dirs.push(base);
    const target = path.join(base, 'nested', 'dir', 'file.json');

    await atomicWriteJson(target, { a: 1 });

    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ a: 1 });
  });

  it('leaves no stray tmp file behind on a normal, uninterrupted write', async () => {
    const base = tmpBase();
    dirs.push(base);
    const target = path.join(base, 'file.json');

    await atomicWriteJson(target, { v: 1 });

    expect(fs.readdirSync(base)).toEqual(['file.json']);
  });

  // Only a NEW-file create can be blocked by directory permissions; renaming
  // over an already-existing file's directory entry is not (the rename
  // itself doesn't need write access inside the file, only in the dir — but
  // making the tmp file impossible to CREATE blocks the write before rename
  // is ever reached, which is what this test exploits). chmod is a no-op on
  // Windows and root bypasses the permission check entirely, so this test is
  // skipped where the mechanism cannot hold.
  const canBlockFileCreate =
    process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
  const itBlocksCreate = canBlockFileCreate ? it : it.skip;

  itBlocksCreate(
    'a write that fails leaves the destination with its previous valid content, and no tmp file behind',
    async () => {
      const base = tmpBase();
      dirs.push(base);
      const target = path.join(base, 'registry.json');

      await atomicWriteJson(target, { version: 1 });
      const before = fs.readFileSync(target, 'utf-8');
      expect(JSON.parse(before)).toEqual({ version: 1 });

      // Block creation of the sibling tmp file by making the directory
      // read-only. This drives the REAL writer into a failure at its very
      // first fs call (the tmp-file create) instead of planting a decoy file
      // it never touches — a bare `writeFile(target, ...)` would still
      // SUCCEED here, since `target` already exists and stays writable. That
      // asymmetry is what makes this test discriminating against a
      // non-atomic mutant.
      fs.chmodSync(base, 0o555);
      try {
        await expect(atomicWriteJson(target, { version: 2 })).rejects.toThrow();

        const after = fs.readFileSync(target, 'utf-8');
        expect(after).toBe(before);
        expect(JSON.parse(after)).toEqual({ version: 1 });
      } finally {
        fs.chmodSync(base, 0o755);
      }

      expect(fs.readdirSync(base)).toEqual(['registry.json']);
    },
  );
});
