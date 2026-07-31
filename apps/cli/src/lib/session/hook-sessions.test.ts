import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getTerminalsDir } from '../state.js';
import { readHookSessionByPid, findHookSessionByLaunchId, findHookSessionByTerminalId } from './hook-sessions.js';

// Fake pids far above any real process, so the test never reads or clobbers a
// live hook state file.
const P1 = 999_100_001;
const P2 = 999_100_002;
const SESSIONS_DIR = path.join(getTerminalsDir(), 'sessions');

function writeRecord(pid: number, rec: Record<string, unknown>): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS_DIR, `${pid}.json`), JSON.stringify(rec), 'utf8');
}

afterEach(() => {
  for (const pid of [P1, P2]) {
    try { fs.unlinkSync(path.join(SESSIONS_DIR, `${pid}.json`)); } catch { /* absent */ }
  }
});

describe('hook session reader', () => {
  it('reads the authoritative id under a direct pid', () => {
    writeRecord(P1, { session_id: 'sess-direct', agent: 'codex', pid: P1, ts: 10 });
    expect(readHookSessionByPid(P1)?.session_id).toBe('sess-direct');
  });

  it('joins by launchId even when the hook pid differs from the recorded pid', () => {
    // The hook runs under the agent pid (P2); `ag run` recorded a different pid
    // (a tmux pane leaf / cmd.exe wrapper) but the SAME launchId in options.env.
    writeRecord(P2, { session_id: 'sess-join', agent: 'codex', pid: P2, launch_id: 'L-xyz', ts: 20 });
    expect(findHookSessionByLaunchId('L-xyz')?.session_id).toBe('sess-join');
    expect(findHookSessionByLaunchId('L-nope')).toBeUndefined();
  });

  it('joins by terminalId (Factory VS Code tab)', () => {
    writeRecord(P1, { session_id: 'sess-term', agent: 'claude', pid: P1, terminal_id: 'CL-1-1', ts: 5 });
    expect(findHookSessionByTerminalId('CL-1-1')?.session_id).toBe('sess-term');
  });

  it('prefers the newest record on a launchId collision (pid reuse)', () => {
    writeRecord(P1, { session_id: 'old', pid: P1, launch_id: 'L-dup', ts: 100 });
    writeRecord(P2, { session_id: 'new', pid: P2, launch_id: 'L-dup', ts: 200 });
    expect(findHookSessionByLaunchId('L-dup')?.session_id).toBe('new');
  });

  it('ignores a record missing session_id', () => {
    writeRecord(P1, { agent: 'codex', pid: P1, launch_id: 'L-empty', ts: 1 });
    expect(readHookSessionByPid(P1)).toBeUndefined();
    expect(findHookSessionByLaunchId('L-empty')).toBeUndefined();
  });
});
