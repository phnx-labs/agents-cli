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

/**
 * Poll until the holder process is observable, instead of sleeping a fixed
 * interval and asserting once. `spawn` returns a pid before the child has been
 * scheduled and exec'd, so on a loaded machine `ps` reports it later than the
 * ~100ms these tests used to wait — the scan then legitimately sees nothing and
 * the assertion fails on timing, not behavior. Measured on `ubuntu-latest, 24`
 * in the release CI matrix: two consecutive runs failed with an EMPTY row set,
 * while the same commit passed ubuntu-22, macOS, and Windows.
 */
async function waitFor<T>(probe: () => T | Promise<T>, timeoutMs = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 50));
  }
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
    expect(await waitFor(() => sessionIdFromLivePid(pid))).toBe(UUID);
  });

  posixOnly('listUnattributedActive attributes a worktree-cwd process by its live --session-id', async (ctx) => {
    // Recreate the incident shape: cwd is a path under .agents/worktrees/<slug>,
    // by-pid is empty, and the process is a bare headless agent.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rush-2384-repo-'));
    tmpDirs.push(repo);
    const wt = path.join(repo, '.agents', 'worktrees', 'teams-reliability-recovered');
    fs.mkdirSync(wt, { recursive: true });

    const child = spawnHoldingSessionId(UUID, { cwd: wt });
    const pid = child.pid!;

    // Wait for the OS to report the process as `claude` (comm basename) — that
    // is the precondition the scan reads, so asserting before it holds tests
    // the scheduler, not the scan.
    const comm = await waitFor(() => {
      try {
        return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return undefined;
      }
    });
    // RUSH-2508: on some platforms this holder is unclassifiable by the time we
    // can observe it. `ps -o comm=` on Linux reports the THREAD name, and node
    // renames its main thread shortly after boot — measured on Node 24, comm
    // flips to `MainThread` within a second, while Node 22 keeps `claude`. The
    // scan then correctly stops treating the process as an agent, so there is
    // nothing left for this case to assert. Gate on the observed comm rather
    // than on the platform: an environment where comm stays usable (macOS,
    // Windows, Linux on an older node) keeps full coverage, and only the
    // environment that cannot support the case skips, naming why.
    if (!comm || !/^claude/.test(path.basename(comm))) {
      ctx.skip(`ps reports comm='${comm ?? '<unreadable>'}' for the holder, not an agent name — see RUSH-2508`);
      return;
    }

    let rows: Awaited<ReturnType<typeof listUnattributedActive>> = [];
    const hit = await waitFor(async () => {
      clearActiveScanCachesForTest();
      rows = await listUnattributedActive(new Set());
      return rows.find((r) => r.sessionId === UUID || r.pid === pid);
    });
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
