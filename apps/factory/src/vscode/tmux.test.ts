import { afterEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Captures the options passed to the mocked vscode.window.createTerminal so the
// reattach test can assert the env forwarded through reattachTmuxTerminal.
let lastCreateTerminalOptions: any;

mock.module('vscode', () => ({
  ViewColumn: { Active: 1 },
  window: {
    createTerminal: (opts: any) => {
      lastCreateTerminalOptions = opts;
      return {
        processId: Promise.resolve(0),
        sendText: () => {},
      };
    },
  },
}));

const { __factoryPaneDiedHookForTests, queryTmuxSessionState, shouldKillOnClose, reattachTmuxTerminal } = await import('./tmux');

const tmuxPath = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
const realTmuxTest = tmuxPath ? test : test.skip;
let sockets: string[] = [];

afterEach(() => {
  for (const socket of sockets) {
    try { execFileSync(tmuxPath, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { fs.unlinkSync(socket); } catch { /* ignore */ }
  }
  sockets = [];
});

describe('Factory tmux pane-death hook', () => {
  realTmuxTest('kills non-last dead panes and leaves the last-pane death detectable', async () => {
    const socket = path.join(os.tmpdir(), `factory-tmux-${process.pid}-${Date.now()}.sock`);
    sockets.push(socket);
    const name = 'factory1543';
    tmux([
      'set-option', '-g', 'remain-on-exit', 'on',
      ';',
      'new-session', '-d', '-s', name, 'sleep 30',
    ], socket);
    tmux(['set-hook', '-t', name, 'pane-died', __factoryPaneDiedHookForTests(name)], socket);

    const originalPane = paneRows(socket, name)[0].id;
    tmux(['split-window', '-t', name, '-v', 'sh -c "exit 0"'], socket);
    expect(await waitForRows(socket, name, (rows) => rows.length === 1 && rows[0].id === originalPane && rows[0].dead === '0'))
      .toEqual([{ id: originalPane, dead: '0' }]);

    tmux(['split-window', '-t', name, '-v', 'sleep 30'], socket);
    const splitPane = paneRows(socket, name).find((row) => row.id !== originalPane)?.id;
    expect(splitPane).toBeTruthy();

    tmux(['send-keys', '-t', originalPane, 'C-c'], socket);
    const afterOriginalExit = await waitForRows(
      socket,
      name,
      (rows) => liveRows(rows).length === 1 && liveRows(rows)[0].id === splitPane,
    );
    expect(liveRows(afterOriginalExit)).toEqual([{ id: splitPane!, dead: '0' }]);

    tmux(['send-keys', '-t', splitPane!, 'C-c'], socket);
    expect(liveRows(await waitForRows(socket, name, (rows) => liveRows(rows).length === 0)))
      .toEqual([]);
  });
});

// The destructive-bug fix: on a terminal close, only kill the tmux session when
// the agent has truly exited (session gone or every pane dead). A client/network
// detach leaves a live pane — we must NOT kill it, so the reconnect scan can
// re-attach. These drive queryTmuxSessionState + shouldKillOnClose against a
// REAL tmux server on a private socket (no mocking of tmux).
describe('reconnect: detach vs agent-exit kill decision', () => {
  realTmuxTest('live pane + no client is a DETACH — do not kill', async () => {
    const socket = newSocket();
    const name = 'factory-detach';
    // Detached session (no client attached), long-lived process → live pane.
    tmux(['new-session', '-d', '-s', name, 'sleep 60'], socket);

    const state = await queryTmuxSessionState(socket, name);
    expect(state).toEqual({ exists: true, paneAlive: true, hasClient: false, probeFailed: false });
    // A live pane means the agent is still running: leave it alone for re-attach.
    expect(shouldKillOnClose(state)).toBe(false);
  });

  realTmuxTest('dead pane is a true agent EXIT — kill', async () => {
    const socket = newSocket();
    const name = 'factory-exit';
    // remain-on-exit keeps the pane lingering after the process exits, marked
    // dead — the unambiguous agent-exit signal.
    tmux(['set-option', '-g', 'remain-on-exit', 'on', ';',
      'new-session', '-d', '-s', name, 'sh -c "exit 0"'], socket);

    // Wait for the pane to be reported dead.
    await waitForRows(socket, name, (rows) => rows.length === 1 && rows[0].dead === '1');

    const state = await queryTmuxSessionState(socket, name);
    expect(state.exists).toBe(true);
    expect(state.paneAlive).toBe(false);
    expect(shouldKillOnClose(state)).toBe(true);
  });

  realTmuxTest('missing session is gone — kill (idempotent no-op downstream)', async () => {
    const socket = newSocket();
    const name = 'factory-not-there';
    // Start the server with an unrelated session so the socket exists, then
    // query a name that was never created.
    tmux(['new-session', '-d', '-s', 'other', 'sleep 60'], socket);

    const state = await queryTmuxSessionState(socket, name);
    expect(state).toEqual({ exists: false, paneAlive: false, hasClient: false, probeFailed: false });
    expect(shouldKillOnClose(state)).toBe(true);
  });

  // A genuinely LIVE session that the probe cannot READ because no tmux binary is
  // reachable (asdf/mise/Nix/Linuxbrew/container prefix — tmux lives outside the 4
  // candidate paths). queryTmuxSessionState must report probeFailed (NOT "gone"),
  // and shouldKillOnClose must then decline to kill. Driven with a candidate list
  // that resolves to nothing while the session is really alive on the socket.
  realTmuxTest('a live session with NO reachable tmux binary is probeFailed and NOT killed', async () => {
    const socket = newSocket();
    const name = 'factory-live-unreadable';
    tmux(['new-session', '-d', '-s', name, 'sleep 60'], socket); // genuinely alive

    // Candidate list that can never resolve to a runnable tmux → ENOENT on every
    // candidate → no-binary. The session is still alive on the socket.
    const state = await queryTmuxSessionState(socket, name, ['/nonexistent/tmux-a', '/nonexistent/tmux-b']);
    expect(state.probeFailed).toBe(true);
    expect(state.exists).toBe(false);   // we learned nothing, so exists is false…
    expect(shouldKillOnClose(state)).toBe(false); // …but probeFailed makes it a no-kill
  });

  // Contrast: tmux IS reachable but the session is genuinely gone → command-error,
  // NOT probeFailed → this DOES kill (a real exit, cleaned up).
  realTmuxTest('a gone session with a reachable tmux binary is NOT probeFailed and IS killed', async () => {
    const socket = newSocket();
    tmux(['new-session', '-d', '-s', 'other', 'sleep 60'], socket); // server exists
    const state = await queryTmuxSessionState(socket, 'never-created');
    expect(state.probeFailed).toBe(false);
    expect(shouldKillOnClose(state)).toBe(true);
  });
});

// The fail-safe kill decision, pure — no tmux binary needed, so this runs
// everywhere (including the CI/sandbox that has no tmux, exactly the environment
// where the regression it guards would otherwise ship undetected).
describe('shouldKillOnClose fail-safe', () => {
  test('a live pane is never killed (detach)', () => {
    expect(shouldKillOnClose({ exists: true, paneAlive: true, hasClient: false, probeFailed: false })).toBe(false);
  });
  test('a dead pane is killed (true agent exit)', () => {
    expect(shouldKillOnClose({ exists: true, paneAlive: false, hasClient: false, probeFailed: false })).toBe(true);
  });
  test('a confirmed-gone session is killed', () => {
    expect(shouldKillOnClose({ exists: false, paneAlive: false, hasClient: false, probeFailed: false })).toBe(true);
  });
  test('a FAILED probe (tmux binary unreachable) is NEVER killed — fail safe, keep the agent alive', () => {
    // This is the regression prix flagged: without the probeFailed guard, a host
    // whose tmux lives outside the 4 candidate paths reports exists:false on every
    // live session and destroys every agent on detach. The guard makes an
    // unconfirmable probe a no-kill.
    expect(shouldKillOnClose({ exists: false, paneAlive: false, hasClient: false, probeFailed: true })).toBe(false);
  });
});

// reattachSession passes AGENT_TERMINAL_ID (+ session/kind) via `env` so that if
// onDidOpenTerminal wins the register race it derives the SAME id, keeping the
// durable terminalId↔tmux identity stable. reattachTmuxTerminal must forward that
// env into createTerminal (alongside TMUX_AGENT_SESSION), not drop it.
describe('reattachTmuxTerminal forwards the caller env (terminalId identity)', () => {
  test('AGENT_TERMINAL_ID from the caller lands in the created terminal env, with TMUX_AGENT_SESSION', () => {
    lastCreateTerminalOptions = undefined;
    reattachTmuxTerminal(
      'Claude - refactor auth',
      'claude',
      'agents-1712345678901',
      '/tmp/server.sock',
      {
        env: {
          AGENT_TERMINAL_ID: 'CL-persisted-7',
          AGENT_TERMINAL_KIND: 'agent',
          AGENT_SESSION_ID: 'sess-xyz',
        },
      },
    );
    expect(lastCreateTerminalOptions).toBeDefined();
    expect(lastCreateTerminalOptions.env.AGENT_TERMINAL_ID).toBe('CL-persisted-7');
    expect(lastCreateTerminalOptions.env.AGENT_TERMINAL_KIND).toBe('agent');
    expect(lastCreateTerminalOptions.env.AGENT_SESSION_ID).toBe('sess-xyz');
    // The tmux attach target is still set too — the two must coexist.
    expect(lastCreateTerminalOptions.env.TMUX_AGENT_SESSION).toBe('agents-1712345678901');
    expect(lastCreateTerminalOptions.isTransient).toBe(true);
  });
});

function newSocket(): string {
  const socket = path.join(os.tmpdir(), `factory-tmux-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
  sockets.push(socket);
  return socket;
}

function tmux(args: string[], socket: string): string {
  return execFileSync(tmuxPath, ['-S', socket, ...args], { encoding: 'utf8' });
}

function paneRows(socket: string, name: string): Array<{ id: string; dead: string }> {
  return tmux(['list-panes', '-t', name, '-F', '#{pane_id}:#{pane_dead}'], socket)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, dead] = line.split(':');
      return { id, dead };
    });
}

function liveRows(rows: Array<{ id: string; dead: string }>): Array<{ id: string; dead: string }> {
  return rows.filter((row) => row.dead === '0');
}

async function waitForRows(
  socket: string,
  name: string,
  predicate: (rows: Array<{ id: string; dead: string }>) => boolean,
): Promise<Array<{ id: string; dead: string }>> {
  const deadline = Date.now() + 10_000;
  let rows: Array<{ id: string; dead: string }> = [];
  while (Date.now() < deadline) {
    rows = paneRows(socket, name);
    if (predicate(rows)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return rows;
}
