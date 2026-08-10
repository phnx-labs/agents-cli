// Pure helpers used by the agent panel webview. Kept free of `vscode` imports
// so they can be unit-tested with `bun test` without an extension host.

export interface PullRequestRef {
  url: string;
  ownerRepo: string;
  number: number;
}

const PR_URL_RE = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

/**
 * Find every PR URL in the supplied transcript lines, deduped by `<repo>#<num>`
 * to collapse "URL was logged 5 times" noise while preserving the order the
 * URLs first appeared (oldest first → newest last in the conversation).
 *
 * The canonical URL is rewritten to drop `www.` and force `https` so two
 * occurrences that differ only in those don't show up as distinct PRs.
 */
export function extractPrUrls(lines: string[]): PullRequestRef[] {
  const seen = new Set<string>();
  const out: PullRequestRef[] = [];
  for (const line of lines) {
    if (!line) continue;
    PR_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PR_URL_RE.exec(line)) !== null) {
      const ownerRepo = m[1];
      const num = Number(m[2]);
      const dedupeKey = `${ownerRepo}#${num}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        url: `https://github.com/${ownerRepo}/pull/${num}`,
        ownerRepo,
        number: num,
      });
    }
  }
  return out;
}

export interface WorktreeRef {
  path: string;
  name: string;
  branch?: string;
  isActive: boolean;
  isMain: boolean;
}

/**
 * Parse the output of `git worktree list --porcelain` into a list. Records are
 * separated by blank lines; each record starts with `worktree <abs path>` and
 * may include `HEAD <sha>`, `branch refs/heads/<name>`, or `detached`.
 *
 * `activePath` is the focused terminal's cwd (already path.resolve'd) so the
 * matching entry is flagged `isActive`. `mainPath` is the workspace's main
 * checkout (already path.resolve'd) so it's flagged `isMain`. Both are passed
 * in rather than computed here so this stays free of `path`/`fs` and OS quirks.
 */
export function parseWorktreeListPorcelain(
  stdout: string,
  activePath: string | undefined,
  mainPath: string,
  basename: (p: string) => string,
  resolve: (p: string) => string,
): WorktreeRef[] {
  const out: WorktreeRef[] = [];
  // Tolerate CRLF line endings — git on Windows uses `\r\n\r\n` between
  // porcelain records and the LF-only split would coalesce every record
  // into one block, losing all but the first worktree.
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    // Same tolerance within a block: strip trailing \r before filtering.
    const lines = block.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
    if (!lines.length) continue;
    let wtPath: string | undefined;
    let branch: string | undefined;
    let detached = false;
    for (const line of lines) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim();
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      else if (line === 'detached') detached = true;
    }
    if (!wtPath) continue;
    const resolved = resolve(wtPath);
    out.push({
      path: resolved,
      name: basename(resolved),
      branch: detached ? undefined : branch,
      isActive: activePath ? resolved === activePath : false,
      isMain: resolved === mainPath,
    });
  }
  return out;
}
