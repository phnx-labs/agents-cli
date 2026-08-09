/**
 * Detached `agents pr land` — a durable PR waiter that outlives its launcher.
 *
 * RUSH-2394: a headless agent that backgrounds `gh pr checks --watch` strands
 * its own PR. That child is in the agent's process tree, so it dies when the
 * agent exits. The lander here is spawned with `detached: true` into its own
 * process group, records a pid+log under ~/.agents/.history/pr-land/, and is
 * the only watcher the stop gate should accept as a PR handoff.
 *
 * This module is pure spawn + state bookkeeping. The land loop itself lives in
 * commands/pr.ts and re-enters foreground when not passed --detach.
 */
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { getHistoryDir } from './state.js';
import { getCliLaunch } from './cli-entry.js';
import { backgroundSpawnOptions, isAlive } from './platform/process.js';
import { atomicWriteFileSync } from './fs-atomic.js';

const execFileAsyncDefault = promisify(execFile);

/** On-disk record for one detached lander. */
export interface PrLandState {
  /** PR number (or full URL when the launcher only had a URL). */
  pr: string;
  /** Resolved GitHub PR URL when known. */
  prUrl?: string;
  /** Child process id of the detached lander. */
  pid: number;
  /** Absolute path to the lander's combined stdout/stderr log. */
  logPath: string;
  /** Absolute path to this state file. */
  statePath: string;
  /** ISO timestamp when the lander was started. */
  startedAt: string;
  /** cwd the lander was launched from (for `gh` repo context). */
  cwd: string;
  /** Optional flags the lander was started with. */
  flags?: {
    interval?: number;
    skipReview?: boolean;
    deleteBranch?: boolean;
  };
}

/** Root for all detached PR-land state: ~/.agents/.history/pr-land/. */
export function getPrLandHistoryDir(historyDir: string = getHistoryDir()): string {
  return path.join(historyDir, 'pr-land');
}

/**
 * Stable slug for a PR ref (number or URL). Used as the per-PR state directory
 * so a second `agents pr land --detach` for the same PR can detect an incumbent.
 */
export function prLandSlug(pr: string): string {
  const trimmed = pr.trim();
  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (urlMatch) {
    return `${urlMatch[1]}__${urlMatch[2]}__${urlMatch[3]}`.toLowerCase();
  }
  // Bare number or other ref: keep only safe path segments.
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'pr';
}

export function prLandStateDir(pr: string, historyDir?: string): string {
  return path.join(getPrLandHistoryDir(historyDir), prLandSlug(pr));
}

export function prLandStatePath(pr: string, historyDir?: string): string {
  return path.join(prLandStateDir(pr, historyDir), 'state.json');
}

export function prLandLogPath(pr: string, historyDir?: string): string {
  return path.join(prLandStateDir(pr, historyDir), 'land.log');
}

/** Read a lander state file, or null if absent/unreadable/malformed. */
export function readPrLandState(statePath: string): PrLandState | null {
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PrLandState>;
    if (!parsed || typeof parsed.pid !== 'number' || !parsed.pr) return null;
    return {
      pr: String(parsed.pr),
      prUrl: parsed.prUrl ? String(parsed.prUrl) : undefined,
      pid: parsed.pid,
      logPath: String(parsed.logPath ?? ''),
      statePath: String(parsed.statePath ?? statePath),
      startedAt: String(parsed.startedAt ?? ''),
      cwd: String(parsed.cwd ?? ''),
      flags: parsed.flags,
    };
  } catch {
    return null;
  }
}

/** Persist lander state atomically. */
export function writePrLandState(state: PrLandState): void {
  fs.mkdirSync(path.dirname(state.statePath), { recursive: true });
  atomicWriteFileSync(state.statePath, JSON.stringify(state, null, 2) + '\n');
}

/**
 * True when a recorded lander pid is still alive. A missing or unreadable
 * state, or a dead pid, is not a durable handoff.
 */
export function isPrLandAlive(state: PrLandState | null): boolean {
  if (!state || !state.pid || state.pid <= 0) return false;
  return isAlive(state.pid);
}

