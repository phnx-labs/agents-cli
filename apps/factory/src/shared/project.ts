// Shared project/host resolution — the SINGLE source of truth for mapping a
// session cwd to a display project, imported by BOTH the extension host (src/*)
// and the webview (ui/* via `@shared`). These were previously hand-duplicated in
// src/core/remoteSessions.ts AND ui/.../floorModel.ts ("keep the two in lockstep"
// comments) — the drift that makes a session's project resolve differently on
// each side. One impl, no lockstep. Pure functions, no vscode/node imports.

/** Ordered cwd->project mapping for Factory Floor grouping. */
export interface ProjectRule {
  pattern: string;
  project: string;
}

/** Glob -> RegExp. `**` spans path separators, `*` does not, `?` a single char.
 *  A trailing subpath always matches so a rule for a dir captures work inside it. */
function projectGlobToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '(?:/.*)?$');
}

/** A rule pattern with no glob metacharacters is a path prefix; else a glob. */
function matchesProjectRule(cwd: string, pattern: string): boolean {
  const p = pattern.trim().replace(/\/+$/, '');
  if (!p) return false;
  if (!/[*?]/.test(p)) return cwd === p || cwd.startsWith(p + '/');
  return projectGlobToRegExp(p).test(cwd);
}

function pathBasename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

/** The `<slug>` under `.agents/worktrees/<slug>/`, or '' when the cwd isn't a
 *  worktree. This is the strong per-session disambiguator (two agents in sibling
 *  worktrees of the same repo differ only by slug) — surfaced on the card even
 *  though resolveProject folds it away to the repo name. */
export function worktreeSlugOf(cwd: string | null | undefined): string {
  if (!cwd) return '';
  const m = cwd.match(/\/\.agents\/worktrees\/([^/]+)/);
  return m ? m[1] : '';
}

/**
 * Resolve a session cwd to a display project. Order:
 *   1. user rules (first match wins) — glob or path-prefix against the cwd.
 *   2. worktree fold: `.../<repo>/.agents/worktrees/<slug>` -> `<repo>`.
 *   3. git repo root basename when `repoRoot` is supplied — so a monorepo subdir
 *      folds to the repo, not the leaf dir.
 *   4. ultimate fallback: the cwd's last path segment (legacy behavior).
 */
export function resolveProject(
  cwd: string,
  rules: ProjectRule[] = [],
  repoRoot?: string | null,
): string {
  if (!cwd) return '';
  const norm = cwd.replace(/\/+$/, '');
  for (const rule of rules) {
    if (rule && matchesProjectRule(norm, rule.pattern)) return rule.project;
  }
  const wt = norm.match(/\/([^/]+)\/\.agents\/worktrees\//);
  if (wt) return wt[1];
  if (repoRoot) {
    const base = pathBasename(repoRoot);
    if (base) return base;
  }
  const parts = norm.split('/').filter(Boolean);
  return parts[parts.length - 1] || norm;
}

/** Canonicalize a host name to its device label: 'mac-mini', 'ZION', a FQDN all
 *  fold onto the registry device id. */
export function normalizeHost(raw: string): string {
  return (raw || '')
    .split('.')[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
