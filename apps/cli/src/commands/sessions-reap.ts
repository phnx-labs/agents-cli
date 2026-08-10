import chalk from 'chalk';
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { reapDeadTmuxPanes } from '../lib/tmux/session.js';
import { getDefaultSocketPath } from '../lib/tmux/paths.js';

interface ReapOptions {
  json?: boolean;
  socket?: string;
}

export function registerSessionsReapCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('reap')
    .description('Kill tmux sessions whose panes are all dead.')
    .option('--json', 'Emit a JSON result object instead of human output.')
    .option('--socket <path>', 'Path to the tmux server socket (default: agents helper socket).');

  setHelpSections(cmd, {
    notes: [
      'Sessions stay open after their process exits because `remain-on-exit on` is set',
      'so the harness can inspect exit status. This command cleans them up on demand.',
      '',
      'Safety: sessions with at least one live pane are never touched.',
    ].join('\n'),
    examples: [
      '# Reap dead sessions interactively',
      'agents sessions reap',
      '',
      '# JSON output (for scripts)',
      'agents sessions reap --json',
    ].join('\n'),
  });

  cmd.action(async (options: ReapOptions) => {
    const socket = options.socket ?? getDefaultSocketPath();
    const result = await reapDeadTmuxPanes(socket);

    if (options.json) {
      console.log(JSON.stringify({ reaped: result.reaped, sessions: result.sessions, details: result.details }));
      return;
    }

    if (result.reaped === 0) {
      console.log(chalk.gray('No dead tmux sessions to reap.'));
      return;
    }

    for (const d of result.details) {
      console.log(chalk.green('reaped') + ' ' + d);
    }
    console.log(chalk.gray(`\n${result.reaped} session${result.reaped === 1 ? '' : 's'} reaped.`));
  });
}
