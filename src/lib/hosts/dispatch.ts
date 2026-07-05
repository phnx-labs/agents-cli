/**
 * Dispatch a headless `agents …` command onto a host over SSH.
 *
 * The command is launched detached (`nohup … &`) writing combined output to a
 * remote log and its exit code to a sibling `.exit` file, so progress survives a
 * dropped connection (followed via offset-tail in progress.ts). This is the
 * offload win: the process/thread/file fan-out happens on the host, not the
 * laptop. `agents run` uses it; `agents teams start --watch --host` reuses the
 * same core so a remote team supervisor keeps running after you disconnect.
 */

import { randomUUID } from 'crypto';
import { sshExec, shellQuote } from '../ssh-exec.js';
import type { Host } from './types.js';
import { sshTargetFor } from './types.js';
import { ensureHostReady } from './ready.js';
import { remoteShellFor } from './remote-cmd.js';
import { resolveRemoteOsSync } from './remote-os.js';
import { saveTask, updateTask, terminalPatch, type HostTask } from './tasks.js';
import { followHostTask } from './progress.js';

// Use $HOME (not ~) so the path is correct whether or not it's quoted and
// regardless of the run's cwd. Task ids are 8 hex chars, so these paths are
// injection-safe to interpolate unquoted into remote commands.
const REMOTE_DIR = '$HOME/.agents/.cache/hosts';

export interface DispatchResult {
  task: HostTask;
  /** Exit code when followed; undefined when detached (--no-follow). */
  exitCode?: number;
}

/** Options shared by every detached dispatch. */
interface LaunchOptions {
  /** `agents …` args (command name first), each already un-quoted (we quote them). */
  forwardedArgs: string[];
  remoteCwd?: string;
  /** Stream progress and block until completion (default true). */
  follow?: boolean;
  timeoutMs?: number;
  /** Task-record labels for `agents hosts ps`. */
  agentLabel: string;
  promptLabel: string;
  /** Session id the run was launched with, persisted on the task record. */
  sessionId?: string;
}

/**
 * The launch + task-record + optional follow core. Both `dispatchToHost` (run)
 * and `dispatchAgentsCommand` (teams) build their `forwardedArgs` and call here,
 * so the nohup/exit-file/offset-tail machinery lives in exactly one place.
 *
 * Windows remotes are refused up front: the detached launch is only half the
 * contract — the follow/reconcile layer (`progress.ts`/`reconcile.ts`) offset-
 * tails the log with POSIX `tail -c`/`printf`/`cat`/`stat`, which do not exist
 * in cmd.exe/PowerShell. Shipping the launch alone would leave `run --host
 * <windows>` dispatching but hanging on follow forever, so we fail fast with an
 * actionable message instead. Read-only `--host` commands (view/sessions/…) run
 * a single round-trip with no follow protocol and DO work against Windows.
 */
