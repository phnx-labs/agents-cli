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
import type { Command } from 'commander';
import chalk from 'chalk';
import { gatherLiveTargets } from './go.js';
import type { ActiveSession } from '../lib/session/active.js';
import { killSession } from '../lib/tmux/index.js';
import { getDefaultSocketPath } from '../lib/tmux/paths.js';
import { getAgentsInvocation } from '../lib/daemon.js';
import { captureProcessStartTime } from '../lib/pty-server.js';
import { writeDetachRecord } from '../lib/session/detached.js';
import { buildBackgroundArgv, resolveOne } from './detach-core.js';

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
 * and ends the agent); a plain process is SIGTERM'd by pid.
 */
async function stopInteractive(s: ActiveSession): Promise<void> {
  if (s.tmuxTarget) {
    const name = s.tmuxTarget.split(':')[0];
    await killSession(name, getDefaultSocketPath());
    return;
  }
  if (s.pid && s.pid > 0) {
    try {
      process.kill(s.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

/** Spawn the headless continuation detached, resolving to its pid for tracking. */
function spawnHeadless(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: process.env });
    child.once('spawn', () => {
      const pid = child.pid ?? 0;
      child.unref();
      resolve(pid);
    });
    child.once('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

export async function detachAction(id: string, opts: { local?: boolean } = {}): Promise<void> {
  const { activeById } = await gatherLiveTargets(!!opts.local);
  const resolved = resolveOne(activeById, id);
  if ('error' in resolved) {
    console.error(chalk.red(resolved.error));
    process.exitCode = 1;
    return;
  }
  const s = resolved;
  const sessionId = s.sessionId ?? '';
  const agent = s.kind;

  if (s.context === 'cloud') {
    console.error(chalk.red('Cloud sessions run remotely and cannot be detached from here.'));
    process.exitCode = 1;
    return;
  }
  if (!sessionId) {
    console.error(chalk.red('That session has no id to resume, so it cannot be detached.'));
    process.exitCode = 1;
    return;
  }

  // 1) Stop the interactive process.
  await stopInteractive(s);

  // 2) Continue it headless, detached — version-pinned via the existing resume path.
  const inv = getAgentsInvocation(buildBackgroundArgv(agent, sessionId, s.cwd));
  const pid = await spawnHeadless(inv.command, inv.args);

  // 3) Record it so `attach` and `agents ls --active` know it's backgrounded.
  writeDetachRecord({
    sessionId,
    agent,
    cwd: s.cwd,
    headlessPid: pid,
    headlessStartTime: captureProcessStartTime(pid),
    detachedAtMs: Date.now(),
  });

  const short = sessionId.slice(0, 8);
  console.log(
    chalk.green(`◒ Backgrounded ${agent} ${short}`) +
      chalk.gray(` — running headless (pid ${pid}). Bring it back: agents attach ${short}`),
  );
}
