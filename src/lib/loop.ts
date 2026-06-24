/**
 * Autonomous loop driver (issue #332).
 *
 * Re-injects an entrypoint each iteration until a stop condition is met. The
 * driver is the deterministic skeleton; the entrypoint inside stays dynamic (it
 * can spawn subagents freely). Every guard — `max_iterations`, `budget`, the
 * `until: signal` condition, SIGINT/SIGTERM — lives OUTSIDE the agent, so the
 * agent cannot vote past a kill-switch (the standard answer to runaway-loop and
 * runaway-cost failure modes; see docs/07-entrypoints-and-loops.md).
 *
 * Structure mirrors the teams supervisor (`runSupervisor` in teams/supervisor.ts):
 * a bounded for-loop with a hard cap, a SIGINT/SIGTERM trap that flips a stop
 * flag, a per-iteration guard check, an interval sleep, and a typed `stoppedBy`
 * union for the exit reason.
 *
 * Token accounting: the budget cap is a TOKEN hard-cap, enforced after each
 * turn from the usage events parsed off the agent's stream-json output. Token
 * extraction reuses `extractUsageEvents` from budget/enforce.ts (read-only
 * import) rather than re-implementing the per-provider parsing.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import type { ExecOptions } from './exec.js';
import { buildExecCommand, buildExecEnv } from './exec.js';
import { extractUsageEvents } from './budget/enforce.js';
import { parseTimeout } from './routines.js';
import { writeCheckpoint, type Checkpoint } from './checkpoint.js';

/** Loop block config (docs/07-entrypoints-and-loops.md → "The loop block"). */
export interface LoopConfig {
  /** Stop condition. `signal` reads loop-signal.json; absence is fail-closed. */
  until?: 'signal';
  /** Hard cap on iterations. */
  maxIterations?: number;
  /** Token hard-cap, enforced outside the agent. */
  budget?: number;
  /** Delay between iterations: "0" back-to-back, "30m" paces. */
  interval?: string;
}

/** The loop-signal.json contract the entrypoint writes each iteration. */
export interface LoopSignal {
  continue: boolean;
  reason?: string;
}

/** Why the loop stopped. Mirrors the teams supervisor exit reasons. */
export type LoopStoppedBy =
  | 'condition-met'
  | 'budget'
  | 'stalled'
  | 'max'
  | 'signal'
  | 'error';

/** Result of a loop run. */
export interface LoopResult {
  /** Iterations actually executed. */
  iterations: number;
  stoppedBy: LoopStoppedBy;
  elapsedMs: number;
  /** Cumulative tokens consumed across all iterations. */
  tokens: number;
  /** Last loop-signal read, if any. */
  lastSignal?: LoopSignal;
}

/** What a single iteration's run function returns. */
export interface IterationResult {
  exitCode: number;
  /** Tokens consumed this iteration (input + output + cache). */
  tokens: number;
}

/** Per-iteration run function — the injectable seam that makes the driver testable. */
export type RunIteration = (options: ExecOptions) => Promise<IterationResult>;

/** Context the driver needs that isn't part of ExecOptions. */
export interface LoopContext {
  runId: string;
  runDir: string;
  agent: AgentId;
  version?: string;
  /** Iteration to start at (1 for a fresh run, checkpoint.iteration+1 for a resume). */
  startIteration?: number;
  /** Tokens already consumed before this driver started (carried across a resume). */
  startTokens?: number;
  /** Session id to pin so the agent resumes its conversation across iterations. */
  sessionId?: string;
}

