/**
 * Tests for the agent-helper orphan reaper (RUSH-2521).
 *
 * The integration block spawns a REAL tmux pane whose command starts a REAL
 * helper process that ignores SIGHUP — the exact shape that leaks in production
 * — then exits, and asserts the reaper collects it. Nothing on that path is
 * mocked: real tmux, real processes, real signals.
 *
 * The selector block covers the decision logic with process tables captured from
 * the fleet, including the verbatim argv of a leaked Claude Code daemon.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isTmuxInstalled, runTmux } from './binary.js';
import { createSession, hasSession, killAll, killSession, reapDeadTmuxPanes } from './session.js';
import {
  DETACHED_HELPER_RULES,
  TMUX_SESSION_ENV,
  descendantsOf,
  isProtectedAgentsService,
  parsePaneOwners,
  parseProcessRows,
  parseTmuxSessionMarker,
  selectOrphanProcesses,
  type AgentProcess,
  type PaneOwner,
} from './orphan-reap.js';

const posix = process.platform !== 'win32';
const skipReason = !posix ? 'POSIX-only' : (isTmuxInstalled() ? null : 'tmux not installed');

const proc = (pid: number, ppid: number, args: string, tmuxSession?: string): AgentProcess =>
  ({ pid, ppid, args, tmuxSession });

const owners = (entries: Array<[string, PaneOwner]>): Map<string, PaneOwner> => new Map(entries);

const noneProtected = { protectedPids: new Set<number>() };

describe('parseProcessRows', () => {
  it('splits pid/ppid and keeps the full argv, spaces included', () => {
    const rows = parseProcessRows([
      '  201357  201227 /home/me/.local/bin/cgraph-mcp --root /home/me/src/agents-cli --daemon',
      '       1       0 /sbin/init',
      'garbage line with no pids',
      '',
    ].join('\n'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pid: 201357, ppid: 201227 });
    expect(rows[0].args).toContain('--root /home/me/src/agents-cli --daemon');
    expect(rows[1]).toMatchObject({ pid: 1, ppid: 0, args: '/sbin/init' });
  });
});

describe('parseTmuxSessionMarker', () => {
  it('reads the marker out of a NUL-separated /proc/<pid>/environ blob', () => {
    const environ = ['PATH=/usr/bin', `${TMUX_SESSION_ENV}=ag-codex-ff55f79f`, 'HOME=/home/me'].join('\0') + '\0';
    expect(parseTmuxSessionMarker(environ)).toBe('ag-codex-ff55f79f');
  });

  it('reads the marker out of the space-separated tail macOS `ps -E` appends', () => {
    const line = `node /opt/agents/dist/index.js PATH=/usr/bin ${TMUX_SESSION_ENV}=ag-claude-8f89aab4 SHELL=/bin/zsh`;
    expect(parseTmuxSessionMarker(line)).toBe('ag-claude-8f89aab4');
  });

  it('does not match a variable that merely ends with the marker name', () => {
    expect(parseTmuxSessionMarker(`MY_${TMUX_SESSION_ENV}=ag-claude-1234abcd`)).toBeUndefined();
  });

  it('is undefined when no marker is present', () => {
    expect(parseTmuxSessionMarker('PATH=/usr/bin\0HOME=/home/me\0')).toBeUndefined();
  });
});

describe('parsePaneOwners', () => {
  it('treats a session as owned while ANY of its panes has a live agent', () => {
    const alive = (pid: number) => pid === 100;
    const map = parsePaneOwners(['ag-claude-aaaa\t100\t0', 'ag-claude-aaaa\t101\t0'].join('\n'), alive);
    expect(map.get('ag-claude-aaaa')).toEqual({ agentAlive: true, attached: false });
  });

  it('marks a session attached when any pane reports a client', () => {
    const map = parsePaneOwners(['ag-claude-bbbb\t200\t1'].join('\n'), () => false);
    expect(map.get('ag-claude-bbbb')).toEqual({ agentAlive: false, attached: true });
  });
});

describe('selectOrphanProcesses', () => {
  it('reaps a helper whose tmux session no longer exists', () => {
    const table = [proc(500, 1, 'cgraph-mcp --daemon', 'ag-codex-ff55f79f')];
    const picked = selectOrphanProcesses(table, owners([]), noneProtected);
    expect(picked).toEqual([{ pid: 500, args: 'cgraph-mcp --daemon', reason: 'tmux-session-gone', tmuxSession: 'ag-codex-ff55f79f' }]);
  });

  it('reaps a helper whose session exists but whose agent pane process has exited', () => {
    const table = [proc(500, 1, 'cgraph-mcp --daemon', 'ag-claude-dead')];
    const picked = selectOrphanProcesses(table, owners([['ag-claude-dead', { agentAlive: false, attached: false }]]), noneProtected);
    expect(picked.map(c => c.reason)).toEqual(['tmux-agent-exited']);
  });

  it('NEVER reaps a helper whose agent is still running', () => {
    const table = [proc(500, 400, 'cgraph-mcp --daemon', 'ag-claude-live')];
    const picked = selectOrphanProcesses(table, owners([['ag-claude-live', { agentAlive: true, attached: false }]]), noneProtected);
    expect(picked).toEqual([]);
  });

  it('NEVER reaps a helper of a session that has a client attached, even with a dead pane', () => {
    const table = [proc(500, 1, 'cgraph-mcp --daemon', 'ag-claude-watched')];
    const picked = selectOrphanProcesses(table, owners([['ag-claude-watched', { agentAlive: false, attached: true }]]), noneProtected);
    expect(picked).toEqual([]);
  });

  it('NEVER reaps the routines daemon or the secrets broker, marker or not', () => {
    const table = [
      proc(600, 1, 'node dist/index.js __daemon-run', 'ag-claude-gone'),
      proc(601, 1, 'node dist/index.js secrets _agent-run', 'ag-claude-gone'),
    ];
    expect(selectOrphanProcesses(table, owners([]), noneProtected)).toEqual([]);
    expect(isProtectedAgentsService('node dist/index.js __daemon-run')).toBe(true);
  });

  it('NEVER reaps the reaping process itself or its ancestors', () => {
    const table = [proc(700, 699, 'node dist/index.js sessions reap', 'ag-claude-gone')];
    expect(selectOrphanProcesses(table, owners([]), { protectedPids: new Set([700]) })).toEqual([]);
  });

  it('reaps a detached harness daemon whose declared spawner is dead, and its workers', () => {
    // Verbatim argv measured on yosemite-s1: a Claude Code daemon still holding
    // 2.5 GB of bg workers 22 days after the claude that spawned it exited.
    const daemonArgs = '/home/me/.agents/.history/versions/claude/2.1.207/node_modules/@anthropic-ai/claude-code/bin/claude.exe '
      + 'daemon run --origin transient --spawned-by {"label":"claude","cwd":"/home/me/src/agents-cli","pid":3834601}';
    const table = [
      proc(3868250, 1, daemonArgs),
      proc(3868356, 3868250, 'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-1000/cbb199fb/spare/0d113ea8.pty.sock'),
      proc(3868404, 3868356, 'claude bg-spare --bg-spare /tmp/cc-daemon-1000/cbb199fb/spare/0d113ea8.claim.sock'),
      proc(999, 1, 'unrelated-process'),
    ];
    const picked = selectOrphanProcesses(table, owners([]), { ...noneProtected, isAlive: () => false });
    expect(picked.map(c => c.pid).sort((a, b) => a - b)).toEqual([3868250, 3868356, 3868404]);
    expect(picked.every(c => c.reason === 'detached-helper')).toBe(true);
  });

  it('NEVER reaps a detached harness daemon whose declared spawner is still alive', () => {
    const daemonArgs = 'claude.exe daemon run --origin transient --spawned-by {"label":"claude","pid":3834601}';
    const table = [
      proc(3868250, 3834601, daemonArgs),
      proc(3868356, 3868250, 'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-1000/cbb199fb/spare/x.pty.sock'),
    ];
    const picked = selectOrphanProcesses(table, owners([]), { ...noneProtected, isAlive: pid => pid === 3834601 });
    expect(picked).toEqual([]);
  });

  it('claude rule ignores a non-daemon claude command line', () => {
    const rule = DETACHED_HELPER_RULES.find(r => r.agent === 'claude')!;
    expect(rule.spawnerPid('/home/me/.../.bin/claude --permission-mode plan --session-id 978673a2')).toBeUndefined();
    expect(rule.spawnerPid('claude.exe daemon run --spawned-by {"pid":42}')).toBe(42);
  });
});

describe('descendantsOf', () => {
  it('returns the seeds plus everything reachable through ppid links', () => {
    const table = [proc(10, 1, 'a'), proc(11, 10, 'b'), proc(12, 11, 'c'), proc(20, 1, 'other')];
    expect(descendantsOf(table, [10]).sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  it('terminates on a cyclic ppid chain instead of spinning', () => {
    const table = [proc(30, 31, 'a'), proc(31, 30, 'b')];
    expect(descendantsOf(table, [30]).sort((a, b) => a - b)).toEqual([30, 31]);
  });
});

describe.skipIf(skipReason)('reaping a real leaked helper', () => {
  let socket: string;
  let tempDir: string;
  const spawned: number[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-orphan-reap-'));
    socket = path.join(tempDir, 'test.sock');
  });

  afterEach(async () => {
    await killAll(socket).catch(() => {});
    for (const pid of spawned.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped — the point of the test */ }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Launch a pane that exports the session marker (as the real pane env file
   * does), starts a SIGHUP-immune helper, records its pid, and exits — the
   * production leak, reproduced.
   */
  async function launchLeakingSession(name: string, agentCmd: string): Promise<number> {
    const pidFile = path.join(tempDir, `${name}.pid`);
    const cmd = `export ${TMUX_SESSION_ENV}=${name}; sh -c 'trap "" HUP; exec sleep 300' & echo $! > ${pidFile}; ${agentCmd}`;
    await createSession({ name, cmd, socket });
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) await wait(50);
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    expect(Number.isFinite(pid)).toBe(true);
    spawned.push(pid);
    return pid;
  }

  it('kills the helper an exited agent left behind, and leaves no dead session', async () => {
    const name = `orph-dead-${process.pid}`;
    const helper = await launchLeakingSession(name, 'exec sleep 0.3');
    await waitForPaneDead(name, socket, 8000);

    // The leak, before the fix does anything: the agent is gone, the helper is not.
    expect(alive(helper)).toBe(true);
    expect(markerOf(helper)).toBe(name);

    const result = await reapDeadTmuxPanes(socket);

    expect(result.processes).toBeGreaterThanOrEqual(1);
    expect(result.processDetails.join('\n')).toContain(String(helper));
    expect(await waitForGone(helper, 6000)).toBe(true);
    expect(await hasSession(name, socket)).toBe(false);
  }, 30_000);

  it('does NOT kill the helper of a session whose agent is still running', async () => {
    const name = `orph-live-${process.pid}`;
    const helper = await launchLeakingSession(name, 'exec sleep 120');

    const result = await reapDeadTmuxPanes(socket);

    expect(result.processDetails.join('\n')).not.toContain(String(helper));
    expect(alive(helper)).toBe(true);
    expect(await hasSession(name, socket)).toBe(true);
  }, 30_000);

  it('killSession tears the session helpers down with the session', async () => {
    const name = `orph-kill-${process.pid}`;
    const helper = await launchLeakingSession(name, 'exec sleep 120');
    expect(alive(helper)).toBe(true);

    await killSession(name, socket);

    expect(await waitForGone(helper, 6000)).toBe(true);
  }, 30_000);
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The pane marker a live process actually carries, read the way the reaper reads it. */
function markerOf(pid: number): string | undefined {
  if (!fs.existsSync('/proc/self/environ')) return undefined; // macOS reads it via `ps -E`
  try {
    return parseTmuxSessionMarker(fs.readFileSync(`/proc/${pid}/environ`, 'utf8'));
  } catch {
    return undefined;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await wait(100);
  }
  return !alive(pid);
}

/** Poll until the session's agent pane reports `pane_dead=1`. */
async function waitForPaneDead(name: string, socket: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await runTmux({ socket, args: ['list-panes', '-t', `=${name}`, '-F', '#{pane_dead}'], throwOnError: false });
    if (res.code === 0 && res.stdout.trim().split('\n')[0] === '1') return;
    await wait(100);
  }
  throw new Error(`pane for ${name} never died within ${timeoutMs}ms`);
}
