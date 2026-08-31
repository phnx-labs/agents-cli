/**
 * Strict session resume — identity resolution, source-device routing, and
 * delegation to `agents run --resume`. Registered under `agents sessions resume`
 * (see sessions-resume.ts); this module owns the helpers + in-process action.
 */
import { spawn } from 'child_process';
import chalk from 'chalk';
import type { SessionMeta } from '../lib/session/types.js';
import { resolveSessionMetadataValue } from './sessions.js';
import { sessionOwnerDevice, consumeResumePinned, RESUME_PINNED_ENV } from '../lib/session/resume-owner.js';
import { machineId } from '../lib/machine-id.js';

export const RESUME_SOURCE_ENV = 'AGENTS_RESUME_SOURCE_JSON';

/**
 * The source a dead-remote local fallback resumes from: the same session, but
 * with `machine` rewritten to THIS box so the delegated `agents run --resume`
 * resolves recovery locally (`sessionRecoveryPeer` returns undefined) instead of
 * bouncing back to the unreachable owner. Because no local version home owns the
 * peer's transcript, that local recovery lands on a labelled `/continue` replay
 * from the synced mirror — the only way to continue a session whose owning device
 * is gone. Owner-approved prefer-device, fall-back-local (PHNX-3626).
 *
 * Safe against the RUSH-2022 "silent local resume forks live state" hazard by
 * PRECONDITION: this is reached only after `runOnPeer` proved the owner
 * unreachable, so there is no live process on the peer to fork, and the fallback
 * is announced with a log line — never silent.
 */
export function resumeLocalFallbackSource(session: SessionMeta, self: string = machineId()): SessionMeta {
  return { ...session, machine: self };
}

export interface StrictResumeOptions {
  mode?: string;
  interactive?: boolean;
  headless?: boolean;
  cwd?: string;
  quiet?: boolean;
  /** Run on THIS machine even when the session belongs to a peer (escape hatch). */
  here?: boolean;
}

/**
 * The argv to re-run this resume on the machine that owns the session.
 *
 * Deliberately carries no "don't route again" FLAG — that rides the
 * {@link RESUME_PINNED_ENV} export instead, so the hop also works against a peer
 * on an older CLI (see the constant's docs). Every argv token here exists in the
 * released surface.
 */
export function buildResumeRemoteArgs(
  sessionId: string,
  prompt: string | undefined,
  options: StrictResumeOptions,
): string[] {
  const args = ['sessions', 'resume', sessionId, ...(prompt === undefined ? [] : [prompt])];
  if (options.mode) args.push('--mode', options.mode);
  if (options.interactive) args.push('--interactive');
  if (options.headless) args.push('--headless');
  if (options.cwd) args.push('--cwd', options.cwd);
  if (options.quiet) args.push('--quiet');
  return args;
}

/** Translate `agents sessions resume <id>` to the canonical `agents run` surface after
 * resolving the source identity. The run command remains the only executor. */
export function buildResumeRunArgs(
  session: { id: string; agent: string; version?: string },
  prompt: string | undefined,
  options: StrictResumeOptions,
): string[] {
  const spec = session.version ? `${session.agent}@${session.version}` : session.agent;
  const args = ['run', spec, ...(prompt === undefined ? [] : [prompt]), '--resume', session.id];
  if (options.mode) args.push('--mode', options.mode);
  if (options.interactive) args.push('--interactive');
  if (options.headless) args.push('--headless');
  if (options.cwd) args.push('--cwd', options.cwd);
  if (options.quiet) args.push('--quiet');
  return args;
}

/** Recreate a remote Claude launch whose forced id never materialized a transcript. */
export function buildProvisionalRunArgs(
  session: { id: string; agent: string; version?: string; cwd?: string },
  prompt: string | undefined,
  options: StrictResumeOptions,
): string[] {
  const spec = session.version ? `${session.agent}@${session.version}` : session.agent;
  const args = ['run', spec, ...(prompt === undefined ? [] : [prompt]), '--session-id', session.id];
  if (options.mode) args.push('--mode', options.mode);
  if (options.interactive) args.push('--interactive');
  if (options.headless) args.push('--headless');
  const cwd = options.cwd ?? session.cwd;
  if (cwd) args.push('--cwd', cwd);
  if (options.quiet) args.push('--quiet');
  return args;
}

function consumeResumeSource(): { id: string; agent: string; version?: string; cwd?: string; filePath?: string } | undefined {
  const raw = process.env[RESUME_SOURCE_ENV];
  delete process.env[RESUME_SOURCE_ENV];
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (typeof value?.id === 'string' && typeof value?.agent === 'string') return value;
  } catch {
    // The routing pin is authoritative; malformed optional context is ignored.
  }
  return undefined;
}

/** True when the caller asked for the strict resume path (prompt and/or flags). */
export function wantsStrictResume(
  prompt: string | undefined,
  options: StrictResumeOptions,
): boolean {
  return (
    prompt !== undefined ||
    !!options.mode ||
    !!options.interactive ||
    !!options.headless ||
    !!options.cwd ||
    !!options.quiet ||
    !!options.here
  );
}

/**
 * Strict single-session resume: resolve id/label across the fleet, hop to the
 * owning device when needed, then delegate to `agents run --resume`.
 */