async function launchDetached(host: Host, target: string, opts: LaunchOptions): Promise<DispatchResult> {
  if (remoteShellFor(resolveRemoteOsSync(host.name)) === 'powershell') {
    throw new Error(
      `Detached dispatch to Windows host "${host.name}" is not supported yet — the run ` +
        `follow/reconcile layer is POSIX-only (offset-tails the remote log with tail/cat/stat). ` +
        `Read-only --host commands (view, sessions, usage, cost, doctor, list, teams) do work ` +
        `against Windows.`,
    );
  }
  const id = randomUUID().slice(0, 8);
  const remoteLog = `${REMOTE_DIR}/${id}.log`;
  const remoteExit = `${REMOTE_DIR}/${id}.exit`;

  // Inner command run under a login shell so PATH resolves `agents`.
  const invocation = ['agents', ...opts.forwardedArgs].map(shellQuote).join(' ');
  const cwd = opts.remoteCwd ? `cd ${shellQuote(opts.remoteCwd)} && ` : '';
  const inner = `${cwd}${invocation} > ${remoteLog} 2>&1; echo $? > ${remoteExit}`;

  // Outer: ensure dir, launch detached under bash -lc, print the PID.
  const launch = `mkdir -p ${REMOTE_DIR}; nohup bash -lc ${shellQuote(inner)} >/dev/null 2>&1 & echo $!`;
  const res = sshExec(target, launch, { timeoutMs: 30000, multiplex: true });
  if (res.code !== 0) {
    throw new Error(`Failed to launch on "${host.name}": ${(res.stderr || res.stdout).trim() || 'ssh error'}`);
  }
  const pid = parseInt(res.stdout.trim().split('\n').pop() ?? '', 10);

  const task: HostTask = {
    id,
    host: host.name,
    target,
    agent: opts.agentLabel,
    prompt: opts.promptLabel,
    pid: Number.isFinite(pid) ? pid : undefined,
    sessionId: opts.sessionId,
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
  // -1 = the follow window closed while the run continues on the host. Leave the
  // record 'running' (do NOT freeze it terminal) so a later `hosts ps`/`logs`
  // reconcile against the remote `.exit` resolves the true final status.
  const finished = exitCode === -1 ? task : (updateTask(id, terminalPatch(exitCode)) ?? task);
  return { task: finished, exitCode };
}

export interface DispatchOptions {
  agent: string;
  prompt: string;
  mode?: string;
  model?: string;
  remoteCwd?: string;
  /**
   * Force the remote run's NEW session to use this exact id (Claude only, via
   * `agents run --session-id`). Captured on the task record so the run is
   * resumable by id. Mutually exclusive with `resume`.
   */
  sessionId?: string;
  /** Resume an existing session on the host by id (via `agents run --resume`). */
  resume?: string;
  /** Stream progress and block until completion (default true). */
  follow?: boolean;
  timeoutMs?: number;
}

/**
 * Build the remote `agents run …` argv for a host dispatch. Pure so the
 * session-id / resume flag wiring is unit-testable without an SSH round-trip.
 * `--session-id` and `--resume` are mutually exclusive (the CLI rejects both);
 * resume wins when — defensively — both are set.
 */
export function buildRunForwardedArgs(opts: DispatchOptions): string[] {
  const args = ['run', opts.agent, opts.prompt, '--quiet'];
  if (opts.mode) args.push('--mode', opts.mode);
  if (opts.model) args.push('--model', opts.model);
  if (opts.resume) args.push('--resume', opts.resume);
  else if (opts.sessionId) args.push('--session-id', opts.sessionId);
  return args;
}

/** Dispatch an `agents run <agent> "<prompt>"` onto a host (the `run --host` path). */
export async function dispatchToHost(host: Host, opts: DispatchOptions): Promise<DispatchResult> {
  const target = sshTargetFor(host);
  const { warnings } = ensureHostReady(host, { agent: opts.agent });
  for (const w of warnings) process.stderr.write(`[hosts] warning: ${w}\n`);

  return launchDetached(host, target, {
    forwardedArgs: buildRunForwardedArgs(opts),
    remoteCwd: opts.remoteCwd,
    follow: opts.follow,
    timeoutMs: opts.timeoutMs,
    agentLabel: opts.agent,
    promptLabel: opts.prompt,
    // On resume the remote session keeps its existing id; record that id so the
    // task stays mapped to the same session.
    sessionId: opts.resume ?? opts.sessionId,
  });
}

export interface CommandDispatchOptions {
  /** `agents …` args (command name first), already stripped of routing flags. */
  forwardedArgs: string[];
  remoteCwd?: string;
  follow?: boolean;
  timeoutMs?: number;
}

/**
 * Dispatch an arbitrary long-running `agents <command>` onto a host detached —
 * used for `teams start --watch --host`, whose supervisor must outlive the SSH
 * connection. Reachability is assumed (the caller has already resolved the host);
 * a launch failure surfaces the remote stderr.
 */
export async function dispatchAgentsCommand(host: Host, opts: CommandDispatchOptions): Promise<DispatchResult> {
  const target = sshTargetFor(host);
  return launchDetached(host, target, {
    forwardedArgs: opts.forwardedArgs,
    remoteCwd: opts.remoteCwd,
    follow: opts.follow,
    timeoutMs: opts.timeoutMs,
    agentLabel: opts.forwardedArgs[0] ?? 'agents',
    promptLabel: opts.forwardedArgs.join(' '),
  });
}
