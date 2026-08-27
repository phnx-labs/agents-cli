/**
 * `agents sessions stop` teardown, against a REAL tmux server (no mocks).
 *
 * The extension calls `sessions stop` when a user genuinely closes an agent tab
 * (Cmd+W) so the underlying agent + its tmux session are shut down instead of
 * left running detached — the "Cmd+W orphans an idle session" bug (#5b). This
 * pins the actual teardown: a live tmux-hosted session is GONE after the stop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'node:child_process';
import { isTmuxInstalled } from '../lib/tmux/binary.js';
import { createSession, hasSession, killAll } from '../lib/tmux/session.js';
import { stopInteractive } from './detach.js';
import type { ActiveSession } from '../lib/session/active.js';

const skipReason = isTmuxInstalled() ? null : 'tmux not installed';

describe.skipIf(skipReason)('sessions stop — tmux teardown', () => {
  let socket: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-stop-test-'));
    socket = path.join(tempDir, 'srv.sock');
  });

  afterEach(async () => {
    try { await killAll(socket); } catch { /* best-effort */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* gone */ }
  });

  it('kills the live tmux session of a stopped agent (the mux is torn down)', async () => {
    // A live tmux-hosted agent, exactly as `agents run` wraps one.
    await createSession({ name: 'ag-live', cmd: 'sleep 300', socket });
    expect(await hasSession('ag-live', socket)).toBe(true);

    // The ActiveSession the resolver hands `stop` for a tmux-hosted agent: its
    // process lives inside the tmux session named by `tmuxTarget`.
    const s = { context: 'local', kind: 'claude', tmuxTarget: 'ag-live:0.0', sessionId: 'abcd1234' } as unknown as ActiveSession;
    await stopInteractive(s, socket);

    // The mux is gone — a Cmd+W-closed tab no longer leaves an orphaned session.
    expect(await hasSession('ag-live', socket)).toBe(false);
  });
});

describe('PHNX-3298 — stop resolves a unique local live id without a fleet wait', () => {
  it('unique local UUID skips the fleet then resolveOne hits that row', async () => {
    const { localLiveSelectorMatches, shouldSkipRemoteSweep } = await import('./go.js');
    const { resolveOne } = await import('./detach-core.js');
    const sid = 'c1a0de70-3298-4000-8000-000000003298';
    const row = { context: 'local', kind: 'claude', sessionId: sid, status: 'running' } as unknown as ActiveSession;
    expect(shouldSkipRemoteSweep(localLiveSelectorMatches([row], sid))).toBe(true);
    const r = resolveOne(new Map([[sid, row]]), sid);
    expect('error' in r).toBe(false);
    expect((r as ActiveSession).sessionId).toBe(sid);
  });

  it('two local 8-hex collisions fail closed without racing the fleet', async () => {
    const { localLiveSelectorMatches, shouldSkipRemoteSweep } = await import('./go.js');
    const { resolveOne } = await import('./detach-core.js');
    const a = { context: 'local', kind: 'claude', sessionId: 'aaaaaaaa-1111-4000-8000-000000000001', status: 'running' } as unknown as ActiveSession;
    const b = { context: 'local', kind: 'codex', sessionId: 'aaaaaaaa-2222-4000-8000-000000000002', status: 'running' } as unknown as ActiveSession;
    expect(shouldSkipRemoteSweep(localLiveSelectorMatches([a, b], 'aaaaaaaa'))).toBe(true);
    const r = resolveOne(new Map([[a.sessionId!, a], [b.sessionId!, b]]), 'aaaaaaaa');
    expect('error' in r && r.error).toMatch(/ambiguous/i);
  });
});

describe('sessions stop — plain-process teardown', () => {
  it('SIGTERMs a non-tmux agent process by pid, then waits for it to exit', async () => {
    // A bare (non-tmux) interactive spawn: stop must signal the pid and confirm
    // the process is actually gone before returning.
    const child = spawn('sleep', ['300'], { stdio: 'ignore' });
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);
    // Reap the exit so the pid doesn't linger as a zombie our liveness check sees.
    const exited = new Promise<void>((r) => child.once('exit', () => r()));

    const s = { context: 'local', kind: 'codex', pid, sessionId: 'ef567890' } as unknown as ActiveSession;
    await stopInteractive(s);
    await exited;

    // The process is gone: signalling it now throws ESRCH.
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
