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
 *   agents watchdog --watch            manual poll loop (dry unless --nudge)
 *   agents watchdog --json             machine-readable tick output (for the menu-bar)
 *   agents watchdog on|off             turn the always-on watchdog routine on/off
 *   agents watchdog policy <id> <p>    per-session policy: off | keep | handsoff
 *
 * The always-on watchdog is a daemon-fired ROUTINE, not a private sentinel + a
 * hand-rolled loop. Its immutable definition comes from the system DotAgents
 * repo; on/off only changes this device's routine membership.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import { setHelpSections } from '../lib/help.js';
import { parseDuration } from '../lib/hooks/cache.js';
import { getRuntimeStateDir } from '../lib/state.js';
import { readJob, setJobEnabled } from '../lib/routines.js';
import { getActiveSessions, type ActiveSession } from '../lib/session/active.js';
import { loadLocalActiveSessions } from '../lib/session/session-cache.js';
import { mailboxIdForActiveSession } from '../lib/mailbox-target.js';
import { gcMailbox } from '../lib/mailbox-gc.js';
import { devicesWithRoutineEnabled, routineEnabledOnThisDevice } from '../lib/routine-activation.js';
import {
  runWatchdogTick,
  writePolicySentinel,
  DEFAULT_THRESHOLDS,
  type WatchdogPolicy,
  type WatchdogThresholds,
  type WatchdogTickResult,
  type SessionOutcome,
} from '../lib/watchdog/runner.js';
import { isWatchdogRotateEnabled, listRotateStates, setWatchdogRotateEnabled } from '../lib/watchdog/rotate.js';

const WATCHDOG_ROUTINE_NAME = 'watchdog';

/** Default state dir the runner and these subcommands share. */
function stateDir(): string {
  return path.join(getRuntimeStateDir(), 'watchdog');
}

/**
 * (Re)load the daemon so a just-changed routine takes effect without a restart.
 * Best-effort: enabling starts the daemon if it is not running, then SIGHUPs it.
 * Dynamic import keeps daemon.ts's heavy deps off the watchdog command's load path.
 */
