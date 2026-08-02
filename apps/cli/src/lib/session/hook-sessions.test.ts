import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getTerminalsDir, getRuntimeStateDir } from '../state.js';
import { loadHookSessionIndex, resolveHookSessionId, resolveHookSessionRecord, readStateSessionRecord } from './hook-sessions.js';

// Fake pids far above any real process, so the test never reads or clobbers a
// live hook state file.
const P1 = 999_100_001;
const P2 = 999_100_002;
const P3 = 999_100_003;
const SESSIONS_DIR = path.join(getTerminalsDir(), 'sessions');

function writeRecord(pid: number, rec: Record<string, unknown>): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS_DIR, `${pid}.json`), JSON.stringify(rec), 'utf8');
}

afterEach(() => {
  for (const pid of [P1, P2, P3]) {
    try { fs.unlinkSync(path.join(SESSIONS_DIR, `${pid}.json`)); } catch { /* absent */ }
  }
});

describe('hook session index + resolver', () => {
  it('resolves the authoritative id under a direct pid', () => {
    writeRecord(P1, { session_id: 'sess-direct', agent: 'codex', pid: P1, ts: 10 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'codex' })).toBe('sess-direct');
  });

  it('resolveHookSessionRecord returns the full record incl. ts (the startedAtMs source)', () => {
    // active.ts stamps startedAtMs from this ts; resolving only the id (the old
    // resolveHookSessionId) is why terminal/headless rows had no start time.
    writeRecord(P1, { session_id: 'sess-ts', agent: 'claude', pid: P1, ts: 1785544530059 });
    const idx = loadHookSessionIndex();
    const rec = resolveHookSessionRecord(idx, { pid: P1, kind: 'claude' });
    expect(rec?.session_id).toBe('sess-ts');
    expect(rec?.ts).toBe(1785544530059);
    // kind guard still applies: a mismatched kind resolves nothing.
    expect(resolveHookSessionRecord(idx, { pid: P1, kind: 'codex' })).toBeUndefined();
  });

  it('joins by launchId even when the hook pid differs from the recorded pid', () => {
    // The hook runs under the agent pid (P2); `ag run` recorded a different pid
    // (a tmux pane leaf / cmd.exe wrapper) but the SAME launchId in options.env.
    writeRecord(P2, { session_id: 'sess-join', agent: 'codex', pid: P2, launch_id: 'L-xyz', ts: 20 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: 999_999_998, kind: 'codex', launchId: 'L-xyz' })).toBe('sess-join');
    expect(resolveHookSessionId(idx, { pid: 999_999_998, kind: 'codex', launchId: 'L-nope' })).toBeUndefined();
  });

  it('joins by terminalId (Factory VS Code tab)', () => {
    writeRecord(P1, { session_id: 'sess-term', agent: 'claude', pid: P1, terminal_id: 'CL-1-1', ts: 5 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: 42, kind: 'claude', terminalId: 'CL-1-1' })).toBe('sess-term');
  });

  it('resolves via an immediate child pid (wrapper/shell recorded, agent is a child)', () => {
    writeRecord(P2, { session_id: 'sess-child', agent: 'codex', pid: P2, ts: 7 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'codex', childPids: [P2] })).toBe('sess-child');
  });

  it('prefers the newest record on a launchId collision (pid reuse)', () => {
    writeRecord(P1, { session_id: 'old', pid: P1, launch_id: 'L-dup', ts: 100 });
    writeRecord(P2, { session_id: 'new', pid: P2, launch_id: 'L-dup', ts: 200 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: 1, kind: 'claude', launchId: 'L-dup' })).toBe('new');
  });

  it('kind-guards a stale reused-pid file: a live codex must NOT inherit a dead claude session', () => {
    // A dead claude left sessions/P1.json; pid P1 is now a live codex we did not
    // launch (no launchId). The kind mismatch must reject the stale record.
    writeRecord(P1, { session_id: 'stale-claude', agent: 'claude', pid: P1, ts: 1 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'codex' })).toBeUndefined();
    // Same-kind read is still allowed.
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'claude' })).toBe('stale-claude');
  });

  it('normalizes cursor: ps kind `cursor-agent` matches a hook record agent `cursor`', () => {
    writeRecord(P1, { session_id: 'sess-cursor', agent: 'cursor', pid: P1, ts: 3 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'cursor-agent' })).toBe('sess-cursor');
  });

  it('is permissive when the record omits agent (legacy/unknown)', () => {
    writeRecord(P1, { session_id: 'sess-legacy', pid: P1, ts: 2 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'gemini' })).toBe('sess-legacy');
  });

  it('ignores a record missing session_id', () => {
    writeRecord(P1, { agent: 'codex', pid: P1, launch_id: 'L-empty', ts: 1 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'codex', launchId: 'L-empty' })).toBeUndefined();
  });
});

// RUSH-2007 Layer A: the DEPLOYED hook writes state/sessions/<pid>.json (a distinct
// path from the un-deployed session-tracker's terminals/sessions/ above). This is the
// targeted per-pid reader that surfaces non-Claude ids from the real fleet source.
const STATE_SESSIONS_DIR = path.join(getRuntimeStateDir(), 'sessions');
const SP = 999_200_001; // fake pid, far above any real process

function writeStateRecord(pid: number, rec: Record<string, unknown>): void {
  fs.mkdirSync(STATE_SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_SESSIONS_DIR, `${pid}.json`), JSON.stringify(rec), 'utf8');
}

describe('readStateSessionRecord (deployed hook, state/sessions/<pid>.json)', () => {
  afterEach(() => {
    try { fs.unlinkSync(path.join(STATE_SESSIONS_DIR, `${SP}.json`)); } catch { /* absent */ }
  });

  it('reads the deployed hook record for a specific pid (the real fleet id source)', () => {
    // ts is Unix SECONDS, as the hook stamps it (`date +%s`).
    writeStateRecord(SP, { session_id: '33109c18-real', cwd: '/x', pid: SP, ts: 1785640088 });
    expect(readStateSessionRecord(SP)?.session_id).toBe('33109c18-real');
  });

  it('returns undefined when no record exists for the pid (the common miss — no dir scan)', () => {
    expect(readStateSessionRecord(SP)).toBeUndefined();
  });

  it('freshness guard: rejects a record whose ts predates the live process start (reused pid)', () => {
    // Record written at ts=1000s (=1_000_000ms) by a DEAD predecessor; the live
    // process at this reused pid started at 5_000_000ms — the stale id must not cross.
    writeStateRecord(SP, { session_id: 'stale-predecessor', pid: SP, ts: 1000 });
    expect(readStateSessionRecord(SP, 5_000_000)).toBeUndefined();
  });

  it('freshness guard: accepts a record written after the process start (within skew)', () => {
    // Process started at 1_000_000ms; hook stamped ts=1000s (=1_000_000ms) just after.
    writeStateRecord(SP, { session_id: 'fresh-current', pid: SP, ts: 1000 });
    expect(readStateSessionRecord(SP, 1_000_000)?.session_id).toBe('fresh-current');
  });

  it('is best-effort without a start time: returns the record when startedAtMs is unknown', () => {
    writeStateRecord(SP, { session_id: 'no-anchor', pid: SP, ts: 1 });
    expect(readStateSessionRecord(SP)?.session_id).toBe('no-anchor');
  });

  it('ignores a record missing session_id', () => {
    writeStateRecord(SP, { cwd: '/x', pid: SP, ts: 1785640088 });
    expect(readStateSessionRecord(SP)).toBeUndefined();
  });
});
