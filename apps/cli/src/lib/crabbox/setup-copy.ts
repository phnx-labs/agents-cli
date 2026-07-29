/**
 * Setup-copy for `agents run --lease` (RUSH-1920), transport = PUSH-FROM-LOCAL.
 *
 * A fresh crabbox box has agents-cli installed but none of the caller's own
 * `~/.agents` config (skills, hooks, commands, MCP, profiles). This module
 * replicates the *git-tracked* subset of the LOCAL `~/.agents` onto the box:
 *
 *   1. `git -C <userAgentsDir> ls-files` — tracked files only. Tracked-only is
 *      the safety boundary: it excludes `.history/`, `.cache/`, `.system/` and
 *      any keychain-backed secrets by construction (those are gitignored), so no
 *      credential material is ever pushed.
 *   2. `rsync` that exact file set over ssh to `~/.agents` on the box (crabbox
 *      user, port 2222; the same hardened `SSH_OPTS` baseline the rest of the CLI
 *      uses for fresh hosts).
 *   3. `agents repo refresh` on the box so the copied config takes effect.
 *
 * NEVER copies `~/.claude` / `~/.claude.json` — they live in `$HOME`, not
 * `~/.agents`, and are rebuilt on the box by `agents add` + refresh; an explicit
 * filter belts-and-braces the tracked-only guarantee.
 *
 * This is a self-contained local function the command layer calls; it does NOT
 * ride the box-side bootstrap script (that only echoes the `copy-setup` progress
 * sentinel — see `buildBootstrapScript`).
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getUserAgentsDir } from '../state.js';
import { SSH_OPTS } from '../ssh-exec.js';
import { crabboxEnv } from './cli.js';

/** Default ssh user on a crabbox box. */
export const CRABBOX_SSH_USER = 'crabbox';
/** Default ssh port crabbox exposes. */
export const CRABBOX_SSH_PORT = 2222;
/** Remote path (relative to the box user's home) the tracked config lands in. */
export const REMOTE_AGENTS_DIR = '.agents/';

/** Top-level paths that must never be pushed, even if somehow tracked. */
const NEVER_COPY = new Set(['.claude', '.claude.json']);

/** The crabbox ssh endpoint to push to. */
export interface CopySetupTarget {
  /** Box host to ssh into — public IPv4, or the tailnet IP/FQDN. */
  host: string;
  /** SSH user (default `crabbox`). */
  user?: string;
  /** SSH port (default `2222`). */
  port?: number;
}

export interface CopySetupOptions extends CopySetupTarget {
  /** Secrets bundle whose env the ssh/rsync children inherit (crabbox parity). */
  secretsBundle?: string;
  /** Override the local `~/.agents` dir (defaults to `getUserAgentsDir()`). */
  userAgentsDir?: string;
  /** Receives combined stdout/stderr of the rsync + refresh, if set. */
  onData?: (chunk: string) => void;
}

export interface CopySetupResult {
  /** The tracked files enumerated for the push (post-exclusion). */
  files: string[];
  /** rsync exit code, or null when the process failed to spawn. */
  pushExitCode: number | null;
  /** `agents repo refresh` exit code, or null when it was skipped/failed to spawn. */
  refreshExitCode: number | null;
}

/**
 * git-tracked files under `dir` (paths relative to `dir`), minus the never-copy
 * set. Returns `[]` when `dir` is not a git repo — a caller with no tracked
 * `~/.agents` simply copies nothing.
 */
export function enumerateTrackedFiles(dir: string): string[] {
  const r = spawnSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf-8' });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split('\0')
    .filter(Boolean)
    .filter((f) => {
      const top = f.split('/')[0];
      return !NEVER_COPY.has(f) && !NEVER_COPY.has(top);
    });
}

/** The ssh connection args for a crabbox box (hardened baseline + port). */
export function buildSetupSshArgs(target: CopySetupTarget, remoteCmd: string): string[] {
  const user = target.user ?? CRABBOX_SSH_USER;
  const port = target.port ?? CRABBOX_SSH_PORT;
  return [...SSH_OPTS, '-p', String(port), `${user}@${target.host}`, 'bash', '-lc', remoteCmd];
}

/**
 * rsync argv to push the tracked file set to `~/.agents` on the box. Reads the
 * NUL-separated list at `filesFrom` (`--from0`, matching `ls-files -z`) so paths
 * with spaces survive, and tunnels over the hardened ssh baseline.
 */
export function buildSetupRsyncArgs(opts: {
  target: CopySetupTarget;
  filesFrom: string;
  source: string;
  remoteDir?: string;
}): string[] {
  const user = opts.target.user ?? CRABBOX_SSH_USER;
  const port = opts.target.port ?? CRABBOX_SSH_PORT;
  const sshCmd = ['ssh', ...SSH_OPTS, '-p', String(port)].join(' ');
  const remote = `${user}@${opts.target.host}:${opts.remoteDir ?? REMOTE_AGENTS_DIR}`;
  const source = opts.source.endsWith('/') ? opts.source : `${opts.source}/`;
  return ['-az', '--files-from', opts.filesFrom, '--from0', '-e', sshCmd, source, remote];
}

function runStreaming(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  onData?: (chunk: string) => void,
): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const pump = (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      if (onData) onData(s);
      else process.stdout.write(s);
    };
    proc.stdout.on('data', pump);
    proc.stderr.on('data', pump);
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => resolve(code));
  });
}

/**
 * Replicate the git-tracked subset of the local `~/.agents` onto the crabbox box
 * and refresh it. Enumerates tracked files, rsyncs them over ssh, then runs
 * `agents repo refresh` on the box. Refresh is skipped when the push fails or the
 * file set is empty (nothing to refresh). Never throws — surfaces failure through
 * the returned exit codes.
 */
export async function copySetupToBox(opts: CopySetupOptions): Promise<CopySetupResult> {
  const dir = opts.userAgentsDir ?? getUserAgentsDir();
  const files = enumerateTrackedFiles(dir);
  if (files.length === 0) {
    return { files, pushExitCode: null, refreshExitCode: null };
  }

  const env = crabboxEnv({ secretsBundle: opts.secretsBundle });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-setup-copy-'));
  const listPath = path.join(tmp, 'files.lst');
  try {
    // NUL-separated list, matching `buildSetupRsyncArgs`'s `--from0`.
    fs.writeFileSync(listPath, files.join('\0'), 'utf-8');
    const rsyncArgs = buildSetupRsyncArgs({ target: opts, filesFrom: listPath, source: dir });
    const pushExitCode = await runStreaming('rsync', rsyncArgs, env, opts.onData);

    let refreshExitCode: number | null = null;
    if (pushExitCode === 0) {
      const sshArgs = buildSetupSshArgs(opts, 'agents repo refresh');
      refreshExitCode = await runStreaming('ssh', sshArgs, env, opts.onData);
    }
    return { files, pushExitCode, refreshExitCode };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