async function reloadDaemonForRoutine(startIfStopped: boolean): Promise<void> {
  const { isDaemonRunning, ensureDaemonStarted, signalDaemonReload } = await import('../lib/daemon.js');
  if (isDaemonRunning()) {
    signalDaemonReload();
    return;
  }
  if (startIfStopped) ensureDaemonStarted();
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

/**
 * Run the mailbox liveness sweep against the same session set the tick just used.
 * Idempotent and cheap: archiving a message twice is a no-op, and GC only scans
 * directories. Failures are swallowed so a mailbox-root problem cannot break the
 * watchdog tick.
 */
async function runMailboxGc(sessions: ActiveSession[]): Promise<void> {
  const activeBoxIds = new Set(
    sessions.map(mailboxIdForActiveSession).filter((id): id is string => !!id),
  );
  try {
    gcMailbox(activeBoxIds);
  } catch {
    // GC is best-effort housekeeping; the next tick will retry.
  }
}

function colorForOutcome(o: SessionOutcome): (s: string) => string {
  if (o.injected) return chalk.green;
  if (o.decision === 'rotate') return chalk.magenta;
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
      `${chalk.yellow(String(counts.unaddressable))} un-addressable` +
      (counts.rotating > 0 ? ` · ${chalk.magenta(String(counts.rotating))} rotating` : ''),
  );
  for (const o of result.outcomes) {
    const tag =
      o.injected ? 'NUDGED'
      : o.decision === 'rotate' ? (o.rotatePhase === 'failed' ? 'ROTATE-FAIL' : 'ROTATE')
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
    .option('--watch', 'Manual poll loop: run a tick every --interval (dry unless --nudge; the always-on path is `watchdog on`)')
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
      // Injection gate: --nudge is the explicit opt-in to actually inject. Bare
      // `agents watchdog` (and `--watch` without `--nudge`) is dry. The always-on
      // path is the daemon routine, which runs `agents watchdog --nudge` — so the
      // routine's enabled state IS the on/off switch, not a flag read here.
      const computeWillInject = (): boolean => opts.nudge === true;

      const tickOnce = async (willInject: boolean, sessions: ActiveSession[]): Promise<WatchdogTickResult> =>
        runWatchdogTick({
          nudge: willInject,
          nudgeText: opts.text,
          smart: opts.smart === true,
          smartAgent: opts.smartAgent,
          thresholds,
          allowGhosttyFocus: opts.allowGhosttyFocus === true,
          stateDir: stateDir(),
          sessions,
        });

      // RUSH-2062: share the daemon-warmed local active-session snapshot with
      // menubar/CLI/Factory instead of re-running a full gather every tick.
      const loadWatchdogSessions = async () => {
        const loaded = await loadLocalActiveSessions({
          // Force a live gather only when the warm path is unavailable; the
          // cache layer already re-gathers past DEFAULT_ACTIVE_CACHE_MAX_AGE_MS.
          gather: () => getActiveSessions({ localOnly: true }),
        });
        return loaded.sessions;
      };

      if (!opts.watch) {
        const willInject = computeWillInject();
        const sessions = await loadWatchdogSessions();
        const result = await tickOnce(willInject, sessions);
        await runMailboxGc(sessions);
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else printTick(result, willInject);
        return;
      }

      // Manual poll loop (for ad-hoc use; the always-on path is `enable`'s routine).
      const intervalMs = durationMsOr(opts.interval, 30_000);
      if (!computeWillInject() && !opts.json) {
        console.log(chalk.yellow(
          `watchdog --watch is DETECT-ONLY. Pass --nudge to inject, ` +
          `or run 'agents watchdog on' for the always-on daemon routine.`,
        ));
      }
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Re-evaluated each tick: picks up enable/disable flips mid-run.
        const willInject = computeWillInject();
        const sessions = await loadWatchdogSessions();
        const result = await tickOnce(willInject, sessions);
        await runMailboxGc(sessions);
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

      # Manual watch loop every 30s, tighter stall threshold (ad-hoc; dry unless --nudge)
      agents watchdog --watch --nudge --interval 30s --stall 60s --cooldown 5m

      # Machine-readable for the menu-bar
      agents watchdog --json

      # Turn on the ALWAYS-ON watchdog (a daemon-fired routine)
      agents watchdog on

      # Show the routine, rotate config, and any in-flight in-place rotates
      agents watchdog status

      # Leave one session detected-but-untouched
      agents watchdog policy <sessionId> handsoff

      # Opt out of in-place rotate only (nudging stays on)
      agents watchdog rotate off
    `,
    notes: `
      Decision path: a cheap deterministic pre-filter resolves the obvious cases
      (clearly complete -> skip; a clear promise-without-toolcall -> nudge) and
      ESCALATES the judgment-heavy cases -- a session parked on a question, or an
      ambiguous stall -- to a smart brain. The brain drives the agent to finish
      end-to-end when it asked a needless / already-authorized question or paused
      with work left, and leaves it for the human on genuine cases (credentials,
      an irreversible or outward-facing action, a real ambiguous decision, or a
      completed task). The brain is a customizable 'watchdog' workflow (drop a
      WORKFLOW.md in project/user workflows/ to override the prompt + model);
      absent one, the built-in prompt runs via 'agents run --mode plan'. Pass
      --smart to force every stalled candidate through the brain.

      Delivery (answer-router): a running agent is steered via its mailbox; a
      parked-on-question agent is answered into its EXACT split -- tmux / iTerm /
      an IDE integrated terminal (VS Codium / Cursor / VS Code) -- or re-entered
      via resume when headless. A parked agent with no addressable rail (e.g.
      Ghostty with no tmux) is flagged for the menu-bar and SKIPPED -- never a
      guessed or frontmost target.

      Rotate: a stalled session whose tail shows a HARD account limit ("You've
      hit your weekly limit - resets ...") is ROTATED IN PLACE instead of nudged:
      the tick gates on the same healthy-account selection 'agents run auto'
      makes (zero healthy -> one skip event per cooldown window, terminal
      untouched), injects the harness's exit sequence, relaunches
      'agents run auto --interactive --session-id <uuid>' in the SAME tab, waits
      (bounded, 60s) for the new TUI, then injects the resume replay for the old
      session. On timeout the session is flagged and never blind-typed into; the
      flag says the terminal may sit at a bare shell and needs a manual
      'agents run auto'. A failed rotate is suppressed for 15m before retry.
      Default ON; disable with 'agents watchdog rotate off' (writes
      'watchdog.rotate: off' to ~/.agents/agents.yaml; nudging stays on).
      State machine: ~/.agents/.cache/state/watchdog/rotate/<sessionId>.json.

      Always-on: 'agents watchdog on' enables the system-defined 'watchdog' routine
      on this device and reloads the daemon; 'off' disables it here. Inspect it with
      'agents routines list'. Defaults
      OFF. Per-session policy: off (ignore), keep (default), handsoff (detect + flag).

      State (tray-readable): ${path.join('~/.agents/.cache/state/watchdog', '{nudges,flags,last-tick}.json')}
    `,
  });

  // --- always-on enable/disable/status (backed by the daemon routine) --------

  const turnOn = async (): Promise<void> => {
      const routine = readJob(WATCHDOG_ROUTINE_NAME);
      if (!routine) throw new Error("Built-in routine 'watchdog' is missing. Run: agents repo pull system");
      setJobEnabled(WATCHDOG_ROUTINE_NAME, true);
      await reloadDaemonForRoutine(true);
      console.log(chalk.green(`watchdog: ON on this device (${routine.schedule ?? 'event-triggered'})`));
  };
  const turnOff = async (): Promise<void> => {
      if (!readJob(WATCHDOG_ROUTINE_NAME)) throw new Error("Built-in routine 'watchdog' is missing. Run: agents repo pull system");
      setJobEnabled(WATCHDOG_ROUTINE_NAME, false);
      await reloadDaemonForRoutine(false);
      console.log(chalk.yellow('watchdog: OFF on this device'));
  };

  cmd.command('on')
    .description('Enable the built-in watchdog routine on this device.')
    .action(async () => {
      await turnOn();
    });

  cmd.command('off')
    .description('Disable the built-in watchdog routine on this device.')
    .action(async () => {
      await turnOff();
    });

  cmd.command('enable', { hidden: true }).action(turnOn);
  cmd.command('disable', { hidden: true }).action(turnOff);

  cmd.command('rotate <state>')
    .description(
      'Turn in-place rotate of rate-limited sessions on|off (watchdog.rotate in agents.yaml). ' +
      'Rotate-only: nudging stays on — unlike `watchdog off`, which disables the whole watchdog on this device.',
    )
    .action((state: string) => {
      const s = state.toLowerCase();
      if (s !== 'on' && s !== 'off') {
        console.error(chalk.red(`invalid state '${state}'. Use: on | off`));
        process.exitCode = 1;
        return;
      }
      setWatchdogRotateEnabled(s === 'on');
      console.log(
        `watchdog: rotate ${s === 'on' ? chalk.green('ON') : chalk.yellow('OFF')} ` +
        chalk.dim(`(watchdog.rotate: ${s} in agents.yaml)`),
      );
    });

  cmd.command('status')
    .description('Show whether the always-on watchdog routine is enabled and where state is written.')
    .option('--json', 'Emit status as JSON (for the menu-bar / scripts)')
    .action((_opts, command) => {
      // The parent `watchdog` command also declares --json and greedily parses it
      // before dispatching here, so `watchdog status --json` lands the flag on the
      // parent, not this subcommand. optsWithGlobals() merges both levels, so we
      // read it correctly regardless of which command commander bound it to.
      const json = command.optsWithGlobals().json === true;
      const on = routineEnabledOnThisDevice(WATCHDOG_ROUTINE_NAME) === true;
      const enabledDevices = devicesWithRoutineEnabled(WATCHDOG_ROUTINE_NAME);
      const rotate = isWatchdogRotateEnabled() ? 'on' : 'off';
      const rotates = listRotateStates(stateDir());
      const inflight = rotates.filter((r) => r.phase !== 'done' && r.phase !== 'failed');
      if (json) {
        console.log(JSON.stringify({
          enabled: on,
          enabledDevices,
          routine: WATCHDOG_ROUTINE_NAME,
          stateDir: stateDir(),
          rotate,
          rotates: rotates.map((r) => ({
            sessionId: r.sessionId,
            newSessionId: r.newSessionId,
            agent: r.agent,
            phase: r.phase,
            updatedAtMs: r.updatedAtMs,
            error: r.error,
          })),
        }));
        return;
      }
      console.log(`always-on watchdog: ${on ? chalk.green('ON') : chalk.dim('off')} (routine '${WATCHDOG_ROUTINE_NAME}')`);
      console.log(`enabled devices: ${enabledDevices.length > 0 ? enabledDevices.join(', ') : chalk.dim('none')}`);
      console.log(`rotate: ${rotate === 'on' ? chalk.green('on') : chalk.yellow('off')} (watchdog.rotate in agents.yaml) · ${inflight.length} in-flight`);
      for (const r of inflight) {
        console.log(`  ${chalk.magenta(r.phase.padEnd(12))} ${chalk.bold(r.sessionId.slice(0, 8))} → ${r.newSessionId.slice(0, 8)}${r.error ? chalk.red(`  ${r.error}`) : ''}`);
      }
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
