/**
 * RUSH-2384: a live agent can advertise `--session-id` on argv while the
 * by-pid registry is empty. The active scan and `agents message` must still
 * treat that process as reachable.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess, execFileSync } from 'child_process';
import {
  isSessionIdLiveOnProcessTable,
  foldSubordinateAgents,
  listUnattributedActive,
  clearActiveScanCachesForTest,
  type AgentCandidate,
} from './active.js';
import { sessionIdFromLivePid } from './pid-registry.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

const UUID = 'f0f6cb6b-3887-4f96-927e-8a929f3da418';
const UUID_B = '02590f02-7b74-460c-b719-6c330d57859c';

let children: ChildProcess[] = [];
let tmpDirs: string[] = [];

afterEach(() => {
  for (const c of children) {
    if (c.pid) {
      try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
  children = [];
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tmpDirs = [];
  clearActiveScanCachesForTest();
});

function spawnHoldingSessionId(sessionId: string, opts: { binName?: string; cwd?: string } = {}): ChildProcess {
  // Materialize a hardlink (or copy) of the node binary named `claude` so
  // `ps -o comm=` reports `claude` and agentKindFromComm attributes it. A
  // shebang wrapper would re-exec as `node`/`sh` and drop out of the agent scan.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rush-2384-'));
  tmpDirs.push(dir);
  const binName = opts.binName ?? 'claude';
  const bin = path.join(dir, binName);
  try {
    fs.linkSync(process.execPath, bin);
  } catch {
    fs.copyFileSync(process.execPath, bin);
    fs.chmodSync(bin, 0o755);
  }
  const child = spawn(
    bin,
    ['-e', 'setInterval(() => {}, 60_000)', '--', '--session-id', sessionId, '-p', 'MISSION: hold'],
    {
      cwd: opts.cwd ?? dir,
      stdio: 'ignore',
      detached: false,
    },
  );
  children.push(child);
  return child;
}

describe('isSessionIdLiveOnProcessTable', () => {
  it('rejects non-uuid targets so a short prefix never false-matches', async () => {
    expect(await isSessionIdLiveOnProcessTable('f0f6cb6b')).toBe(false);
    expect(await isSessionIdLiveOnProcessTable('')).toBe(false);
  });

  it('returns true only when a deps table row carries the session id', async () => {
    expect(
      await isSessionIdLiveOnProcessTable(UUID, {
        readTable: async () => [{ pid: 1, kind: 'claude' }, { pid: 2, kind: 'claude' }],
        sessionIdOf: (pid) => (pid === 2 ? UUID : undefined),
      }),
    ).toBe(true);
    expect(
      await isSessionIdLiveOnProcessTable(UUID, {
        readTable: async () => [{ pid: 1, kind: 'claude' }],
        sessionIdOf: () => UUID_B,
      }),
    ).toBe(false);
    // Rows without an agent kind are ignored (ordinary non-agent processes).
    expect(
      await isSessionIdLiveOnProcessTable(UUID, {
        readTable: async () => [{ pid: 9 }],
        sessionIdOf: () => UUID,
      }),
    ).toBe(false);
  });
});

describe('live --session-id recovery (RUSH-2384 real process)', () => {
  posixOnly('sessionIdFromLivePid recovers the id from a claude-named process with empty by-pid', async () => {
    const child = spawnHoldingSessionId(UUID);
    const pid = child.pid!;
    await new Promise((r) => setTimeout(r, 80));
    expect(sessionIdFromLivePid(pid)).toBe(UUID);
  });

  posixOnly('listUnattributedActive attributes a worktree-cwd process by its live --session-id', async () => {
    // Recreate the incident shape: cwd is a path under .agents/worktrees/<slug>,
    // by-pid is empty, and the process is a bare headless agent.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rush-2384-repo-'));
    tmpDirs.push(repo);
    const wt = path.join(repo, '.agents', 'worktrees', 'teams-reliability-recovered');
    fs.mkdirSync(wt, { recursive: true });

    const child = spawnHoldingSessionId(UUID, { cwd: wt });
    const pid = child.pid!;
    await new Promise((r) => setTimeout(r, 100));

    // Confirm the OS still sees the process as `claude` (comm basename).
    try {
      const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      // Some platforms report the full path; basename must be claude.
      expect(path.basename(comm)).toMatch(/^claude/);
    } catch {
      // If ps cannot see it yet, the unattributed scan is the real assertion.
    }

    clearActiveScanCachesForTest();
    const rows = await listUnattributedActive(new Set());
    const hit = rows.find((r) => r.sessionId === UUID || r.pid === pid);
    expect(hit, `expected active row for ${UUID} / pid ${pid}; got ${rows.map((r) => `${r.pid}:${r.sessionId}`).join(', ')}`).toBeDefined();
    expect(hit!.sessionId).toBe(UUID);
    // cwd should be the worktree path (lsof) when recoverable.
    if (hit!.cwd) {
      expect(hit!.cwd).toContain('teams-reliability-recovered');
    }
  });

  it('foldSubordinateAgents keeps a live-session child when registry is empty', () => {
    const candidates: AgentCandidate[] = [
      { pid: 10, kind: 'claude' },
      { pid: 20, kind: 'claude' },
    ];
    const ppid = new Map([[10, 1], [20, 10]]);
    const { kept } = foldSubordinateAgents(
      candidates,
      ppid,
      () => undefined,
      (pid) => pid === 20,
    );
    expect(kept.map((c) => c.pid).sort((a, b) => a - b)).toEqual([10, 20]);
  });
});
