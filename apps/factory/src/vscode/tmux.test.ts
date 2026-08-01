import { afterEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

mock.module('vscode', () => ({
  ViewColumn: { Active: 1 },
  window: {
    createTerminal: () => ({
      processId: Promise.resolve(0),
      sendText: () => {},
    }),
  },
}));

const { __factoryPaneDiedHookForTests, queryTmuxSessionState, shouldKillOnClose } = await import('./tmux');

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
    expect(state).toEqual({ exists: true, paneAlive: true, hasClient: false });
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
    expect(state).toEqual({ exists: false, paneAlive: false, hasClient: false });
    expect(shouldKillOnClose(state)).toBe(true);
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
