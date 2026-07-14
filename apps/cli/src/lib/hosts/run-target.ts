/**
 * Shared host-run dispatch — the one path every surface uses to run an agent on
 * another machine: `agents run --host` (commands/exec.ts), the `host` cloud
 * provider (`agents cloud run --provider host`), and host-placed routines.
 *
 * Wraps the two steps every caller needs and previously lived inline in
 * exec.ts's `--host` branch:
 *   1. resolution — name → capability tag → error, with the same fall-through
 *      semantics as `agents run --host` (only "Multiple hosts tagged…" is a
 *      resolution verdict; "no host tagged" degrades to unknown-host), and
 *   2. headless dispatch — session-id mint (Claude only), detached SSH launch,
 *      and LOCAL session-index registration so the run shows in `agents sessions`.
 *
 * Interactive dispatch stays in exec.ts: it is inherently tied to the caller's
 * TTY and has no other consumers.
 */

import { randomUUID } from 'crypto';
import type { Host } from './types.js';
import { resolveHost, resolveHostByCap } from './registry.js';
import { dispatchToHost } from './dispatch.js';
import type { DispatchResult } from './dispatch.js';
import { registerHostSession } from './session-index.js';

/**
 * Resolution failed with a user-actionable message the caller should print
 * verbatim. Distinct from `DeviceOffloadUnsupportedError` (which propagates to
 * the top-level catch) so callers can tell "bad name" from "bad auth method".
 */
export class HostResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostResolutionError';
  }
}

/**
 * Resolve a `--host` value the way `agents run` does: exact name (providers →
 * devices → `user@host`), then capability tag. Throws `HostResolutionError`
 * for an ambiguous tag or an unknown name; lets `DeviceOffloadUnsupportedError`
 * (password-auth device) propagate untouched for the top-level catch.
 */
export async function resolveHostRunTarget(name: string, opts: { any?: boolean } = {}): Promise<Host> {
  let host = await resolveHost(name);
  if (!host) {
    try {
      host = await resolveHostByCap(name, opts.any);
    } catch (e) {
      const msg = (e as Error).message ?? '';
      // Ambiguity is a verdict, not a miss — surface it. "No host tagged"
      // falls through to the generic unknown-host error below.
      if (msg.startsWith('Multiple hosts')) throw new HostResolutionError(msg);
    }
  }
  if (!host) throw new HostResolutionError(`Unknown host "${name}". List hosts: agents hosts list`);
  return host;
}

export interface HostPromptRun {
  agent: string;
  prompt: string;
  mode?: string;
  model?: string;
  /** Durable `--name <slug>` handle recorded on the task. */
  name?: string;
  /** Resume an existing session on the host by concrete id. */
  resume?: string;
  /** Working directory on the host, already made remote-portable by the caller. */
  remoteCwd?: string;
  /** Stream progress and block until completion (default true). */
  follow?: boolean;
  timeoutMs?: number;
  /** Local directory to record in the session index (defaults to process.cwd()). */
  cwd?: string;
}

/**
 * Dispatch a headless prompt run onto a resolved host: mint the forced session
 * id (Claude is the only agent that accepts `--session-id`; on resume the
 * remote session keeps its id), launch detached over SSH, and register the run
 * in the LOCAL session index. Returns the task record and the remote exit code
 * (`-1` = follow window closed while the run continues).
 */
export async function dispatchPromptToHost(host: Host, opts: HostPromptRun): Promise<DispatchResult> {
  const sessionId = opts.agent === 'claude' && !opts.resume ? randomUUID() : undefined;
  const result = await dispatchToHost(host, {
    agent: opts.agent,
    prompt: opts.prompt,
    mode: opts.mode,
    model: opts.model,
    remoteCwd: opts.remoteCwd,
    sessionId,
    name: opts.name,
    resume: opts.resume,
    follow: opts.follow !== false,
    timeoutMs: opts.timeoutMs,
  });
  registerHostSession(result.task, { cwd: opts.cwd ?? process.cwd(), prompt: opts.prompt });
  return result;
}