/** Dependency seams for testing. */
export interface LoopDeps {
  /** Per-iteration runner. Defaults to a token-capturing spawn (defaultRunIteration). */
  runIteration?: RunIteration;
  /** Sleep function (ms). Defaults to setTimeout-backed. Injectable so tests don't wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Checkpoint writer. Defaults to writeCheckpoint. */
  writeCheckpoint?: (c: Checkpoint) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Path to a run's loop-signal.json. */
export function loopSignalPath(runDir: string): string {
  return path.join(runDir, 'loop-signal.json');
}

/**
 * Read and parse loop-signal.json. Returns null when the file is absent or
 * unparseable — the caller treats null as fail-closed (continue:false).
 */
export function readLoopSignal(runDir: string): LoopSignal | null {
  const file = loopSignalPath(runDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return { continue: parsed.continue === true, reason: typeof parsed.reason === 'string' ? parsed.reason : undefined };
  } catch {
    return null;
  }
}

/** Delete loop-signal.json so a stale signal never carries into the next iteration. */
export function clearLoopSignal(runDir: string): void {
  const file = loopSignalPath(runDir);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* best-effort: a missing file is the desired state anyway. */
  }
}

/**
 * Default per-iteration runner: spawn the agent, tee stdout, and sum token usage
 * off the stream. This is a purpose-built token-capturing spawn for the loop's
 * budget guard, not a re-implementation of exec's fallback/budget machinery —
 * it reuses `buildExecCommand` / `buildExecEnv` (the canonical command/env
 * builders) and `extractUsageEvents` (the canonical stream parser). The agent
 * is forced to JSON/headless so the usage stream is parseable.
 */
export function defaultRunIteration(options: ExecOptions): Promise<IterationResult> {
  // Force the stream-json output the usage parser needs; a loop iteration is
  // always headless (re-injected programmatically, never an interactive TUI).
  const execOptions: ExecOptions = { ...options, json: true, headless: true, interactive: false };
  const cmd = buildExecCommand(execOptions);
  const [executable, ...args] = cmd;
  const env = buildExecEnv(execOptions);
  const cwd = execOptions.cwd || process.cwd();
  const model = execOptions.model ?? `${execOptions.agent}-default`;

  return new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32' && (
      !path.isAbsolute(executable) || executable.endsWith('.cmd')
    );
    const child = spawn(executable, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      env,
      shell: useShell,
    });

    let tokens = 0;
    let pending = '';
    if (child.stdout) {
      child.stdout.pipe(process.stdout);
      child.stdout.on('data', (chunk: Buffer) => {
        const { events, rest } = extractUsageEvents(chunk.toString('utf-8'), pending, model, execOptions.agent);
        pending = rest;
        for (const ev of events) {
          tokens += (ev.inputTokens ?? 0) + (ev.outputTokens ?? 0)
            + (ev.cacheReadTokens ?? 0) + (ev.cacheCreationTokens ?? 0);
        }
      });
    }
    if (child.stderr) child.stderr.pipe(process.stderr);

    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      resolve({ exitCode: code ?? (signal ? 1 : 0), tokens });
    });
  });
}

/**
 * Run the autonomous loop. Returns when a guard trips, the until-condition is
 * met, the iteration cap is reached, or a signal arrives.
 *
 * stoppedBy semantics:
 *   - `condition-met` — until=signal and the signal said stop (continue:false
 *     OR the file was absent/corrupt → fail-closed).
 *   - `budget`        — cumulative tokens crossed the budget cap (checked after
 *     each turn, outside the agent).
 *   - `max`           — ran maxIterations iterations without any earlier stop.
 *   - `signal`        — SIGINT/SIGTERM arrived; checkpoint is written before exit.
 *   - `error`         — an iteration threw or exited non-zero.
 */
