import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB + run-name sidecars under a temp HOME before
// db.js/state.js capture the path at import time (same pattern as db.names.test).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-fork-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, findSessionsById } = await import('../lib/session/db.js');
const { runFork } = await import('./fork.js');
const { isForkableAgent } = await import('../lib/session/fork.js');
type SessionMeta = import('../lib/session/types.js').SessionMeta;

// Transcripts live in their own dir; a fork lands beside its source, so the id
// captured from the command output — not a readdir — identifies each fork.
const PROJ_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-fork-proj-'));

function seedSession(id: string, agent: string, lines: object[]): SessionMeta {
  const filePath = path.join(PROJ_DIR, `${id}.jsonl`);
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
  fs.writeFileSync(filePath, body);
  const meta: SessionMeta = { id, shortId: id.slice(0, 8), agent, timestamp: new Date().toISOString(), filePath };
  upsertSession(meta, body);
  return meta;
}

/** Capture a console channel's output as one joined string. */
function capture(channel: 'log' | 'error') {
  const lines: string[] = [];
  const spy = vi.spyOn(console, channel).mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(' '));
  });
  return {
    get text() {
      return lines.join('\n');
    },
    restore: () => spy.mockRestore(),
  };
}

afterEach(() => {
  process.exitCode = 0;
});

describe('agents sessions fork (shared action)', () => {
  it('copies a claude session under a new id, leaving the original untouched', async () => {
    const srcId = '11111111-2222-3333-4444-555555555555';
    const src = seedSession(srcId, 'claude', [
      { sessionId: srcId, type: 'user', message: { role: 'user', content: 'hello world' } },
    ]);
    const before = fs.readFileSync(src.filePath, 'utf-8');

    const out = capture('log');
    await runFork(srcId, {});
    out.restore();

    // The command reports the new short id + how to continue it.
    expect(out.text).toMatch(/Forked .* -> /);
    expect(out.text).toContain('agents sessions resume');
    const forkId = out.text.match(/-> (\S+)/)?.[1];
    expect(forkId).toBeTruthy();

    // Original transcript is byte-for-byte untouched.
    expect(fs.readFileSync(src.filePath, 'utf-8')).toBe(before);

    // The fork resolves in the index as its own, distinct session.
    const forked = findSessionsById(forkId!, {})[0];
    expect(forked).toBeTruthy();
    expect(forked!.id).not.toBe(srcId);

    // The copy carries the conversation and rewrote the embedded session id.
    const forkBody = fs.readFileSync(forked!.filePath, 'utf-8');
    expect(forkBody).toContain('hello world');
    expect(forkBody).toContain(`"sessionId":"${forked!.id}"`);
    expect(forkBody).not.toContain(srcId);
  });

  it('applies --name as the fork label', async () => {
    const srcId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    seedSession(srcId, 'claude', [{ sessionId: srcId, type: 'user', message: { role: 'user', content: 'x' } }]);

    const out = capture('log');
    await runFork(srcId, { name: 'try redis instead' });
    out.restore();

    const forkId = out.text.match(/-> (\S+)/)?.[1];
    expect(findSessionsById(forkId!, {})[0]?.label).toBe('try redis instead');
  });

  it('fails loud for a non-forkable harness and names the /continue manual path', async () => {
    const srcId = '99999999-8888-7777-6666-555555555555';
    // Only the DB meta's agent matters — the non-forkable branch returns before
    // the transcript is read, so no real codex file format is needed.
    seedSession(srcId, 'codex', []);
    expect(isForkableAgent('codex')).toBe(false);

    const err = capture('error');
    await runFork(srcId, {});
    err.restore();

    expect(process.exitCode).toBe(1);
    expect(err.text).toContain('codex');
    expect(err.text).toContain('/continue');
  });

  it('fails loud when no session matches the id', async () => {
    const err = capture('error');
    await runFork('does-not-exist-zzzz', {});
    err.restore();
    expect(process.exitCode).toBe(1);
    expect(err.text).toContain('No session matching');
  });
});
