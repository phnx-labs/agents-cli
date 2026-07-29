/**
 * One-time "star us on GitHub" nudge.
 *
 * Printed a single time, ever, after a user's first *successful* headline run
 * (`agents run` / `agents teams`). Modelled on the existing warn-once sentinel
 * pattern (see maybeWarnMultiInstall in src/index.ts): a marker under the
 * regenerable runtime-state dir records that the hint was shown so it never
 * repeats. It is a plain inline line — not a toast, not a nag — and stays out
 * of the way of non-interactive, CI, quiet, and JSON output.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { getRuntimeStateDir } from './state.js';

/** Canonical GitHub repo the nudge points at. */
export const REPO_URL = 'https://github.com/phnx-labs/agents-cli';

/** Sentinel written the first (and only) time the nudge is shown. */
function nudgeSentinelPath(): string {
  return path.join(getRuntimeStateDir(), 'star-nudge-shown');
}

/** Has the star nudge already been shown on this machine? */
export function hasShownStarNudge(): boolean {
  try {
    return fs.existsSync(nudgeSentinelPath());
  } catch {
    return false;
  }
}

/** Inputs to the pure show/skip decision (kept side-effect free for testing). */
export interface StarNudgeContext {
  /** Caller asked for quiet / JSON output. */
  quiet?: boolean;
  /** stdout is attached to an interactive terminal. */
  isTTY: boolean;
  /** CI is set in the environment. */
  ci: boolean;
  /** User opted out via AGENTS_NO_NUDGE=1. */
  optedOut: boolean;
  /** The one-time sentinel already exists. */
  alreadyShown: boolean;
}

/**
 * Pure decision: should the one-time star nudge be shown? Skipped for
 * quiet/JSON output, non-interactive terminals (pipes, redirects), CI, an
 * explicit opt-out, or once it has already been shown.
 */
export function shouldShowStarNudge(ctx: StarNudgeContext): boolean {
  if (ctx.quiet) return false;
  if (!ctx.isTTY) return false;
  if (ctx.ci) return false;
  if (ctx.optedOut) return false;
  if (ctx.alreadyShown) return false;
  return true;
}

/**
 * Show the one-time star nudge if it hasn't been shown yet and the context is
 * appropriate. Best-effort by contract: never throws, never blocks the run it
 * follows.
 *
 * Skipped when: the caller asked for quiet/JSON output, stdout is not an
 * interactive terminal (pipes, redirects), CI is set, or the user opted out
 * with AGENTS_NO_NUDGE=1.
 */
export function maybeShowStarNudge(opts: { quiet?: boolean } = {}): void {
  try {
    const show = shouldShowStarNudge({
      quiet: opts.quiet,
      isTTY: Boolean(process.stdout.isTTY),
      ci: Boolean(process.env.CI),
      optedOut: process.env.AGENTS_NO_NUDGE === '1',
      alreadyShown: hasShownStarNudge(),
    });
    if (!show) return;

    // Write the sentinel BEFORE printing so two runs finishing at once still
    // show the hint at most once.
    const sentinel = nudgeSentinelPath();
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, new Date().toISOString());

    console.log(
      '\n' +
        chalk.gray('Enjoying agents-cli? Give it a star to help others find it: ') +
        chalk.cyan(REPO_URL),
    );
  } catch {
    /* best-effort: a nudge must never break a successful run */
  }
}
