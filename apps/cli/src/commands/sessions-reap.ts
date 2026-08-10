import chalk from 'chalk';
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { reapDeadTmuxPanes } from '../lib/tmux/session.js';
import { getDefaultSocketPath } from '../lib/tmux/paths.js';

interface ReapOptions {
  json?: boolean;
  socket?: string;
  dryRun?: boolean;
}

export function registerSessionsReapCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('reap')
    .description('Kill tmux sessions whose panes are all dead, and the helper processes their agents left behind.')
    .option('--json', 'Emit a JSON result object instead of human output.')
    .option('--dry-run', 'List what would be reaped without killing anything.')
    .option('--socket <path>', 'Path to the tmux server socket (default: agents helper socket).');

  setHelpSections(cmd, {
    notes: [
      'Sessions stay open after their process exits because `remain-on-exit on` is set',
      'so the harness can inspect exit status. Killing the pane only SIGHUPs its',
      'foreground process group, so MCP servers and harness background daemons that',
      'moved out of that group outlive the agent. This command collects both.',
      '',
      'Safety: sessions with at least one live pane are never touched, and a helper',
      'process is killed only when its owning tmux session is gone, or that session',
      'has no attached client AND its agent process has exited.',
      '',
      'The routines daemon runs the same sweep every 5 minutes.',
    ].join('\n'),
    examples: [
      '# Reap dead sessions and orphaned helper processes',
      'agents sessions reap',
      '',
      '# See what would be reaped, without killing anything',
      'agents sessions reap --dry-run',
      '',
      '# JSON output (for scripts)',
      'agents sessions reap --json',
    ].join('\n'),
  });

  cmd.action(async (options: ReapOptions) => {
    const socket = options.socket ?? getDefaultSocketPath();
    const dryRun = options.dryRun === true;
    const result = await reapDeadTmuxPanes(socket, { dryRun });

    if (options.json) {
      console.log(JSON.stringify({
        dryRun,
        reaped: result.reaped,
        sessions: result.sessions,
        details: result.details,
        processes: result.processes,
        processDetails: result.processDetails,
        warnings: result.warnings,
      }));
      return;
    }

    for (const w of result.warnings) console.log(chalk.yellow(`warning: ${w}`));

    if (result.reaped === 0 && result.processes === 0) {
      console.log(chalk.gray('No dead tmux sessions or orphaned processes to reap.'));
      return;
    }

    const verb = dryRun ? chalk.yellow('would kill') : chalk.green('killed');
    for (const d of result.processDetails) console.log(`${verb} ${d}`);
    for (const d of result.details) console.log(`${verb} session ${d}`);

    const parts: string[] = [];
    if (result.reaped > 0) parts.push(`${result.reaped} session${result.reaped === 1 ? '' : 's'}`);
    if (result.processes > 0) parts.push(`${result.processes} orphaned process${result.processes === 1 ? '' : 'es'}`);
    console.log(chalk.gray(`\n${parts.join(' and ')} ${dryRun ? 'would be reaped.' : 'reaped.'}`));
  });
}
