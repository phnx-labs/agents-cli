/**
 * Register host-dispatched runs (`agents run --host <h>`) into the LOCAL session
 * index so they show up in `agents sessions` and are resolvable by id — even
 * though the transcript itself lives on the remote host.
 *
 * The transcript file is remote, so the row is registered with an EMPTY
 * `file_path`. The DB's stale-row filter keeps rows with no file_path
 * (`!file_path || existsSync(file_path)` in db.ts querySessions) precisely for
 * this "synthetic file_path" case, and the scanner never prunes session rows —
 * so the entry survives rescans. `cwd` is the LOCAL directory the dispatch was
 * issued from, so the run appears in that project's session listing like any
 * local run. The `[host/<name>]` label mirrors the cloud path's
 * `[cloud/<status>]` convention.
 */

import { upsertSession } from '../session/db.js';
import type { SessionMeta, SessionAgentId } from '../session/types.js';
import { SESSION_AGENTS } from '../session/types.js';
import type { HostTask } from './tasks.js';

export interface HostSessionContext {
  /** Local directory the `agents run --host` was invoked from. */
  cwd: string;
  /** Prompt the run was launched with, used for the session topic. */
  prompt: string;
}

/**
 * Build the SessionMeta for a host-dispatched run. Returns null when the run has
 * no captured session id (nothing stable to key/resume on) or its agent isn't a
 * known session agent. Pure — no I/O — so the mapping is unit-testable.
 */
export function hostSessionMeta(task: HostTask, ctx: HostSessionContext): SessionMeta | null {
  const id = task.sessionId;
  if (!id) return null;
  if (!SESSION_AGENTS.includes(task.agent as SessionAgentId)) return null;

  return {
    id,
    shortId: id.slice(0, 8),
    agent: task.agent as SessionAgentId,
    timestamp: task.createdAt,
    cwd: ctx.cwd,
    // Remote transcript — no local file. Empty file_path is the sentinel the DB
    // stale-filter treats as "always live" (see module doc).
    filePath: '',
    topic: ctx.prompt.split('\n')[0]?.slice(0, 120) || undefined,
    // The run's `--name` seeds the label (resolves `agents sessions <name>` and
    // `agents hosts logs <name>`); an unnamed host run falls back to the
    // `[host/<name>]` indicator, mirroring the cloud path's `[cloud/<status>]`.
    label: task.name || `[host/${task.host}]`,
  };
}

/**
 * Register (or refresh) a host-dispatched run in the local session index. No-op
 * when the task carries no session id. Best-effort: a failed write must never
 * break the dispatch itself, which has already been launched on the host.
 */
export function registerHostSession(task: HostTask, ctx: HostSessionContext): void {
  const meta = hostSessionMeta(task, ctx);
  if (!meta) return;
  try {
    upsertSession(meta, '');
  } catch {
    /* index write is best-effort; the run is already live on the host */
  }
}

export interface InteractiveHostSessionContext {
  cwd: string;
  host: string;
  agent: string;
  sessionId: string;
  name?: string;
  createdAt?: string;
}

/**
 * Register an interactive host run (no prompt, TTY forwarded over SSH) in the
 * local session index. Unlike detached host runs, there is no remote log/exit
 * file and no HostTask; we only need the session id so `agents sessions` can
 * surface and resume it by id.
 */
export function registerInteractiveHostSession(ctx: InteractiveHostSessionContext): void {
  if (!SESSION_AGENTS.includes(ctx.agent as SessionAgentId)) return;
  try {
    upsertSession(
      {
        id: ctx.sessionId,
        shortId: ctx.sessionId.slice(0, 8),
        agent: ctx.agent as SessionAgentId,
        timestamp: ctx.createdAt ?? new Date().toISOString(),
        cwd: ctx.cwd,
        filePath: '',
        label: ctx.name || `[host/${ctx.host}]`,
      },
      '',
    );
  } catch {
    /* index write is best-effort; the run is already live on the host */
  }
}
