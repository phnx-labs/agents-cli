/**
 * `agents watchdog` — the watchdog CONSUMER (RUSH-1415).
 *
 * Runs the tick loop that ties the merged pieces together: list active sessions,
 * classify stalls, read the tail, decide (deterministic promise-without-toolcall
 * by default), run the resolver safety gate, and inject "Continue." into the EXACT
 * split — all without the Swift menu-bar. See src/lib/watchdog/runner.ts.
 *
 *   agents watchdog                    one tick, dry — prints what it WOULD nudge/skip and why
 *   agents watchdog --nudge            one tick, actually injects (explicit opt-in)
 *   agents watchdog --watch            daemon loop (poll every --interval)
 *   agents watchdog --json             machine-readable tick output (for the menu-bar)
 *   agents watchdog enable|disable     flip the global auto-nudge sentinel (default OFF)
 *   agents watchdog policy <id> <p>    per-session policy: off | keep | handsoff
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { setHelpSections } from '../lib/help.js';
import { parseDuration } from '../lib/hooks/cache.js';
import { getRuntimeStateDir } from '../lib/state.js';
import {
  runWatchdogTick,
  writePolicySentinel,
  DEFAULT_THRESHOLDS,
  type WatchdogPolicy,
  type WatchdogThresholds,
  type WatchdogTickResult,
  type SessionOutcome,
} from '../lib/watchdog/runner.js';

/** Default state dir the runner and these subcommands share. */
function stateDir(): string {
  return path.join(getRuntimeStateDir(), 'watchdog');
}

/** Global auto-nudge sentinel — present = enabled. Default OFF (opt-in). */
function enabledSentinelPath(): string {
  return path.join(stateDir(), 'enabled');
}
function isGloballyEnabled(): boolean {
  return fs.existsSync(enabledSentinelPath());
}
function setGloballyEnabled(on: boolean): void {
  const p = enabledSentinelPath();
  if (on) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'enabled\n');
  } else {
    try { fs.rmSync(p); } catch { /* already off */ }
  }
}

/** Parse a duration flag ("60s", "5m", "1h") to ms, or fall back to `fallbackMs`. */
function durationMsOr(raw: string | undefined, fallbackMs: number): number {
  if (raw === undefined) return fallbackMs;
  const secs = parseDuration(raw);
  return secs === null ? fallbackMs : secs * 1000;
}

