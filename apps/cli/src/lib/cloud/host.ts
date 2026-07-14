/**
 * Host cloud provider — your own machines as a task-execution backend.
 *
 * A thin adapter over the hosts subsystem (lib/hosts/*): `agents cloud run
 * --provider host --host <name>` dispatches through the SAME detached-SSH
 * launch as `agents run --host`, and the resulting task shows up in BOTH
 * `agents cloud ps` and `agents hosts ps` — one store (the host-task sidecars
 * under ~/.agents/.cache/hosts/), two views. No new transport, no relay: SSH
 * is the only wire, exactly like the rest of the hosts design (docs/hosts.md).
 *
 * Status semantics follow reconcile.ts's prime rule: completion is only ever
 * CONFIRMED from the remote `.exit` file — an unreachable host leaves a task
 * `running`, never guessed as failed. The cloud SQLite store row is a cached
 * index (the `cloud list` refresh loop upserts what `status()` returns); the
 * sidecar stays the source of truth. Reachability is memoized per target for
 * the life of the process so a down host costs ONE short timeout, not one per
 * task ("care around the cloud status-refresh path", lib/hosts/tasks.ts).
 */

import type {
  CloudEvent,
  CloudProvider,
  CloudTarget,
  CloudTask,
  CloudTaskStatus,
  DispatchOptions,
  ProviderCapabilities,
} from './types.js';
import { MissingTargetError, resolveDispatchRepos } from './types.js';
import type { HostTask } from '../hosts/tasks.js';
import { listTasks, loadTask, terminalPatch, updateTask } from '../hosts/tasks.js';
import { readRemoteExit } from '../hosts/reconcile.js';
import { sshReachable } from '../ssh-exec.js';
import { fetchProgress } from '../hosts/progress.js';
import { dispatchPromptToHost, resolveHostRunTarget } from '../hosts/run-target.js';
import { listAllHosts } from '../hosts/registry.js';
import { terminateDispatchedTask } from '../hosts/dispatch.js';

/** Host-task lifecycle → canonical cloud enum. `unknown` stays `running`
 *  (completion is confirmed, never guessed — reconcile.ts's rule). */
function toCloudStatus(status: HostTask['status']): CloudTaskStatus {
  switch (status) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'running':
    case 'unknown':
    default:
      return 'running';
  }
}

/** Project a host-task sidecar into the cloud task shape. */
export function hostTaskToCloudTask(task: HostTask): CloudTask {
  return {
    id: task.id,
    provider: 'host',
    status: toCloudStatus(task.status),
    agent: task.agent,
    prompt: task.prompt,
    createdAt: task.createdAt,
    updatedAt: task.finishedAt ?? task.createdAt,
    summary: `on ${task.host}${task.name ? ` as "${task.name}"` : ''}`,
  };
}

export class HostCloudProvider implements CloudProvider {
  readonly id = 'host' as const;
  readonly name = 'Host (your machines)';
  readonly targetKind = 'host' as const;

  /**
   * Reachability memo, per target, for the life of this process. The cloud
   * refresh loop calls `status()` once per active task; without the memo a
   * down host would cost one ~6s ssh timeout PER task instead of one total.
   * CLI processes are short-lived, so staleness is bounded by the invocation.
   */
  private reachable = new Map<string, boolean>();

  capabilities(): ProviderCapabilities {
    return {
      available: true, // ssh is the only dependency; per-host reachability is probed at dispatch
      dispatch: true,
      status: true,
      list: true,
      stream: true,
      cancel: true,
      message: true, // gated per task: needs the sessionId only Claude runs carry
      multiRepo: false,
      skills: false,
      images: false,
    };
  }

  async dispatch(options: DispatchOptions): Promise<CloudTask> {
    const hostName = options.providerOptions?.host as string | undefined;
    if (!hostName) {
      throw new MissingTargetError(
        'host',
        'No host given. Pass --host <name> (a registered host, a device, a capability tag, or user@host).',
        'List your machines: agents hosts list  ·  register more: agents devices sync / agents hosts add',
      );
    }
    if (resolveDispatchRepos(options).length > 0) {
      throw new Error(
        '--repo has no meaning for --provider host — the run executes in a directory on the machine, not a cloned repo. ' +
          'Pass the working directory via providerOptions.remoteCwd (CLI: --remote-cwd) instead.',
      );
    }
    if (options.branch) {
      throw new Error('--branch has no meaning for --provider host (no clone step). Check out the branch on the host, or use --remote-cwd.');
    }

    // DeviceOffloadUnsupportedError / HostResolutionError propagate — both carry
    // actionable messages the CLI prints verbatim.
    const host = await resolveHostRunTarget(hostName, {
      any: options.providerOptions?.any === true,
    });
    const { task } = await dispatchPromptToHost(host, {
      agent: options.agent ?? 'claude',
      prompt: options.prompt,
      mode: options.providerOptions?.mode as string | undefined,
      model: options.model,
      timeout: options.timeout,
      remoteCwd: options.providerOptions?.remoteCwd as string | undefined,
      name: options.providerOptions?.name as string | undefined,
      follow: false, // the cloud pipeline streams via stream(); never block dispatch
    });
    return hostTaskToCloudTask(task);
  }

