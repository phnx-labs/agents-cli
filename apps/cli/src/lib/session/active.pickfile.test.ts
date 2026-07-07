import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pickSessionFile } from './active.js';

// Regression for the "every co-located session shows the same preview" bug: when a
// concrete session id was requested but its transcript file was absent,
// findClaudeSessionFile fell through to the NEWEST .jsonl in the cwd, so N distinct
// sessions collapsed onto one file's preview + topic (they looked like duplicate
// cards). A supplied-but-missing id must resolve to undefined, never a sibling.

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickfile-'));
  fs.writeFileSync(path.join(dir, 'a.jsonl'), '{"a":1}\n');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), '{"b":1}\n');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, 'a.jsonl'), old, old); // make `b` the mtime winner
});

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('pickSessionFile', () => {
  it('a concrete id returns its own file', () => {
    expect(pickSessionFile(dir, 'a')).toBe(path.join(dir, 'a.jsonl'));
    expect(pickSessionFile(dir, 'b')).toBe(path.join(dir, 'b.jsonl'));
  });

  it('a supplied-but-missing id returns undefined — NOT the newest sibling', () => {
    // The fix: pre-fix this returned b.jsonl (the newest), so every co-located
    // session with an unresolved id shared b.jsonl's preview + topic.
    expect(pickSessionFile(dir, 'does-not-exist')).toBeUndefined();
  });

  it('two distinct missing ids do NOT collapse onto the same file', () => {
    expect(pickSessionFile(dir, 'ghost-1')).toBeUndefined();
    expect(pickSessionFile(dir, 'ghost-2')).toBeUndefined();
  });

  it('no id falls back to the newest file (legitimate single-session heuristic)', () => {
    expect(pickSessionFile(dir, undefined)).toBe(path.join(dir, 'b.jsonl'));
  });

  it('an unreadable project dir returns undefined', () => {
    expect(pickSessionFile(path.join(dir, 'nope'), undefined)).toBeUndefined();
  });
});
