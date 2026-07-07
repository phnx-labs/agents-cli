// SnapshotDetector — real-git + injected-fetcher tests (no mocks).
//
// `fetchGitInfo`/`fetchWorktrees` are exercised against a REAL temp git repo
// (the canonical compute the leader and the local fallback both use). The
// detector's merge + emit + IN-FLIGHT GUARD logic is driven through injected
// real fetchers (the same DI the WatchdogDetector test uses for `agents view`),
// so the test never depends on the `agents` binary.

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SnapshotDetector, fetchGitInfo, fetchWorktrees } from './snapshotDetector';
import { PanelSnapshotPayload } from './protocol';

const tmpDirs: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t.dev', '-c', 'user.name=t', ...args], { cwd });
}

// A real git repo with one committed file, then `a.txt` grown by two lines so
// `git diff --numstat HEAD` reports a deterministic 2/0.
function realRepoWithDirtyFile(): string {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-git-'));
  tmpDirs.push(raw);
  // macOS symlinks $TMPDIR (/var -> /private/var); git emits the real path while
  // path.resolve won't follow symlinks, so realpath the dir to match.
  const dir = fs.realpathSync(raw);
  git(dir, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-m', 'init']);
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n2\n3\n');
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

describe('fetchGitInfo (canonical git compute)', () => {
  test('reads the branch and numstat from a real repo', async () => {
    const repo = realRepoWithDirtyFile();
    const info = await fetchGitInfo(repo);
    expect(info.branch).toBe('main');
    // numstat is keyed by both the relative and the resolved absolute path.
    expect(info.numstat['a.txt']).toEqual({ added: 2, removed: 0 });
    expect(info.numstat[path.resolve(repo, 'a.txt')]).toEqual({ added: 2, removed: 0 });
  });

  test('fetchGitInfo returns empty numstat for a non-repo, never throws', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-nogit-'));
    tmpDirs.push(dir);
    const info = await fetchGitInfo(dir);
    expect(info.branch).toBeNull();
    expect(info.numstat).toEqual({});
  });

  test('fetchWorktrees lists the main checkout of a real repo', async () => {
    const repo = realRepoWithDirtyFile();
    const wts = await fetchWorktrees(repo, repo);
    expect(wts.length).toBeGreaterThanOrEqual(1);
    const main = wts.find((w) => w.isMain);
    expect(main).toBeDefined();
    expect(main!.isActive).toBe(true);
  });
});

describe('SnapshotDetector', () => {
  test('computes one merged fact across windows — one git fetch per distinct root', async () => {
    const emitted: PanelSnapshotPayload[] = [];
    const gitCalls: string[] = [];
    const usageCalls: string[] = [];
    const detector = new SnapshotDetector({
      emit: (f) => emitted.push(f),
      fetchGit: async (root) => {
        gitCalls.push(root);
        return { branch: `branch-${root}`, numstat: {} };
      },
      fetchWorktrees: async () => [],
      fetchUsage: async (agentType) => {
        usageCalls.push(agentType);
        return { agent: agentType, versions: [] };
      },
      now: () => 123,
    });
    try {
      // Two windows watching the SAME workspace root — the acceptance case:
      // N visible panels must collapse to ONE git fetch, not N.
      detector.setWatches('winA', [{ workspaceRoot: '/repo1', cwd: '/repo1', agentType: 'claude' }]);
      detector.setWatches('winB', [{ workspaceRoot: '/repo1' }]);
      expect(detector.watchedKeyCount).toBe(2); // two distinct tuples...

      await detector.tick();

      expect(emitted).toHaveLength(1);
      expect(gitCalls).toEqual(['/repo1']); // ...but ONE git fetch for the shared root
      expect(usageCalls).toEqual(['claude']);
      expect(emitted[0].gitByRoot['/repo1'].branch).toBe('branch-/repo1');
      expect(emitted[0].usageByAgent['claude'].agent).toBe('claude');
      expect(emitted[0].ts).toBe(123);
    } finally {
      detector.stop();
    }
  });

  test('emits nothing when no window has armed a watch', async () => {
    const emitted: PanelSnapshotPayload[] = [];
    const detector = new SnapshotDetector({
      emit: (f) => emitted.push(f),
      fetchGit: async () => ({ branch: null, numstat: {} }),
      fetchWorktrees: async () => [],
      fetchUsage: async () => null,
    });
    try {
      await detector.tick();
      expect(emitted).toHaveLength(0);
    } finally {
      detector.stop();
    }
  });

  test('in-flight guard prevents a second concurrent recomputation', async () => {
    let gitCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const emitted: PanelSnapshotPayload[] = [];
    const detector = new SnapshotDetector({
      emit: (f) => emitted.push(f),
      fetchGit: async () => {
        gitCalls++;
        await gate; // hold the first tick open
        return { branch: null, numstat: {} };
      },
      fetchWorktrees: async () => [],
      fetchUsage: async () => null,
    });
    try {
      detector.setWatches('winA', [{ workspaceRoot: '/r' }]);

      const first = detector.tick();
      const second = detector.tick(); // must be dropped while the first is in flight

      // The second tick returned without starting a new computation.
      expect(gitCalls).toBe(1);

      release();
      await Promise.all([first, second]);

      // Still exactly one computation + one emission — no stacking.
      expect(gitCalls).toBe(1);
      expect(emitted).toHaveLength(1);
    } finally {
      detector.stop();
    }
  });
});
