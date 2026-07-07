// End-to-end panel/floor snapshot broadcast (no mocks).
//
// A real MonitorHost with the snapshot detector enabled, two real
// MonitorFollowers over a real Unix socket, and a real temp git repo. Proves
// the #71 acceptance: BOTH windows arm the same workspace root, the leader runs
// ONE set of git subprocesses, and broadcasts a single `panel-snapshot` fact
// both followers render from — N visible panels, one set of subprocesses.

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MonitorHost } from './host';
import { MonitorFollower } from './follower';
import { isPanelSnapshot, PanelSnapshotPayload, SnapshotWatch } from './protocol';
import { MonitorEvent } from './broadcastTypes';

const tmpPaths: string[] = [];
let counter = 0;

function tempSocketPath(): string {
  const p = path.join(os.tmpdir(), `snap-rb-${process.pid}-${counter++}.sock`);
  tmpPaths.push(p);
  return p;
}

function realRepo(): string {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-rb-repo-'));
  tmpPaths.push(raw);
  // macOS symlinks $TMPDIR; realpath so git's worktree paths match path.resolve.
  const dir = fs.realpathSync(raw);
  const git = (args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t.dev', '-c', 'user.name=t', ...args], { cwd: dir });
  git(['init', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(['add', 'a.txt']);
  git(['commit', '-m', 'init']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  return dir;
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

afterEach(() => {
  for (const p of tmpPaths.splice(0)) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

describe('panel snapshot broadcast round-trip', () => {
  test('two windows arm the same root; the leader computes git once and both followers render it', async () => {
    const socketPath = tempSocketPath();
    const repo = realRepo();

    const host = new MonitorHost({
      socketPath,
      detectors: {
        readiness: false,
        session: false,
        watchdog: false,
        // Tick fast; no teams fetcher injected, no agentType armed -> git/worktrees only.
        snapshotTickMs: 50,
      },
    });
    await host.start();

    const factsA: PanelSnapshotPayload[] = [];
    const factsB: PanelSnapshotPayload[] = [];

    const followerA = new MonitorFollower<string>({
      windowId: 'winA',
      socketPath,
      clientOptions: { minReconnectDelayMs: 25, maxReconnectDelayMs: 100 },
      resolver: () => undefined, // panel snapshot is consumed by type, not tuple resolution
    });
    const followerB = new MonitorFollower<string>({
      windowId: 'winB',
      socketPath,
      clientOptions: { minReconnectDelayMs: 25, maxReconnectDelayMs: 100 },
      resolver: () => undefined,
    });
    const subA = followerA.onMonitorEvent((e: MonitorEvent) => {
      if (isPanelSnapshot(e)) factsA.push(e.payload);
    });
    const subB = followerB.onMonitorEvent((e: MonitorEvent) => {
      if (isPanelSnapshot(e)) factsB.push(e.payload);
    });

    try {
      followerA.start();
      followerB.start();
      await waitFor(
        () => followerA.connected && followerB.connected && host.clientCount === 2,
        5000,
        'both followers connected',
      );

      // Both visible panels arm the SAME workspace root.
      const watch: SnapshotWatch = { workspaceRoot: repo, cwd: repo };
      expect(await followerA.setSnapshotWatches([watch])).toBe(true);
      expect(await followerB.setSnapshotWatches([watch])).toBe(true);
      // Two windows, one distinct (root, cwd) tuple -> one computation.
      await waitFor(() => host.watchedSnapshotKeyCount === 1, 2000, 'leader merged the watches to one tuple');

      // The leader's single detector computes git once and broadcasts to BOTH.
      await waitFor(
        () => factsA.some((f) => f.gitByRoot[repo]) && factsB.some((f) => f.gitByRoot[repo]),
        4000,
        'panel-snapshot fact reached both followers',
      );

      const factA = factsA.find((f) => f.gitByRoot[repo])!;
      // Real git output: branch + the 1-line addition to a.txt.
      expect(factA.gitByRoot[repo].branch).toBe('main');
      expect(factA.gitByRoot[repo].numstat['a.txt']).toEqual({ added: 1, removed: 0 });
      // Worktrees came from the same one computation.
      expect(factA.worktreesByRoot[repo].some((w) => w.isMain)).toBe(true);
      // No agent armed and no teams fetcher injected -> those maps stay empty.
      expect(Object.keys(factA.usageByAgent)).toHaveLength(0);
      expect(Object.keys(factA.teamsByCwd)).toHaveLength(0);

      // Both followers rendered the same broadcast.
      const factB = factsB.find((f) => f.gitByRoot[repo])!;
      expect(factB.gitByRoot[repo].branch).toBe('main');
    } finally {
      subA();
      subB();
      followerA.stop();
      followerB.stop();
      await host.stop();
    }
  }, 12000);
});