  async status(taskId: string): Promise<CloudTask> {
    const task = loadTask(taskId);
    if (!task) throw new Error(`Unknown host task: ${taskId}`);
    return hostTaskToCloudTask(this.reconcileMemoized(task));
  }

  async list(filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]> {
    const tasks = listTasks().map((t) => hostTaskToCloudTask(this.reconcileMemoized(t)));
    return filter?.status ? tasks.filter((t) => t.status === filter.status) : tasks;
  }

  /**
   * `reconcileTask` with the per-process reachability memo folded in: probe a
   * target at most once per process; a down host leaves its tasks `running`.
   */
  private reconcileMemoized(task: HostTask): HostTask {
    if (task.status !== 'running') return task;
    if (!this.reachable.has(task.target)) {
      this.reachable.set(task.target, sshReachable(task.target, 6000));
    }
    if (!this.reachable.get(task.target)) return task;
    const st = readRemoteExit(task.target, task.remoteExit);
    if (st.state !== 'done') return task;
    return updateTask(task.id, terminalPatch(st.code)) ?? task;
  }

  /**
   * Offset-tail the remote log (the same one-round-trip fetch the `run --host`
   * follow uses) and yield it as `text` events until the `.exit` file lands.
   */
  async *stream(taskId: string): AsyncIterable<CloudEvent> {
    const task = loadTask(taskId);
    if (!task) throw new Error(`Unknown host task: ${taskId}`);
    if (task.status !== 'running') {
      yield { type: 'status', status: toCloudStatus(task.status) };
      yield { type: 'done', status: toCloudStatus(task.status) };
      return;
    }

    let offset = 0;
    const fastPollMs = 1500;
    const maxPollMs = 6000;
    let pollMs = fastPollMs;
    for (;;) {
      const fetched = fetchProgress(task.target, {
        remoteLog: task.remoteLog,
        remoteExit: task.remoteExit,
        taskId: task.id,
        offset,
      });
      if (fetched) {
        if (fetched.logChunk.length > 0) {
          offset += fetched.logChunk.length;
          pollMs = fastPollMs; // output is flowing — snap back to the fast poll
          yield { type: 'text', content: fetched.logChunk.toString('utf8') };
        } else {
          pollMs = Math.min(Math.round(pollMs * 1.5), maxPollMs); // idle backoff
        }
        const exit = fetched.exit.trim();
        if (exit !== '') {
          const code = Number.parseInt(exit, 10);
          const finished = updateTask(task.id, terminalPatch(Number.isFinite(code) ? code : 0));
          const status = toCloudStatus(finished?.status ?? (code === 0 ? 'completed' : 'failed'));
          yield { type: 'done', status };
          return;
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async cancel(taskId: string): Promise<void> {
    const task = loadTask(taskId);
    if (!task) throw new Error(`Unknown host task: ${taskId}`);
    terminateDispatchedTask(task);
  }

  /**
   * Follow-up message = resume the run's session on the same host. Only runs
   * that captured a session id (Claude — the one agent that takes
   * `--session-id`) can be resumed; others get an actionable refusal.
   */
  async message(taskId: string, content: string): Promise<void> {
    const task = loadTask(taskId);
    if (!task) throw new Error(`Unknown host task: ${taskId}`);
    if (!task.sessionId) {
      throw new Error(
        `Host task ${taskId} has no session id to resume (only Claude runs capture one). ` +
          `Start a follow-up run instead: agents run ${task.agent} "<prompt>" --host ${task.host}`,
      );
    }
    const host = await resolveHostRunTarget(task.host);
    await dispatchPromptToHost(host, {
      agent: task.agent,
      prompt: content,
      resume: task.sessionId,
      name: task.name,
      follow: false,
    });
  }

  /** The unified host pool (enrolled hosts ∪ devices), dispatchable ones only. */
  async listTargets(): Promise<CloudTarget[]> {
    const hosts = await listAllHosts();
    return hosts
      .filter((h) => h.dispatchable !== false)
      .map((h) => ({
        id: h.name,
        label: [
          h.provider === 'devices' ? 'device' : h.source,
          h.os,
          h.status && h.status !== 'unknown' ? h.status : undefined,
          h.caps?.length ? `caps: ${h.caps.join(',')}` : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
        kind: 'host' as const,
      }));
  }
}
