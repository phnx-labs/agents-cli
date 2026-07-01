/**
 * Git operations for the agents-cli system repo and package repositories.
 *
 * Handles cloning, pulling, syncing, and inspecting git repos used by
 * the agents version management and plugin/package system. Includes
 * source parsing for GitHub shorthand, SSH, HTTPS, and local paths.
 */
import simpleGit, { SimpleGit } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import { IS_WINDOWS, isWindowsAbsolutePath } from './platform/index.js';
import { getPackageLocalPath } from './state.js';
import { DEFAULT_SYSTEM_REPO, systemRepoSlug } from './types.js';

/**
 * Validate that a clone/pull source uses a safe git transport before it is
 * handed to `git`.
 *
 * Git's remote-helper transports (`ext::`, `fd::`, …) execute arbitrary
 * commands at clone time, `file://`/`git://` are unauthenticated, and a source
 * beginning with `-` is parsed by `git` as a command-line flag (option
 * injection). We therefore allow only:
 *   - `https://`                         (encrypted + authenticated)
 *   - `ssh://` and SCP-style `git@host:path` / `host:path`
 *   - local filesystem paths (callers handle these before reaching `git clone`)
 *
 * Pure string inspection — no filesystem or platform calls — so it behaves
 * identically on Linux, macOS, and Windows.
 *
 * @throws Error if the source uses a disallowed transport.
 */
export function assertSafeGitTransport(source: string): void {
  const s = source.trim();

  // A leading dash is interpreted by git as an option, not a source.
  if (s.startsWith('-')) {
    throw new Error(
      `Refusing to use git source "${source}": a source starting with "-" is interpreted as a git option.`,
    );
  }

  // Remote-helper transports look like "<name>::…" (ext::, fd::, …). SCP-style
  // "git@host:path" uses a single ":" and is intentionally not matched here.
  const helper = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*::/);
  if (helper) {
    throw new Error(
      `Refusing to use git source "${source}": git remote-helper transports (ext::, fd::, …) are not allowed.`,
    );
  }

  // Explicit "<scheme>://" URLs: permit only https and ssh.
  const scheme = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== 'https' && name !== 'ssh') {
      throw new Error(
        `Refusing to use git source "${source}": "${name}://" is not an allowed transport (use https:// or ssh://).`,
      );
    }
  }
  // No scheme -> SCP-style SSH ("git@host:path") or a local path; both safe.
}

/**
 * Whether installing a cloned/pulled repo's `.githooks/` is enabled.
 *
 * Installing hooks wires those scripts into `.git/hooks/`, so `git` EXECUTES
 * them on the next commit/checkout/merge. A repo added via `agents repo add
 * <source>` is untrusted, so auto-installing its hooks is remote code
 * execution. We require explicit opt-in via `AGENTS_ENABLE_GITHOOKS=1`.
 */
function githooksEnabled(): boolean {
  const v = process.env.AGENTS_ENABLE_GITHOOKS;
  return v === '1' || v === 'true';
}

/**
 * Install hooks from `.githooks/` by symlinking each entry into `.git/hooks/`.
 *
 * Gated behind `AGENTS_ENABLE_GITHOOKS=1` (see {@link githooksEnabled}) because
 * the hooks run code on git operations and the source repo may be untrusted.
 *
 * Why symlinks rather than `git config core.hooksPath`: `core.hooksPath` is a
 * known sandbox-escape vector and is blocked by some sandboxed environments
 * (e.g. Claude Code). Symlinks inside `.git/hooks/` run the same way.
 */
