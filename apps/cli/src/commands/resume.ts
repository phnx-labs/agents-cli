/** Strict session resume convenience command. */
import { spawn } from 'child_process';
import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { resolveSessionMetadataValue } from './sessions.js';

interface ResumeOptions {
  mode?: string;
  interactive?: boolean;
  headless?: boolean;
  cwd?: string;
  quiet?: boolean;
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
    .description('Resume a session by full id, unique id prefix, or exact label with its original harness, version, device, account, cwd, and mode. Searches the fleet automatically; a local full-id hit resumes with zero SSH.')
    .option('-m, --mode <mode>', 'Override the recorded launch mode')
    .option('-i, --interactive', 'Resume interactively even when a prompt is provided')
    .option('--headless', 'Resume headlessly (a prompt is required)')
    .option('--cwd <path>', 'Override the recorded working directory')
    .option('-q, --quiet', 'Suppress routing banners')
    .action(async (sessionId: string, prompt: string | undefined, options: ResumeOptions) => {
      const outcome = await resolveSessionMetadataValue(sessionId.trim());
      if (outcome.kind === 'partial') {
        console.error(chalk.red(`Could not resolve session while these devices were unavailable: ${outcome.failedPeers.join(', ')}`));
        process.exitCode = 2;
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

      # Deliberately change permissions
      agents resume 019fd0c8-b3e9-77a2-a1a4-444698c4d897 --mode edit`,
    notes: `
      A full ID resolves from the local session database first (zero SSH) and, on a local miss, fans out with the first peer holding it cancelling the rest. An exact label always consults the fleet (labels are not globally unique) and auto-resumes the one match; a cross-machine label collision surfaces as an ambiguity.
      Use agents run auto --resume <id> when the original account is unavailable and another harness may continue.`,
  });
}