export async function runStrictResume(
  sessionId: string,
  prompt: string | undefined,
  options: StrictResumeOptions,
): Promise<void> {
  // Read (and clear) the routing pin before anything else, so it can never
  // reach the agent's own children.
  const routedHop = consumeResumePinned();
  const pinnedHere = routedHop || !!options.here;
  const routedSource = routedHop ? consumeResumeSource() : undefined;
  if (routedSource && routedSource.id !== sessionId.trim()) {
    console.error(chalk.red(
      `Resume routing metadata names session ${routedSource.id}, not requested session ${sessionId.trim()}.`,
    ));
    process.exitCode = 1;
    return;
  }
  // An owner hop must inspect only the owner's index. Fleet fan-out here can
  // rediscover the dispatcher's synthetic row and bounce the same id forever.
  const outcome = await resolveSessionMetadataValue(sessionId.trim(), pinnedHere ? { local: true } : {});
  if (outcome.kind === 'partial') {
    // RUSH-2492: an unreachable peer is a warning, not a hard failure. The
    // resolver already resolves an id found on the reachable fleet (SES-9a),
    // so reaching here means the session was not found on any device we COULD
    // reach — it may live on an unreachable peer, which we could not check.
    const offline = outcome.failedPeers;
    console.error(chalk.yellow(`Warning: ${offline.length} device(s) unreachable, not checked: ${offline.join(', ')}`));
    console.error(chalk.red(`No session matching "${sessionId}" on any reachable device (${offline.length} unreachable, not checked).`));
    console.error(chalk.gray('  If it lives on an offline box, wake it (agents devices) or run there: agents ssh <device>'));
    process.exitCode = 1;
    return;
  }
  if (outcome.kind === 'not-found') {
    if (routedHop && routedSource?.filePath === '' && routedSource.agent === 'claude') {
      const args = buildProvisionalRunArgs(routedSource, prompt, options);
      const child = spawn(process.execPath, [process.argv[1], ...args], {
        stdio: 'inherit',
        env: process.env,
      });
      const exitCode = await new Promise<number>((resolve) => {
        child.once('error', () => resolve(127));
        child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      });
      process.exitCode = exitCode;
      return;
    }
    console.error(chalk.red(`No session matching "${sessionId}".`));
    process.exitCode = 1;
    return;
  }
  if (outcome.kind === 'ambiguous') {
    console.error(chalk.red(`"${sessionId}" matches ${outcome.candidates.length} sessions. Pass the full session id.`));
    process.exitCode = 1;
    return;
  }

  // The harness keeps its conversation state on the machine that produced
  // the session, so a peer-owned session MUST resume there. Running it here
  // starts the agent against state this box does not have — silently, since
  // a synced mirror makes the transcript look local (RUSH-2022).
  const owner = pinnedHere ? undefined : sessionOwnerDevice(outcome.session);
  if (owner) {
    if (!options.quiet) {
      process.stderr.write(chalk.gray(`[agents] session ${outcome.session.shortId} belongs to ${owner} → resuming there\n`));
    }
    // `runOnPeer` is the existing transport for "this session's transcript
    // and agent binary are on that box" (lib/session/remote-list.ts) — the
    // same one the picker already uses. Not the `--host` passthrough: that
    // one re-discovers locally and marks the run AGENTS_FLEET_REMOTE, which
    // a long-lived resumed session must not inherit.
    const { runOnPeer } = await import('../lib/session/remote-list.js');
    const rc = await runOnPeer(
      buildResumeRemoteArgs(outcome.session.id, prompt, options),
      owner,
      {
        tty: !!process.stdout.isTTY,
        env: {
          [RESUME_PINNED_ENV]: '1',
          [RESUME_SOURCE_ENV]: JSON.stringify(outcome.session),
        },
        sessionId: outcome.session.id,
      },
    );
    if (rc === 'no-target' || rc === 'unreachable') {
      // Prefer-device, fall back to local (PHNX-3626): the owning device is
      // unreachable — either not a dialable registered device ('no-target') or
      // registered but offline/asleep so the SSH connection itself failed
      // ('unreachable'). Either way there is no live harness to reach OR to fork,
      // so continue the session HERE from its synced mirror rather than
      // dead-ending. The local recovery resolves this to a labelled `/continue`
      // replay (no local home owns the peer's transcript), the honest degradation.
      if (!options.quiet) {
        process.stderr.write(chalk.yellow(
          `[agents] session ${outcome.session.shortId} belongs to ${owner}, which is unreachable → resuming locally (/continue replay from the synced transcript)\n`,
        ));
      }
      process.exitCode = await delegateLocalResume(resumeLocalFallbackSource(outcome.session), prompt, options);
    }
    return;
  }

  process.exitCode = await delegateLocalResume(outcome.session, prompt, options);
}

/**
 * Spawn the delegated local `agents run --resume` for a session this box owns
 * (or is falling back to). The run command remains the sole executor; recovery
 * (native vs `/continue`) is resolved there. Returns the child's exit code.
 */
async function delegateLocalResume(
  session: SessionMeta,
  prompt: string | undefined,
  options: StrictResumeOptions,
): Promise<number> {
  const args = buildResumeRunArgs(session, prompt, options);
  const child = spawn(process.execPath, [process.argv[1], ...args], {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Avoid repeating the fleet lookup in the delegated local `run`
      // process. The value is metadata-only and is not forwarded over SSH;
      // the owner performs its own local SQLite lookup.
      [RESUME_SOURCE_ENV]: JSON.stringify(session),
    },
  });
  return new Promise<number>((resolve) => {
    child.once('error', () => resolve(127));
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
