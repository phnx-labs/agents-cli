/**
 * `agents detach <id>` — send a live agent session to the background: stop its
 * interactive process and continue it headless, unattended, so it drives its
 * task to completion without holding a terminal. Bring it back with
 * `agents attach`.
 *
 * Agent-agnostic and version-pinned by construction: it re-invokes
 * `agents run <agent> "<nudge>" --resume <id> --headless`, which resolves the
 * session's originating version and uses the agent's native resume (claude/codex)
 * or a `/continue` replay (others) — the same path `attach` reverses.
 */
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import chalk from 'chalk';
import { gatherLiveTargets } from './go.js';
import type { ActiveSession } from '../lib/session/active.js';
import { killSession } from '../lib/tmux/index.js';
import { getDefaultSocketPath } from '../lib/tmux/paths.js';
import { getAgentsInvocation } from '../lib/daemon.js';
import { captureProcessStartTime } from '../lib/pty-server.js';
import { writeDetachRecord } from '../lib/session/detached.js';
import { getLogsDir } from '../lib/state.js';
import { runOnPeer } from '../lib/session/remote-list.js';
import { buildBackgroundArgv, resolveDetachTarget, resolveOne } from './detach-core.js';

export function registerDetachCommand(program: Command): void {
  program
    .command('detach')
    .argument('<id>', 'Short or full id of the live session to background')
    .option('--local', 'Only this machine (skip the cross-host sweep)')
    .description('Send a live agent to the background — stop its terminal, keep it working headless')
    .action(async (id: string, opts: { local?: boolean }) => {
      await detachAction(id, opts);
    });
}

/**
 * Stop the interactive process so it can't fight the headless resume over the
 * same transcript. tmux-hosted sessions are killed by session (closes the pane
 * and ends the agent); a plain process is SIGTERM'd by pid. Either way we then
 * wait for the process to actually exit before returning, so the headless
 * continuation never starts writing the transcript while the old process is
 * still flushing it.
 */
async function stopInteractive(s: ActiveSession): Promise<void> {
  if (s.tmuxTarget) {
    const name = s.tmuxTarget.split(':')[0];
    await killSession(name, getDefaultSocketPath());
  } else if (s.pid && s.pid > 0) {
    try {
      process.kill(s.pid, 'SIGTERM');
    } catch {
      return; /* already gone — nothing to wait on */
    }
  }
  if (s.pid && s.pid > 0) await waitForExit(s.pid);
}

/**
 * Poll until `pid` is gone (SIGTERM already sent), escalating to SIGKILL past the
 * deadline so a stuck process can't wedge the detach. Bounded so `detach` never
 * hangs waiting on a process that ignores signals.
 */
async function waitForExit(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; /* gone */
    }
    if (Date.now() >= deadline) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* raced to exit */
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Where a backgrounded continuation's stdout/stderr lands, by convention, so a
 * crash after detach is debuggable — there is no terminal watching it, and
 * presence only tells you the pid is gone, not whether the run finished or died.
 */
function backgroundLogPath(sessionId: string): string {
  return path.join(getLogsDir(), `detach-${sessionId.slice(0, 8)}.log`);
}

/**
 * Spawn the headless continuation detached, resolving to its pid for tracking.
 * Its output is redirected to `logFile` rather than discarded, so a fast-failing
 * background run leaves a trail.
 */
function spawnHeadless(command: string, args: string[], logFile: string): Promise<number> {
  return new Promise((resolve, reject) => {
    mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = openSync(logFile, 'a');
    const child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd], env: process.env });
    child.once('spawn', () => {
      const pid = child.pid ?? 0;
      child.unref();
      try { closeSync(fd); } catch { /* fd handed to the child */ }
      resolve(pid);
    });
    child.once('error', (err) => {
      try { closeSync(fd); } catch { /* never opened for the child */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export async function detachAction(id: string, opts: { local?: boolean } = {}): Promise<void> {
  const { self, activeById } = await gatherLiveTargets(!!opts.local, { includeCloud: true });
  const resolved = resolveOne(activeById, id);
  if ('error' in resolved) {
    console.error(chalk.red(resolved.error));
    process.exitCode = 1;
    return;
  }
  const s = resolved;
  const target = resolveDetachTarget(s, self);

  // Cloud, team, and id-less sessions can't be backgrounded from here.
  if (target.kind === 'refuse') {
    console.error(chalk.red(target.reason));
    process.exitCode = 1;
    return;
  }

  const short = target.sessionId.slice(0, 8);

  // A session on another host: its pid and tmux socket only mean something where
  // it runs, so detach it *there* over SSH — never kill/resume locally. Mirrors
  // focus/jumpTo's remote branch.
  if (target.kind === 'remote') {
    console.log(chalk.gray(`${short} lives on ${target.machine} — detaching it there over SSH…`));
    const rc = await runOnPeer(['detach', target.sessionId, '--local'], target.machine);
    if (rc === 'no-target') {
      console.error(chalk.red(`Can't reach ${target.machine} to detach ${short}.`));
      process.exitCode = 1;
    }
    return;
  }

  // Local: stop the interactive process, then continue it headless, detached —
  // version-pinned via the existing `agents run --resume` path.
  const sessionId = target.sessionId;
  const agent = s.kind;
  await stopInteractive(s);

  const logFile = backgroundLogPath(sessionId);
  const inv = getAgentsInvocation(buildBackgroundArgv(agent, sessionId, s.cwd));
  const pid = await spawnHeadless(inv.command, inv.args, logFile);

  // Record it so `attach` and `agents ls --active` know it's backgrounded.
  writeDetachRecord({
    sessionId,
    agent,
    cwd: s.cwd,
    headlessPid: pid,
    headlessStartTime: captureProcessStartTime(pid),
    detachedAtMs: Date.now(),
  });

  console.log(
    chalk.green(`◒ Backgrounded ${agent} ${short}`) +
      chalk.gray(` — running headless (pid ${pid}). Bring it back: agents attach ${short}`),
  );
  console.log(chalk.gray(`  logs: ${logFile}`));
}