export async function runLoop(
  execOptions: ExecOptions,
  loop: LoopConfig,
  ctx: LoopContext,
  deps?: LoopDeps,
): Promise<LoopResult> {
  const runIteration = deps?.runIteration ?? defaultRunIteration;
  const sleep = deps?.sleep ?? defaultSleep;
  const persist = deps?.writeCheckpoint ?? writeCheckpoint;

  const startedAt = Date.now();
  const maxIterations = loop.maxIterations ?? 1000;
  const intervalMs = loop.interval !== undefined ? (parseTimeout(loop.interval) ?? 0) : 0;
  // "0" interval is intentional back-to-back; parseTimeout returns null for "0"
  // (it rejects zero/negative), so coalesce null → 0 above.

  // Pin a session id so iteration >= 2 resumes the same conversation. A resume
  // carries the prior session id in via ctx.sessionId; a fresh run mints one.
  const sessionId = ctx.sessionId ?? randomUUID();
  const startIteration = ctx.startIteration ?? 1;

  let tokens = ctx.startTokens ?? 0;
  let lastSignal: LoopSignal | undefined;

  let stopSignal = false;
  const onSig = () => { stopSignal = true; };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);

  const checkpoint = (iteration: number): void => {
    const now = new Date().toISOString();
    persist({
      id: ctx.runId,
      agent: ctx.agent,
      version: ctx.version,
      prompt: execOptions.prompt,
      sessionId,
      iteration,
      loop,
      loopSignal: lastSignal,
      cumulativeTokens: tokens,
      createdAt: now,
      updatedAt: now,
    });
  };

  const done = (iterations: number, stoppedBy: LoopStoppedBy): LoopResult => ({
    iterations,
    stoppedBy,
    elapsedMs: Date.now() - startedAt,
    tokens,
    lastSignal,
  });

  try {
    let iteration = startIteration;
    for (; iteration <= maxIterations; iteration++) {
      if (stopSignal) {
        checkpoint(iteration - 1);
        return done(iteration - startIteration, 'signal');
      }

      // Iteration >= 2 (counting from the very first run, not the resume offset)
      // pins --session-id so Claude resumes its conversation. Re-inject the
      // prompt every iteration.
      //
      // AGENTS_LOOP_SIGNAL / AGENTS_RUN_DIR: tell the entrypoint where to write
      // loop-signal.json so the guard (read OUTSIDE the agent) can see it. The
      // agent never decides whether to continue — it only writes its vote.
      const iterOptions: ExecOptions = {
        ...execOptions,
        sessionId: iteration >= 2 ? sessionId : (execOptions.sessionId ?? sessionId),
        env: {
          ...execOptions.env,
          AGENTS_RUN_DIR: ctx.runDir,
          AGENTS_LOOP_SIGNAL: loopSignalPath(ctx.runDir),
          AGENTS_LOOP_ITERATION: String(iteration),
        },
      };

      let result: IterationResult;
      try {
        result = await runIteration(iterOptions);
      } catch (err) {
        checkpoint(iteration - 1);
        process.stderr.write(`[loop] iteration ${iteration} failed: ${(err as Error).message}\n`);
        return done(iteration - startIteration, 'error');
      }

      tokens += result.tokens;
      const completed = iteration - startIteration + 1;

      // until=signal: read the signal the entrypoint wrote this iteration.
      // Absent/corrupt OR continue:false => stop (fail-closed).
      if (loop.until === 'signal') {
        lastSignal = readLoopSignal(ctx.runDir) ?? { continue: false, reason: 'loop-signal.json absent (fail-closed)' };
        clearLoopSignal(ctx.runDir);
        if (!lastSignal.continue) {
          checkpoint(iteration);
          return done(completed, 'condition-met');
        }
      }

      // Budget (token hard-cap), enforced after the turn — outside the agent.
      if (loop.budget !== undefined && tokens >= loop.budget) {
        checkpoint(iteration);
        return done(completed, 'budget');
      }

      // A non-zero exit is a hard error — don't keep re-injecting into a broken run.
      if (result.exitCode !== 0) {
        checkpoint(iteration);
        process.stderr.write(`[loop] iteration ${iteration} exited ${result.exitCode}\n`);
        return done(completed, 'error');
      }

      checkpoint(iteration);

      if (stopSignal) {
        return done(completed, 'signal');
      }

      // Pace between iterations. Skip the sleep after the final iteration.
      if (iteration < maxIterations && intervalMs > 0) {
        await sleep(intervalMs);
        if (stopSignal) {
          return done(completed, 'signal');
        }
      }
    }
    return done(maxIterations - startIteration + 1, 'max');
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}
