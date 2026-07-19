import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set HOME (and AGENTS_REAL_HOME) before db.js / fork.js load so their
// module-level base dirs resolve inside an isolated temp HOME. Running
// in-process under vitest uses the same node:sqlite driver as the real CLI
// (a `bun --eval` subprocess would use bun:sqlite, which binds differently).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-test-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_REAL_HOME = TEST_HOME;

const { forkSession } = await import('../fork.js');
const { closeDB, getSessionById } = await import('../db.js');
type SessionMeta = import('../types.js').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

/** Write a Claude transcript under TEST_HOME and return its metadata. `tag`
 *  is an 8-char prefix so the derived shortId is predictable. */
function makeSource(tag: string): SessionMeta {
  const id = `${tag}-2222-3333-4444-555555555555`;
  const proj = path.join(TEST_HOME, '.claude', 'projects', '-tmp-x');
  fs.mkdirSync(proj, { recursive: true });
  const filePath = path.join(proj, `${id}.jsonl`);
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: 'user', sessionId: id, cwd: '/tmp/x', message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] } }),
    JSON.stringify({ type: 'assistant', sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
  ].join('\n'));
  return {
    id, shortId: id.slice(0, 8), agent: 'claude',
    timestamp: '2026-01-01T00:00:00.000Z', filePath, cwd: '/tmp/x',
  };
}

describe('forkSession', () => {
  it('copies the transcript under a new id, leaves the original untouched, and registers the fork', () => {
    const source = makeSource('aaaaaaaa');
    const res = forkSession(source, { now: '2026-07-18T00:00:00.000Z' });

    const origAfter = fs.readFileSync(source.filePath, 'utf-8');
    const forkContent = fs.readFileSync(res.filePath, 'utf-8');

    // New file, named by the new id, beside the original.
    expect(fs.existsSync(res.filePath)).toBe(true);
    expect(path.basename(res.filePath)).toBe(`${res.newId}.jsonl`);
    expect(path.dirname(res.filePath)).toBe(path.dirname(source.filePath));

    // Original untouched.
    expect(origAfter).toContain('hello world');
    expect(origAfter).toContain(source.id);
    expect(origAfter).not.toContain(res.newId);

    // Fork is a copy with the embedded id rewritten.
    expect(forkContent).toContain('hello world');
    expect(forkContent).toContain(res.newId);
    expect(forkContent).not.toContain(source.id);

    // Registered in the index and resolvable immediately.
    const row = getSessionById(res.newId);
    expect(row).not.toBeNull();
    expect(row!.filePath).toBe(res.filePath);
    expect(res.label).toBe('fork of aaaaaaaa');
    expect(row!.label).toBe('fork of aaaaaaaa');
  });

  it('honors an explicit --name label', () => {
    const source = makeSource('bbbbbbbb');
    const res = forkSession(source, { name: 'try redis instead' });
    expect(res.label).toBe('try redis instead');
    expect(getSessionById(res.newId)!.label).toBe('try redis instead');
  });

  it('throws when the source transcript is missing', () => {
    const source = makeSource('cccccccc');
    fs.rmSync(source.filePath);
    expect(() => forkSession(source)).toThrow(/transcript not found/);
  });
});
