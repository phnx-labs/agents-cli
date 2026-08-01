import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The durable terminal↔tmux mapping must survive an extension reload. A reload
// is a fresh process that reads the on-disk store — so we prove it with a fresh
// `bun` subprocess: one run WRITES the mapping (as deactivate would), a second,
// independent run READS it back (as the reconnect activation snapshot would
// after reload). Running in a child process also sidesteps bun's global
// mock.module leakage (a sibling test stubs ../core/sessions.persist for the
// whole run), and keeps this on the REAL store path — no mocking.

const MODULE = path.join(import.meta.dir, 'sessions.persist.ts');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-persist-'));

afterAll(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Run a snippet against the REAL module in a child bun process with HOME pointed
// at the throwaway dir (so SESSIONS_PATH resolves under it). Returns the JSON the
// snippet prints on its last line.
function runInChild(snippet: string): unknown {
  const src = `
    const persist = await import(${JSON.stringify(MODULE)});
    ${snippet}
  `;
  const res = spawnSync('bun', ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
  });
  if (res.status !== 0) {
    throw new Error(`child bun failed (status ${res.status}):\n${res.stderr}\n${res.stdout}`);
  }
  const lines = res.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

describe('durable terminal↔tmux mapping survives a reload', () => {
  const session = {
    terminalId: 'CL-123-1',
    prefix: 'CL',
    sessionId: 'sess-abc',
    label: 'refactor auth',
    agentType: 'claude',
    version: '2.1.170',
    createdAt: 111,
    tmuxSession: 'agents-1712345678901',
    tmuxSocket: '/home/u/.agents/.cache/helpers/tmux/server.sock',
    tmuxPane: '%4',
    agentPid: 4242,
  };

  test('tmuxSession/tmuxSocket/tmuxPane/agentPid round-trip across a reload', () => {
    const ws = '/work/repo';
    // Process 1: WRITE (deactivate).
    runInChild(`
      persist.saveWorkspaceSessions(${JSON.stringify(ws)}, [${JSON.stringify(session)}], true);
      console.log(JSON.stringify('ok'));
    `);
    // Process 2: a fresh reload READS the same store off disk.
    const loaded = runInChild(`
      const rows = persist.getWorkspaceSessions(${JSON.stringify(ws)});
      console.log(JSON.stringify(rows));
    `) as Array<Record<string, unknown>>;

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(session);
    // The reconnect scanner keys off exactly these fields — assert them by name.
    expect(loaded[0].tmuxSession).toBe('agents-1712345678901');
    expect(loaded[0].tmuxSocket).toBe('/home/u/.agents/.cache/helpers/tmux/server.sock');
    expect(loaded[0].tmuxPane).toBe('%4');
    expect(loaded[0].agentPid).toBe(4242);
  });

  test('updateSession can stamp the tmux mapping onto an existing row', () => {
    const ws = '/work/other';
    const loaded = runInChild(`
      persist.saveWorkspaceSessions(${JSON.stringify(ws)}, [{ terminalId: 'CX-9-1', prefix: 'CX', agentType: 'codex', createdAt: 1 }], true);
      persist.updateSession(${JSON.stringify(ws)}, 'CX-9-1', { tmuxSession: 'agents-999', tmuxSocket: '/tmp/s.sock', tmuxPane: '%1', agentPid: 7 });
      console.log(JSON.stringify(persist.getWorkspaceSessions(${JSON.stringify(ws)})));
    `) as Array<Record<string, unknown>>;

    expect(loaded[0].tmuxSession).toBe('agents-999');
    expect(loaded[0].tmuxPane).toBe('%1');
    expect(loaded[0].agentPid).toBe(7);
  });
});
