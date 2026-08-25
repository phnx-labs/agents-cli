/**
 * Where a project's work actually went, from the local git history.
 *
 * The card can say how many agents are running and how many PRs merged, but not
 * *what was worked on*. That answer is already sitting in the checkout — every
 * merged commit names the files it touched — so it costs no API call, no
 * credential, and no rate-limit budget. Measured at 0.23s on this repo's own
 * 7-day window (897 commits), which is why it runs unconditionally rather than
 * behind a flag.
 *
 * Deliberately NOT from `gh`: the GitHub API would spend a request per PR to
 * learn what `git log --name-only` already knows locally, and it would be wrong
 * on a monorepo whose interesting unit is a subdirectory rather than a repo.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** One directory and how many file-touches landed in it during the window. */
export interface FocusArea {
  path: string;
  touches: number;
}

/** How deep a bucket goes: `apps/cli/src`, not `apps` and not every leaf file. */
const DEPTH = 3;
/** Areas shown on the card before the tail is dropped. */
export const FOCUS_LIMIT = 4;

/**
 * Paths whose churn is process, not engineering.
 *
 * This repo files one changelog fragment per PR, so `.changelog` ranks second by
 * raw file-touches — presenting it as an "area of focus" would read as a signal
 * while measuring nothing but the number of PRs. Same for the generated
 * CHANGELOG and lockfiles.
 */
const NOISE = /(^|\/)(\.changelog|CHANGELOG\.md|bun\.lock|package-lock\.json|yarn\.lock)(\/|$)/;

/**
 * Bucket a file path to its area. Files shallower than {@link DEPTH} bucket to
 * their own directory, so a repo-root `README.md` does not vanish.
 */
export function focusBucket(file: string): string | undefined {
  if (NOISE.test(file)) return undefined;
  const parts = file.split('/').filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return parts.slice(0, Math.min(DEPTH, parts.length - 1)).join('/');
}

/**
 * Rank areas by file-touches, descending, ties broken by path so the order is
 * stable across runs. Pure — the caller supplies the file list, so this is
 * testable without a git repo.
 */
export function rankFocusAreas(files: string[], limit = FOCUS_LIMIT): FocusArea[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const bucket = focusBucket(f.trim());
    if (!bucket) continue;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, touches]) => ({ path, touches }))
    .sort((a, b) => b.touches - a.touches || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, limit));
}

/**
 * Read the window's changed files from a checkout. Best-effort in the same shape
 * as the rest of the card's enrichment: a missing checkout, a shallow clone, or
 * a repo with no commits in the window yields an empty list, never a throw.
 *
 * Reads the LOCAL default branch ref rather than fetching — a status command
 * must not mutate the repo it is describing, so the answer is only as fresh as
 * the user's last fetch, which is the correct trade for a read-only card.
 */
export async function readFocusAreas(root: string, windowDays: number): Promise<FocusArea[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'log', `--since=${windowDays} days ago`, '--name-only', '--pretty=format:'],
      { timeout: 5000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    return rankFocusAreas(stdout.split('\n').filter((l) => l.trim().length > 0));
  } catch {
    return [];
  }
}

/** Compact count: 2329 → "2.3k", under 1000 stays exact. */
export function formatFocusCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  const s = k >= 10 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '');
  return `${s}k`;
}

/**
 * One scannable focus line: path + count, with a single unit trailer so the
 * bare integer is never mistaken for commits or minutes.
 *
 *   apps/cli/src 2.3k  ·  apps/cli/docs 302  ·  apps/ext/src 245  file-touches (7d)
 */
export function formatFocusAreas(areas: FocusArea[], windowDays: number): string {
  if (areas.length === 0) return '';
  const body = areas.map((a) => `${a.path} ${formatFocusCount(a.touches)}`).join('  ·  ');
  const unit = `file-touches (${windowDays}d)`;
  return `${body}  ${unit}`;
}

