import { execFile } from 'node:child_process';

export type SyncState = 'in-sync' | 'behind' | 'ahead' | 'diverged' | 'dirty' | 'missing' | 'unknown';

export interface RepoSyncStatus {
  root: string;
  state: SyncState;
  ahead: number;
  behind: number;
  dirty: boolean;
  defaultBranch: string;
}

export function classifySync(x: { ahead: number; behind: number; dirty: boolean }): SyncState {
  if (x.dirty) return 'dirty';
  if (x.ahead > 0 && x.behind > 0) return 'diverged';
  if (x.behind > 0) return 'behind';
  if (x.ahead > 0) return 'ahead';
  return 'in-sync';
}

function runGit(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout.toString());
    });
  });
}

export async function getSyncStatus(
  root: string,
  opts: { fetch?: boolean } = {}
): Promise<RepoSyncStatus> {
  const unknown: RepoSyncStatus = {
    root,
    state: 'unknown',
    ahead: 0,
    behind: 0,
    dirty: false,
    defaultBranch: '',
  };

  let defaultBranch: string;
  try {
    const ref = (await runGit(root, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim();
    // refs/remotes/origin/<branch> -> <branch>
    defaultBranch = ref.replace(/^refs\/remotes\/origin\//, '');
    if (!defaultBranch || defaultBranch === ref) return unknown;
  } catch {
    return unknown;
  }

  if (opts.fetch) {
    try {
      await runGit(root, ['fetch', 'origin']);
    } catch {
      // Non-fatal: fall through with whatever local knows about origin.
    }
  }

  let ahead = 0;
  let behind = 0;
  try {
    // left-right: left = origin (behind), right = HEAD (ahead)
    const out = (
      await runGit(root, [
        'rev-list',
        '--left-right',
        '--count',
        `origin/${defaultBranch}...HEAD`,
      ])
    ).trim();
    const parts = out.split(/\s+/);
    behind = Number.parseInt(parts[0] ?? '0', 10) || 0;
    ahead = Number.parseInt(parts[1] ?? '0', 10) || 0;
  } catch {
    return { ...unknown, defaultBranch };
  }

  let dirty = false;
  try {
    const status = await runGit(root, ['status', '--porcelain']);
    dirty = status.trim().length > 0;
  } catch {
    return { ...unknown, defaultBranch };
  }

  return {
    root,
    state: classifySync({ ahead, behind, dirty }),
    ahead,
    behind,
    dirty,
    defaultBranch,
  };
}
