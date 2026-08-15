/** Strict session resume convenience command. */
import { spawn } from 'child_process';
import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { resolveSessionMetadataValue } from './sessions.js';
import { sessionOwnerDevice, consumeResumePinned, RESUME_PINNED_ENV } from '../lib/session/resume-owner.js';

interface ResumeOptions {
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
  options: ResumeOptions,
): string[] {
  const args = ['resume', sessionId, ...(prompt === undefined ? [] : [prompt])];
  if (options.mode) args.push('--mode', options.mode);
  if (options.interactive) args.push('--interactive');
  if (options.headless) args.push('--headless');
  if (options.cwd) args.push('--cwd', options.cwd);
  if (options.quiet) args.push('--quiet');
  return args;
}

/** Translate `agents resume <id>` to the canonical `agents run` surface after
 * resolving the source identity. The run command remains the only executor. */
export function buildResumeRunArgs(
  session: { id: string; agent: string; version?: string },
  prompt: string | undefined,
  options: ResumeOptions,
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

export function registerResumeCommand(program: Command): void {
  const cmd = program
    .command('resume <session> [prompt]')
    .description('Resume a session by id, tmux alias, or exact label with its original harness, version, device, account, cwd, and mode. Searches the fleet automatically; a local full-id hit resumes with zero SSH.')
    .option('-m, --mode <mode>', 'Override the recorded launch mode')
    .option('-i, --interactive', 'Resume interactively even when a prompt is provided')
    .option('--headless', 'Resume headlessly (a prompt is required)')
    .option('--cwd <path>', 'Override the recorded working directory')
    .option('-q, --quiet', 'Suppress routing banners')
    .option('--here', 'Run on this machine even if the session belongs to another device')
    .action(async (sessionId: string, prompt: string | undefined, options: ResumeOptions) => {
      // Read (and clear) the routing pin before anything else, so it can never
      // reach the agent's own children.
      const pinnedHere = consumeResumePinned() || !!options.here;
      const outcome = await resolveSessionMetadataValue(sessionId.trim());
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
        // same one the picker already uses. Not the `--device` passthrough: that
        // one re-discovers locally and marks the run AGENTS_FLEET_REMOTE, which
        // a long-lived resumed session must not inherit.
        const { runOnPeer } = await import('../lib/session/remote-list.js');
        const rc = await runOnPeer(
          buildResumeRemoteArgs(outcome.session.id, prompt, options),
          owner,
          { tty: !!process.stdout.isTTY, env: { [RESUME_PINNED_ENV]: '1' } },
        );
        if (rc === 'no-target') {
          console.error(chalk.red(`Session ${outcome.session.shortId} lives on ${owner}, which isn't a reachable device right now.`));
          console.error(chalk.gray(`Register/wake it (agents devices), or run there: agents ssh ${owner}`));
          process.exitCode = 1;
        }
        return;
      }

      const args = buildResumeRunArgs(outcome.session, prompt, options);
      const child = spawn(process.execPath, [process.argv[1], ...args], {
        stdio: 'inherit',
        env: {
          ...process.env,
          // Avoid repeating the fleet lookup in the delegated local `run`
          // process. The value is metadata-only and is not forwarded over SSH;
          // the owner performs its own local SQLite lookup.
          AGENTS_RESUME_SOURCE_JSON: JSON.stringify(outcome.session),
        },
      });
      const exitCode = await new Promise<number>((resolve) => {
        child.once('error', () => resolve(127));
        child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      });
      process.exitCode = exitCode;
    });

  setHelpSections(cmd, {
    examples: `
      # Resume by full id
      agents resume 019fd0c8-b3e9-77a2-a1a4-444698c4d897

      # Resume and continue headlessly
      agents resume 019fd0c8-b3e9-77a2-a1a4-444698c4d897 "finish the tests"

      # Resume by exact label (auto-resumes the one match)
      agents resume "fix the flaky ssh test"

      # Resume by durable tmux alias or its unique suffix
      agents resume ag-codex-c1f3d813
      agents resume c1f3d813

      # Deliberately change permissions
      agents resume 019fd0c8-b3e9-77a2-a1a4-444698c4d897 --mode edit`,
    notes: `
      A full ID resolves from the local session database first (zero SSH) and, on a local miss, fans out with the first peer holding it cancelling the rest. An exact label always consults the fleet (labels are not globally unique) and auto-resumes the one match; a cross-machine label collision surfaces as an ambiguity.
      A session that ran on another device resumes ON that device over SSH — the harness's conversation state lives there, so running it here would start against state this machine does not have. --here overrides that and runs locally.
      Use agents run auto --resume <id> when the original account is unavailable and another harness may continue.`,
  });
}