/** Look up an alive lander for this PR (by number or URL), or null. */
export function findAlivePrLander(pr: string, historyDir?: string): PrLandState | null {
  const state = readPrLandState(prLandStatePath(pr, historyDir));
  return isPrLandAlive(state) ? state : null;
}

export interface DetachPrLandOptions {
  /** PR number or URL (same as `agents pr land <pr>`). */
  pr: string;
  /** Working directory the lander should use (repo checkout). */
  cwd?: string;
  /** Seconds between polls (forwarded as --interval). */
  interval?: number;
  /** Forward --skip-review. */
  skipReview?: boolean;
  /** Forward --no-delete-branch when false. */
  deleteBranch?: boolean;
  /** Optional already-resolved PR URL for the state record. */
  prUrl?: string;
  /** Inject history root (tests). */
  historyDir?: string;
  /** Inject CLI launch resolver (tests). */
  launch?: { command: string; args: string[] };
  /** Inject spawn (tests). */
  spawnFn?: typeof spawn;
}

export interface DetachPrLandResult {
  pid: number;
  logPath: string;
  statePath: string;
  /** True when an existing lander was reused instead of spawning a new one. */
  reused: boolean;
}

/**
 * Build the argv for a foreground land re-entry (no --detach), so the detached
 * child does not re-detach itself.
 */
export function buildForegroundLandArgs(opts: {
  pr: string;
  interval?: number;
  skipReview?: boolean;
  deleteBranch?: boolean;
}): string[] {
  const args = ['pr', 'land', opts.pr];
  if (opts.interval != null && opts.interval > 0) {
    args.push('--interval', String(opts.interval));
  }
  if (opts.skipReview) args.push('--skip-review');
  if (opts.deleteBranch === false) args.push('--no-delete-branch');
  return args;
}

/**
 * Spawn a detached `agents pr land` that outlives the current process.
 * One waiter per PR: if a live lander already exists, returns it without
 * spawning a second (the "one waiter per PR" note on `pr land`).
 */
export function spawnDetachedPrLand(opts: DetachPrLandOptions): DetachPrLandResult {
  const cwd = opts.cwd ?? process.cwd();
  const historyDir = opts.historyDir;
  const statePath = prLandStatePath(opts.pr, historyDir);
  const existing = findAlivePrLander(opts.pr, historyDir);
  if (existing) {
    return {
      pid: existing.pid,
      logPath: existing.logPath,
      statePath: existing.statePath,
      reused: true,
    };
  }

  const logPath = prLandLogPath(opts.pr, historyDir);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');

  const sub = buildForegroundLandArgs({
    pr: opts.pr,
    interval: opts.interval,
    skipReview: opts.skipReview,
    deleteBranch: opts.deleteBranch,
  });
  const launch = opts.launch ?? getCliLaunch(sub);
  const spawnFn = opts.spawnFn ?? spawn;

  // fdStdio: log-file fds require DETACHED_PROCESS on Windows so the lander
  // does not die with the agent's console (same contract as the daemon).
  const child = spawnFn(launch.command, launch.args, {
    stdio: ['ignore', logFd, logFd],
    ...backgroundSpawnOptions({ cwd, fdStdio: true }),
    env: process.env,
  });
  child.on('error', () => { /* reported via pid guard below */ });
  child.unref();
  try { fs.closeSync(logFd); } catch { /* ignore */ }

  if (!child.pid) {
    throw new Error(
      `Failed to detach agents pr land for ${opts.pr}: spawning '${launch.command}' produced no PID`,
    );
  }

  const state: PrLandState = {
    pr: opts.pr,
    prUrl: opts.prUrl,
    pid: child.pid,
    logPath,
    statePath,
    startedAt: new Date().toISOString(),
    cwd,
    flags: {
      interval: opts.interval,
      skipReview: opts.skipReview,
      deleteBranch: opts.deleteBranch,
    },
  };
  writePrLandState(state);

  return { pid: child.pid, logPath, statePath, reused: false };
}