function humanMs(ms: number): string {
  if (ms >= 3600_000) return `${Math.round(ms / 3600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function colorForOutcome(o: SessionOutcome): (s: string) => string {
  if (o.injected) return chalk.green;
  if (o.addressable === false) return chalk.yellow;
  if (o.stall === 'stalled' && o.decision === 'nudge') return chalk.cyan;
  return chalk.dim;
}

/** Render one tick's outcomes as a human status block. */
function printTick(result: WatchdogTickResult, willInject: boolean): void {
  const { counts } = result;
  const mode = willInject ? chalk.green('nudge') : chalk.dim('dry');
  console.log(
    `${chalk.bold('watchdog')} ${mode}  ` +
      `${counts.total} live · ${counts.stalled} stalled · ` +
      `${chalk.green(String(counts.nudged))} nudged · ` +
      `${chalk.yellow(String(counts.unaddressable))} un-addressable`,
  );
  for (const o of result.outcomes) {
    const tag =
      o.injected ? 'NUDGED'
      : o.addressable === false ? 'FLAGGED'
      : o.decision === 'nudge' ? 'WOULD-NUDGE'
      : 'skip';
    const c = colorForOutcome(o);
    const who = o.label || o.sessionId?.slice(0, 8) || o.kind;
    const where = o.host ? chalk.dim(`[${o.host}]`) : '';
    const rail = o.rail ? chalk.dim(`→${o.rail}`) : '';
    console.log(`  ${c(tag.padEnd(11))} ${chalk.bold(who)} ${where} ${rail}`);
    console.log(`    ${chalk.dim(o.reason)}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Register the `agents watchdog` command tree. */
export function registerWatchdogCommand(program: Command): void {
  const cmd = program
    .command('watchdog')
    .description('Auto-nudge stalled agent terminals: detect stalls, resolve the exact split, inject "Continue." — no menu-bar needed.')
    .option('--nudge', 'Actually inject (default is a dry run that only reports what it would do)')
    .option('--watch', 'Daemon loop: run a tick every --interval until interrupted')
    .option('--interval <dur>', 'Poll interval in --watch mode (e.g. 30s, 1m)', '30s')
    .option('--stall <dur>', 'Idle time before a session counts as stalled', humanMs(DEFAULT_THRESHOLDS.stallMs))
    .option('--cooldown <dur>', 'Minimum time between nudges to the same session', humanMs(DEFAULT_THRESHOLDS.cooldownMs))
    .option('--dormant <dur>', 'Idle time after which a session is left alone (dormant)', humanMs(DEFAULT_THRESHOLDS.dormantMs))
    .option('--text <text>', 'Nudge text delivered into the terminal', 'Continue.')
    .option('--smart', 'Use the LLM decider (agents run) instead of the deterministic path (non-reproducible)')
    .option('--smart-agent <agent>', 'Agent the --smart decider runs as', 'claude')
    .option('--allow-ghostty-focus', 'Permit the coarse, focus-stealing Ghostty path (off by default)')
    .option('--json', 'Emit the tick result as JSON (for the menu-bar / scripts)')
    .action(async (opts) => {
      const thresholds: WatchdogThresholds = {
        stallMs: durationMsOr(opts.stall, DEFAULT_THRESHOLDS.stallMs),
        cooldownMs: durationMsOr(opts.cooldown, DEFAULT_THRESHOLDS.cooldownMs),
        dormantMs: durationMsOr(opts.dormant, DEFAULT_THRESHOLDS.dormantMs),
      };
      // Injection gate: --nudge is the explicit per-run opt-in; the global sentinel
      // enables the automatic daemon. Default OFF: bare `agents watchdog` is dry.
      // Re-read the sentinel every tick so a running `--watch` daemon reflects a
      // later `agents watchdog enable`/`disable` (or the Swift menu-bar toggle)
      // from another shell without a restart.
      const computeWillInject = (): boolean =>
        opts.nudge === true || (opts.watch === true && isGloballyEnabled());

      const tickOnce = async (willInject: boolean): Promise<WatchdogTickResult> =>
        runWatchdogTick({
          nudge: willInject,
          nudgeText: opts.text,
          smart: opts.smart === true,
          smartAgent: opts.smartAgent,
          thresholds,
          allowGhosttyFocus: opts.allowGhosttyFocus === true,
          stateDir: stateDir(),
        });

      if (!opts.watch) {
        const willInject = computeWillInject();
        const result = await tickOnce(willInject);
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else printTick(result, willInject);
        return;
      }

      // Daemon loop.
      const intervalMs = durationMsOr(opts.interval, 30_000);
      if (!computeWillInject() && !opts.json) {
        console.log(chalk.yellow(
          `watchdog --watch is DETECT-ONLY (global auto-nudge is ${isGloballyEnabled() ? 'on' : 'off'}). ` +
          `Pass --nudge or run 'agents watchdog enable' to inject.`,
        ));
      }
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Re-evaluated each tick: picks up enable/disable flips mid-run.
        const willInject = computeWillInject();
        const result = await tickOnce(willInject);
        if (opts.json) console.log(JSON.stringify(result));
        else printTick(result, willInject);
        await sleep(intervalMs);
      }
    });

  setHelpSections(cmd, {
    examples: `
      # One tick, dry — see what it WOULD nudge and why (safe, no injection)
      agents watchdog

      # One tick, actually inject "Continue." into stalled+addressable splits
      agents watchdog --nudge

      # Watch loop every 30s, tighter stall threshold
      agents watchdog --watch --interval 30s --stall 60s --cooldown 5m

      # Machine-readable for the menu-bar
      agents watchdog --json

      # Turn on the global auto-nudge (so --watch injects without --nudge)
      agents watchdog enable

      # Leave one session detected-but-untouched
      agents watchdog policy <sessionId> handsoff
    `,
    notes: `
      Decision path (default, deterministic): a session is nudged only when its
      transcript tail shows it ANNOUNCED an action but no tool call followed
      (promise-without-toolcall) AND it is not waiting on the user. Completions and
      open questions are skipped.

      Safety gate: a nudge is delivered ONLY when the resolver can name the EXACT
      split the agent lives in (tmux / iTerm / IDE terminal). Un-addressable stalls
      (e.g. Ghostty with no tmux) are flagged for the menu-bar and SKIPPED — never
      a guessed or frontmost target.

      Policy: global auto-nudge defaults OFF (opt-in via 'enable' or --nudge).
      Per-session: off (ignore), keep (default), handsoff (detect + flag, never inject).

      State (tray-readable): ${path.join('~/.agents/.cache/state/watchdog', '{nudges,flags,last-tick}.json')}
    `,
  });

  // --- global enable/disable/status -----------------------------------------

  cmd.command('enable')
    .description('Turn ON global auto-nudge (so `agents watchdog --watch` injects without --nudge).')
    .action(() => {
      setGloballyEnabled(true);
      console.log(chalk.green('watchdog: global auto-nudge ENABLED'));
    });

  cmd.command('disable')
    .description('Turn OFF global auto-nudge (back to detect-only unless --nudge is passed).')
    .action(() => {
      setGloballyEnabled(false);
      console.log(chalk.yellow('watchdog: global auto-nudge DISABLED'));
    });

  cmd.command('status')
    .description('Show whether global auto-nudge is on and where state is written.')
    .action(() => {
      const on = isGloballyEnabled();
      console.log(`global auto-nudge: ${on ? chalk.green('ON') : chalk.dim('off')}`);
      console.log(`state dir: ${chalk.dim(stateDir())}`);
    });

  // --- per-session policy ----------------------------------------------------

  cmd.command('policy <sessionId> <policy>')
    .description('Set per-session policy: off (ignore) | keep (default) | handsoff (detect + flag, never inject).')
    .action((sessionId: string, policy: string) => {
      const p = policy.toLowerCase();
      if (p !== 'off' && p !== 'keep' && p !== 'handsoff') {
        console.error(chalk.red(`invalid policy '${policy}'. Use: off | keep | handsoff`));
        process.exitCode = 1;
        return;
      }
      writePolicySentinel(stateDir(), sessionId, p as WatchdogPolicy);
      console.log(`watchdog: session ${chalk.bold(sessionId.slice(0, 8))} policy = ${chalk.cyan(p)}`);
    });
}
