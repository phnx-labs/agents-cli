/**
 * Dispatch a headless agent run onto a host over SSH.
 *
 * The run is launched detached (`nohup … &`) writing combined output to a remote
 * log and its exit code to a sibling `.exit` file, so progress survives a dropped
 * connection (followed via offset-tail in progress.ts). This is the offload win:
 * the agent's process/thread/file fan-out happens on the host, not the laptop.
 */

import { randomUUID } from 'crypto';
import { sshExec, shellQuote } from '../ssh-exec.js';
import type { Host } from './types.js';
import { sshTargetFor } from './types.js';
import { ensureHostReady } from './ready.js';
import { saveTask, updateTask, type HostTask } from './tasks.js';
import { followHostTask } from './progress.js';

// Use $HOME (not ~) so the path is correct whether or not it's quoted and
// regardless of the run's cwd. Task ids are 8 hex chars, so these paths are
// injection-safe to interpolate unquoted into remote commands.
const REMOTE_DIR = '$HOME/.agents/.cache/hosts';

export interface DispatchOptions {
  agent: string;
  prompt: string;
  mode?: string;
  model?: string;
  remoteCwd?: string;
  /** Stream progress and block until completion (default true). */
  follow?: boolean;
  timeoutMs?: number;
}

export interface DispatchResult {
  task: HostTask;
  /** Exit code when followed; undefined when detached (--no-follow). */
  exitCode?: number;
}

export async function dispatchToHost(host: Host, opts: DispatchOptions): Promise<DispatchResult> {
  const target = sshTargetFor(host);
  const { warnings } = ensureHostReady(host, { agent: opts.agent });
  for (const w of warnings) process.stderr.write(`[hosts] warning: ${w}\n`);

  const id = randomUUID().slice(0, 8);
  const remoteLog = `${REMOTE_DIR}/${id}.log`;
  const remoteExit = `${REMOTE_DIR}/${id}.exit`;

  // Inner command run under a login shell so PATH resolves `agents`.
  const runParts = ['agents', 'run', shellQuote(opts.agent), shellQuote(opts.prompt), '--quiet'];
  if (opts.mode) runParts.push('--mode', shellQuote(opts.mode));
  if (opts.model) runParts.push('--model', shellQuote(opts.model));
  const cwd = opts.remoteCwd ? `cd ${shellQuote(opts.remoteCwd)} && ` : '';
  const inner = `${cwd}${runParts.join(' ')} > ${remoteLog} 2>&1; echo $? > ${remoteExit}`;

  // Outer: ensure dir, launch detached under bash -lc, print the PID.
  const launch = `mkdir -p ${REMOTE_DIR}; nohup bash -lc ${shellQuote(inner)} >/dev/null 2>&1 & echo $!`;
  const res = sshExec(target, launch, { timeoutMs: 30000 });
  if (res.code !== 0) {
    throw new Error(`Failed to launch on "${host.name}": ${(res.stderr || res.stdout).trim() || 'ssh error'}`);
  }
  const pid = parseInt(res.stdout.trim().split('\n').pop() ?? '', 10);

  const task: HostTask = {
    id,
    host: host.name,
    target,
    agent: opts.agent,
    prompt: opts.prompt,
    pid: Number.isFinite(pid) ? pid : undefined,
    remoteLog,
    remoteExit,
    status: 'running',
    createdAt: new Date().toISOString(),
  };
  saveTask(task);

  if (opts.follow === false) {
    return { task };
  }

  const exitCode = await followHostTask(target, {
    remoteLog,
    remoteExit,
    taskId: id,
    echo: true,
    timeoutMs: opts.timeoutMs,
  });
  const finished = updateTask(id, {
    status: exitCode === 0 ? 'completed' : exitCode === -1 ? 'unknown' : 'failed',
    exitCode: exitCode === -1 ? undefined : exitCode,
    finishedAt: new Date().toISOString(),
  });
  return { task: finished ?? task, exitCode };
}