function installGithooksSymlinks(repoDir: string): void {
  const githooksDir = path.join(repoDir, '.githooks');
  if (!fs.existsSync(githooksDir)) return;

  if (!githooksEnabled()) {
    console.error(
      `Skipped installing git hooks from ${githooksDir} (they run code on git operations).\n` +
        `  Set AGENTS_ENABLE_GITHOOKS=1 to enable hooks for repos you trust.`,
    );
    return;
  }

  const hooksDir = path.join(repoDir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  for (const name of fs.readdirSync(githooksDir)) {
    const src = path.join(githooksDir, name);
    if (!fs.statSync(src).isFile()) continue;

    const dest = path.join(hooksDir, name);
    const target = path.join('..', '..', '.githooks', name);

    if (fs.lstatSync(dest, { throwIfNoEntry: false })) {
      fs.rmSync(dest);
    }
    try {
      fs.symlinkSync(target, dest);
    } catch (err) {
      // Windows requires Developer Mode or elevated privileges for symlinks; skip gracefully.
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    }
  }
}

/** Parsed representation of a git source string (GitHub, generic URL, or local path). */
export interface GitSource {
  type: 'github' | 'url' | 'local';
  url: string;
  ref?: string;
}

/**
 * Parse a source string into a GitSource object.
 *
 * Supported formats:
 *   gh:owner/repo                    -> https://github.com/owner/repo.git
 *   gh:owner/repo@branch             -> https://github.com/owner/repo.git (ref: branch)
 *   owner/repo                       -> https://github.com/owner/repo.git
 *   owner/repo@branch                -> https://github.com/owner/repo.git (ref: branch)
 *   github.com/owner/repo            -> https://github.com/owner/repo.git
 *   github.com:owner/repo            -> https://github.com/owner/repo.git
 *   github.com:owner/repo.git        -> https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git    -> https://github.com/owner/repo.git
 *   https://github.com/owner/repo    -> https://github.com/owner/repo.git
 *   https://github.com/owner/repo.git -> https://github.com/owner/repo.git
 *   /path/to/local                   -> local path
 *   ./relative/path                  -> local path
 */
export function parseSource(source: string): GitSource {
  // Split off @ref suffix (but not from URLs with @ in them like git@)
  let ref: string | undefined;
  let cleanSource = source;

  // Handle @ref suffix (only if it's at the end and not part of git@)
  const atIndex = source.lastIndexOf('@');
  if (atIndex > 0 && !source.startsWith('git@') && !source.slice(0, atIndex).includes('://')) {
    // Check if what's after @ looks like a ref (no slashes, no dots except in branch names)
    const possibleRef = source.slice(atIndex + 1);
    if (possibleRef && !possibleRef.includes('/') && !possibleRef.includes(':')) {
      ref = possibleRef;
      cleanSource = source.slice(0, atIndex);
    }
  }

  // gh:owner/repo shorthand
  if (cleanSource.startsWith('gh:')) {
    const repo = cleanSource.slice(3).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // git@github.com:owner/repo.git (SSH URL)
  if (cleanSource.startsWith('git@github.com:')) {
    const repo = cleanSource.slice(15).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // github.com:owner/repo.git (SSH-style without git@)
  if (cleanSource.startsWith('github.com:')) {
    const repo = cleanSource.slice(11).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // github.com/owner/repo (domain without protocol)
  if (cleanSource.startsWith('github.com/')) {
    const repo = cleanSource.slice(11).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // https:// or http:// URLs
  if (cleanSource.startsWith('http://') || cleanSource.startsWith('https://')) {
    // Check if it's a GitHub URL
    const githubMatch = cleanSource.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (githubMatch) {
      return {
        type: 'github',
        url: `https://github.com/${githubMatch[1]}.git`,
        ref: ref || 'main',
      };
    }

    // Generic URL -- must be an encrypted, authenticated transport
    // (rejects http://, file://, git://, ext::, and leading "-").
    assertSafeGitTransport(cleanSource);
    return {
      type: 'url',
      url: cleanSource.endsWith('.git') ? cleanSource : `${cleanSource}.git`,
      ref,
    };
  }

  // Local path (absolute or relative). On Windows also recognize drive-letter
  // (C:\…) and UNC (\\…) roots, which the POSIX prefixes miss.
  if (
    cleanSource.startsWith('/') || cleanSource.startsWith('./') || cleanSource.startsWith('../')
    || (IS_WINDOWS && isWindowsAbsolutePath(cleanSource))
  ) {
    if (fs.existsSync(cleanSource)) {
      return {
        type: 'local',
        url: path.resolve(cleanSource),
      };
    }
  }

  // Check if it exists as a local path (could be a directory name without ./)
  if (fs.existsSync(cleanSource)) {
    return {
      type: 'local',
      url: path.resolve(cleanSource),
    };
  }

  // Bare owner/repo format (assumes GitHub)
  if (cleanSource.includes('/') && !cleanSource.includes(':') && !cleanSource.includes('.')) {
    const repo = cleanSource.replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // Last attempt: treat as GitHub if it looks like owner/repo (with possible .git)
  if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(cleanSource)) {
    const repo = cleanSource.replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  throw new Error(`Invalid source: ${source}. Supported formats: gh:owner/repo, owner/repo, github.com/owner/repo, https://github.com/owner/repo, or local path`);
}

/** Clone a remote repo or pull updates if it already exists locally. */
export async function cloneOrPull(
  source: GitSource,
  targetDir: string
): Promise<{ isNew: boolean; commit: string }> {
  const git: SimpleGit = simpleGit();

  if (source.type === 'local') {
    return { isNew: false, commit: 'local' };
  }

  const exists = fs.existsSync(path.join(targetDir, '.git'));

  if (exists) {
    const repoGit = simpleGit(targetDir);
    await repoGit.fetch();
    if (source.ref) {
      await repoGit.checkout(source.ref);
    }
    await repoGit.pull();
    const log = await repoGit.log({ maxCount: 1 });
    return { isNew: false, commit: log.latest?.hash.slice(0, 8) || 'unknown' };
  }

  assertSafeGitTransport(source.url);
  fs.mkdirSync(targetDir, { recursive: true });
  await git.clone(source.url, targetDir);

  const repoGit = simpleGit(targetDir);
  if (source.ref) {
    await repoGit.checkout(source.ref);
  }
  const log = await repoGit.log({ maxCount: 1 });
  return { isNew: true, commit: log.latest?.hash.slice(0, 8) || 'unknown' };
}

/** Clone a repository from a source string, returning the local path and commit hash. */
export async function cloneRepo(source: string): Promise<{
  localPath: string;
  commit: string;
  isNew: boolean;
}> {
  const parsed = parseSource(source);

  if (parsed.type === 'local') {
    return {
      localPath: parsed.url,
      commit: 'local',
      isNew: false,
    };
  }

  const localPath = getPackageLocalPath(source);
  const result = await cloneOrPull(parsed, localPath);

  return {
    localPath,
    commit: result.commit,
    isNew: result.isNew,
  };
}

/** Clone a package from a source string into the packages directory. */
export async function clonePackage(source: string): Promise<{
  localPath: string;
  commit: string;
  isNew: boolean;
}> {
  const parsed = parseSource(source);

  if (parsed.type === 'local') {
    return {
      localPath: parsed.url,
      commit: 'local',
      isNew: false,
    };
  }

  const localPath = getPackageLocalPath(source);
  const result = await cloneOrPull(parsed, localPath);

  return {
    localPath,
    commit: result.commit,
    isNew: result.isNew,
  };
}

/** Get the short commit hash (8 chars) of the latest commit in a repo. */
export async function getRepoCommit(repoPath: string): Promise<string> {
  try {
    const git = simpleGit(repoPath);
    const log = await git.log({ maxCount: 1 });
    return log.latest?.hash.slice(0, 8) || 'unknown';
  } catch {
    /* not a git repo or no commits */
    return 'unknown';
  }
}

/**
 * Get the current GitHub username using gh CLI.
 * Returns null if gh is not installed or user is not authenticated.
 */
export async function getGitHubUsername(): Promise<string | null> {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    const { stdout } = await execAsync('gh api user --jq ".login"');
    return stdout.trim() || null;
  } catch {
    /* gh CLI not installed or not authenticated */
    return null;
  }
}

/**
 * Get the remote URL for origin in a git repo.
 */
export async function getRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const git = simpleGit(repoPath);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    return origin?.refs?.fetch || origin?.refs?.push || null;
  } catch {
    /* not a git repo or no remotes */
    return null;
  }
}

/**
 * Set the remote URL for origin in a git repo.
 */
export async function setRemoteUrl(repoPath: string, url: string): Promise<void> {
  const git = simpleGit(repoPath);
  const remotes = await git.getRemotes(true);
  const hasOrigin = remotes.some(r => r.name === 'origin');

  if (hasOrigin) {
    await git.remote(['set-url', 'origin', url]);
  } else {
    await git.remote(['add', 'origin', url]);
  }
}

/**
 * Check if a GitHub repo exists.
 */
export async function checkGitHubRepoExists(owner: string, repo: string): Promise<boolean> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('gh', ['repo', 'view', `${owner}/${repo}`, '--json', 'name']);
    return true;
  } catch {
    /* repo not found or gh CLI unavailable */
    return false;
  }
}

/**
 * Commit and push changes in a repo.
 */
export async function commitAndPush(repoPath: string, message: string): Promise<{ success: boolean; error?: string }> {
  try {
    const git = simpleGit(repoPath);

    // Check for changes
    const status = await git.status();
    if (status.files.length === 0) {
      return { success: true }; // Nothing to commit
    }

    // Stage all changes
    await git.add('-A');

    // Commit
    await git.commit(message);

    // Push
    await git.push('origin', 'main');

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Check if repo has uncommitted changes.
 */
export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  try {
    const git = simpleGit(repoPath);
    const status = await git.status();
    return status.files.length > 0;
  } catch {
    /* not a git repo */
    return false;
  }
}

/**
 * Check if a directory is a git repository.
 */
export function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/**
 * Initialize a git repo in an existing directory.
 */
export async function initRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
}

/**
 * Clone a repo into an existing directory (for initializing ~/.agents/).
 * This clones into a temp dir, moves .git, then checks out tracked files.
 */
export async function cloneIntoExisting(
  source: string,
  targetDir: string
): Promise<{ success: boolean; commit: string; error?: string }> {
  const parsed = parseSource(source);
  if (parsed.type === 'local') {
    return { success: false, commit: '', error: 'Cannot clone local source' };
  }

  const git = simpleGit();
  const tempDir = path.join(targetDir, '.git-clone-temp');

  try {
    assertSafeGitTransport(parsed.url);
    // Clone to temp directory
    fs.mkdirSync(tempDir, { recursive: true });
    await git.clone(parsed.url, tempDir);

    const repoGit = simpleGit(tempDir);
    if (parsed.ref) {
      await repoGit.checkout(parsed.ref);
    }

    // Move .git directory to target
    const gitDir = path.join(tempDir, '.git');
    const targetGitDir = path.join(targetDir, '.git');
    if (fs.existsSync(targetGitDir)) {
      fs.rmSync(targetGitDir, { recursive: true });
    }
    fs.renameSync(gitDir, targetGitDir);

    // Clean up temp
    fs.rmSync(tempDir, { recursive: true });

    // Checkout tracked files from git (restores repo files, respects .gitignore)
    const targetGit = simpleGit(targetDir);
    await targetGit.checkout('.');

    installGithooksSymlinks(targetDir);

    const log = await targetGit.log({ maxCount: 1 });

    return {
      success: true,
      commit: log.latest?.hash.slice(0, 8) || 'unknown',
    };
  } catch (err) {
    // Clean up temp on error
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    return { success: false, commit: '', error: (err as Error).message };
  }
}

/**
 * Check if the repo's origin points to the system repo.
 */
export async function isSystemRepoOrigin(dir: string): Promise<boolean> {
  try {
    const git = simpleGit(dir);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    if (!origin?.refs?.fetch) return false;

    const url = origin.refs.fetch.toLowerCase();
    const currentSlug = systemRepoSlug(DEFAULT_SYSTEM_REPO).toLowerCase();
    return url.includes(currentSlug);
  } catch {
    /* not a git repo or no remotes */
    return false;
  }
}

/**
 * Check if repo has uncommitted changes (including untracked files).
 */
export async function hasLocalChanges(dir: string): Promise<boolean> {
  try {
    const git = simpleGit(dir);
    const status = await git.status();
    return !status.isClean();
  } catch {
    /* not a git repo */
    return false;
  }
}

/**
 * Pull changes in an existing repo.
 * Refuses to pull if the working tree is dirty -- user must commit or discard changes first.
 */
export async function pullRepo(dir: string): Promise<{ success: boolean; commit: string; error?: string }> {
  try {
    const git = simpleGit(dir);
    const status = await git.status();

    if (!status.isClean()) {
      return {
        success: false,
        commit: '',
        error: 'Working tree has uncommitted changes. Commit or discard them before pulling.\n\n  cd ~/.agents && git status',
      };
    }

    await git.fetch();
    await git.pull();

    installGithooksSymlinks(dir);

    const log = await git.log({ maxCount: 1 });
    return {
      success: true,
      commit: log.latest?.hash.slice(0, 8) || 'unknown',
    };
  } catch (err) {
    return { success: false, commit: '', error: (err as Error).message };
  }
}

/**
 * Rebase a repo onto its remote, optionally pushing local commits back up.
 *
 * The one-repo counterpart to `pullRepo` used by `agents sync <repo>`:
 *   1. Refuse if the working tree is dirty (commit or discard first).
 *   2. `git fetch origin` then `git pull --rebase origin <branch>` — rebase, not
 *      merge, so a local commit lands cleanly on top of upstream with no merge
 *      bubble.
 *   3. When `push` is set, `git push origin <branch>` to send local commits up.
 *
 * The branch is read from the repo's current HEAD (falls back to `main`) rather
 * than hardcoded. System repos pass `push: false` — they are pull-only mirrors
 * of the npm-shipped upstream.
 */
export async function syncRepoGit(
  dir: string,
  opts: { push: boolean },
): Promise<{ success: boolean; commit: string; pushed: boolean; error?: string }> {
  try {
    if (!isGitRepo(dir)) {
      return { success: false, commit: '', pushed: false, error: `Not a git repo: ${dir}` };
    }
    const git = simpleGit(dir);
    const status = await git.status();

    if (!status.isClean()) {
      return {
        success: false,
        commit: '',
        pushed: false,
        error: `Working tree has uncommitted changes. Commit or discard them first.\n\n  cd ${dir} && git status`,
      };
    }

    const branch = status.current || 'main';
    await git.fetch('origin');
    await git.pull('origin', branch, { '--rebase': 'true' });

    installGithooksSymlinks(dir);

    let pushed = false;
    if (opts.push) {
      await git.push('origin', branch);
      pushed = true;
    }

    const log = await git.log({ maxCount: 1 });
    return { success: true, commit: log.latest?.hash.slice(0, 8) || 'unknown', pushed };
  } catch (err) {
    return { success: false, commit: '', pushed: false, error: (err as Error).message };
  }
}

/**
 * Get git status for sync display.
 * Returns files categorized by their status relative to HEAD.
 */
export interface GitSyncStatus {
  /** Tracked and unchanged files. */
  synced: string[];
  /** Modified but not staged files. */
  modified: string[];
  /** Untracked files. */
  new: string[];
  /** Staged for commit. */
  staged: string[];
  /** Deleted files. */
  deleted: string[];
}

/** Compute the sync status of a git repo, optionally scoped to a subdirectory. */
export async function getGitSyncStatus(dir: string, subdir?: string): Promise<GitSyncStatus | null> {
  if (!isGitRepo(dir)) {
    return null;
  }

  try {
    const git = simpleGit(dir);
    const status = await git.status();

    const result: GitSyncStatus = {
      synced: [],
      modified: [],
      new: [],
      staged: [],
      deleted: [],
    };

    // Filter to subdir if specified
    const filterPath = (file: string) => {
      if (!subdir) return true;
      return file.startsWith(subdir + '/') || file === subdir;
    };

    // Get all tracked files in the subdir
    const trackedOutput = await git.raw(['ls-files', subdir || '.']);
    const trackedFiles = new Set(trackedOutput.split('\n').filter(Boolean));

    // Get untracked files in the subdir
    const untrackedOutput = await git.raw(['ls-files', '--others', '--exclude-standard', subdir || '.']);
    const untrackedFiles = untrackedOutput.split('\n').filter(Boolean);

    // Working tree changes (not staged)
    const changedFiles = new Set<string>();
    for (const file of status.modified.filter(filterPath)) {
      result.modified.push(file);
      changedFiles.add(file);
    }
    for (const file of status.deleted.filter(filterPath)) {
      result.deleted.push(file);
      changedFiles.add(file);
    }

    // Staged changes (in index, ready to commit)
    for (const file of status.created.filter(filterPath)) {
      result.staged.push(file);
      changedFiles.add(file);
    }
    for (const file of status.staged.filter(filterPath)) {
      if (!result.staged.includes(file)) {
        result.staged.push(file);
        changedFiles.add(file);
      }
    }

    // Untracked files (new/local-only)
    for (const file of untrackedFiles.filter(filterPath)) {
      result.new.push(file);
    }

    // Synced = tracked and not changed
    for (const file of trackedFiles) {
      if (filterPath(file) && !changedFiles.has(file)) {
        result.synced.push(file);
      }
    }

    return result;
  } catch {
    /* git status failed */
    return null;
  }
}

/**
 * Get list of files tracked by git in a directory.
 */
export async function getTrackedFiles(dir: string, subdir?: string): Promise<string[]> {
  if (!isGitRepo(dir)) {
    return [];
  }

  try {
    const git = simpleGit(dir);
    const result = await git.raw(['ls-files', subdir || '.']);
    return result.split('\n').filter(Boolean);
  } catch {
    /* git ls-files failed */
    return [];
  }
}

/**
 * Check if upstream remote is configured.
 */
export async function hasUpstreamRemote(dir: string): Promise<boolean> {
  try {
    const git = simpleGit(dir);
    const remotes = await git.getRemotes(true);
    return remotes.some(r => r.name === 'upstream');
  } catch {
    /* not a git repo */
    return false;
  }
}

/**
 * Get the upstream remote fetch URL, or null if none configured.
 */
export async function getUpstreamUrl(dir: string): Promise<string | null> {
  try {
    const git = simpleGit(dir);
    const remotes = await git.getRemotes(true);
    const upstream = remotes.find(r => r.name === 'upstream');
    return upstream?.refs?.fetch ?? null;
  } catch {
    return null;
  }
}

/**
 * Add or update the upstream remote.
 */
export async function setUpstreamRemote(dir: string, url: string): Promise<void> {
  const git = simpleGit(dir);
  const remotes = await git.getRemotes(true);
  const hasUpstream = remotes.some(r => r.name === 'upstream');

  if (hasUpstream) {
    await git.remote(['set-url', 'upstream', url]);
  } else {
    await git.remote(['add', 'upstream', url]);
  }
}

/**
 * Pull from upstream remote (merge updates from system repo).
 */
export async function pullFromUpstream(dir: string): Promise<{ success: boolean; commit: string; error?: string }> {
  try {
    const git = simpleGit(dir);

    // Check if upstream exists
    const remotes = await git.getRemotes(true);
    const upstream = remotes.find(r => r.name === 'upstream');
    if (!upstream) {
      return { success: false, commit: '', error: 'No upstream remote configured. Run `agents fork` first.' };
    }

    // Fetch and merge from upstream
    await git.fetch('upstream');
    await git.merge(['upstream/main']);

    const log = await git.log({ maxCount: 1 });
    return {
      success: true,
      commit: log.latest?.hash.slice(0, 8) || 'unknown',
    };
  } catch (err) {
    return { success: false, commit: '', error: (err as Error).message };
  }
}

/**
 * Try to auto-pull a git repo if it's clean and has a remote.
 * Uses --ff-only for safety (fails if diverged instead of creating merge commits).
 * Returns silently on success, returns error message on failure.
 */
export async function tryAutoPull(dir: string): Promise<{ pulled: boolean; error?: string }> {
  // Must be a git repo
  if (!isGitRepo(dir)) {
    return { pulled: false };
  }

  try {
    const git = simpleGit(dir);

    // Must have origin remote
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    if (!origin?.refs?.fetch) {
      return { pulled: false };
    }

    // Must be clean (no uncommitted changes)
    const status = await git.status();
    if (!status.isClean()) {
      return { pulled: false, error: 'Has local changes' };
    }

    // Fetch and try fast-forward pull
    await git.fetch('origin');

    // Check if we're behind
    const localRef = await git.revparse(['HEAD']);
    const trackingBranch = status.tracking;
    if (!trackingBranch) {
      return { pulled: false };
    }

    const remoteRef = await git.revparse([trackingBranch]).catch(() => null /* remote ref unavailable */);
    if (!remoteRef || localRef === remoteRef) {
      // Already up to date
      return { pulled: false };
    }

    // Try fast-forward only pull
    await git.pull(['--ff-only']);

    return { pulled: true };
  } catch (err) {
    return { pulled: false, error: (err as Error).message };
  }
}