/**
 * Format the user-visible line after a successful detach (or reuse).
 * Agents and humans both parse the `pid=` token; the stop gate looks for
 * `agents pr land --detach` in the tool_use, not this line.
 */
export function formatDetachResult(result: DetachPrLandResult, pr: string): string {
  const verb = result.reused ? 'already running' : 'detached';
  return (
    `agents pr land ${verb} for ${pr} (pid=${result.pid})\n` +
    `  log:   ${result.logPath}\n` +
    `  state: ${result.statePath}\n` +
    `  This lander outlives this process: it watches CI + non-author review and rebase-merges on green.\n` +
    `  Do NOT background \`gh pr checks --watch\` — that child dies when a headless agent exits (RUSH-2394).`
  );
}

/**
 * Snapshot of the current branch's open PR (if any), for the headless-exit
 * fail-loud path. Returns null when there is no open PR or `gh` cannot answer.
 */
export interface BranchOpenPr {
  number: number;
  url: string;
  state: string;
}

/**
 * Pure classifier: should the exit path warn about this open PR?
 * Warn when the PR is OPEN and no durable lander is alive for it.
 */
export function shouldWarnOrphanedOpenPr(
  pr: BranchOpenPr | null,
  landerAlive: boolean,
): boolean {
  if (!pr) return false;
  if (pr.state.toUpperCase() !== 'OPEN') return false;
  return !landerAlive;
}

/** Human-readable warning for a stranded open PR with no durable lander. */
export function formatOrphanedOpenPrWarning(pr: BranchOpenPr): string {
  const lines = [
    '',
    chalkRed('WARNING: open PR left unattended (RUSH-2394)'),
    `  ${pr.url}`,
    '  No durable lander is running for this PR. A background `gh pr checks --watch`',
    '  child dies when a headless agent exits, so the PR will sit green and unmerged.',
    '  Drive it with a process that outlives this run:',
    '',
    `    agents pr land --detach ${pr.number}`,
    '',
    '  That watches CI + non-author review and rebase-merges on green without relying',
    '  on this process staying alive.',
    '',
  ];
  return lines.join('\n');
}

/** Tiny chalk-free red for environments where chalk is not wanted on the exit path. */
function chalkRed(s: string): string {
  // Match warn-unpushed: bold red when stderr is a TTY; plain otherwise.
  if (process.stderr.isTTY) return `\u001b[1m\u001b[31m${s}\u001b[0m`;
  return s;
}

/**
 * Probe `cwd` for an open PR on the current branch via `gh pr view`.
 * Fail-open: any error / missing gh → null (never block the run's exit).
 */
export async function getBranchOpenPr(
  cwd: string,
  execFileAsync: (
    file: string,
    args: string[],
    opts: { cwd: string; timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string }>,
): Promise<BranchOpenPr | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', '--json', 'number,url,state'],
      { cwd, timeout: 5000, maxBuffer: 512 * 1024 },
    );
    const raw = JSON.parse(stdout) as { number?: number; url?: string; state?: string };
    if (!raw?.number || !raw?.url || !raw?.state) return null;
    return { number: Number(raw.number), url: String(raw.url), state: String(raw.state) };
  } catch {
    return null;
  }
}

/**
 * Headless-exit fail-loud: if the cwd's branch has an OPEN PR and no durable
 * lander is alive for it, print a loud stderr warning. Never throws.
 */
export async function warnOrphanedOpenPr(cwd: string = process.cwd()): Promise<void> {
  try {
    const pr = await getBranchOpenPr(cwd, (file, args, opts) =>
      execFileAsyncDefault(file, args, opts).then((r) => ({ stdout: String(r.stdout ?? '') })),
    );
    if (!pr) return;
    const alive = isPrLandAlive(findAlivePrLander(String(pr.number)))
      || isPrLandAlive(findAlivePrLander(pr.url));
    if (!shouldWarnOrphanedOpenPr(pr, alive)) return;
    process.stderr.write(formatOrphanedOpenPrWarning(pr));
  } catch {
    // Advisory only — never break the run's exit.
  }
}
