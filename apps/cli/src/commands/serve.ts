/**
 * `agents serve` — read-only local web companion.
 *
 * Boots a localhost-only (127.0.0.1) HTTP + SSE server that renders a live
 * dashboard of team status + per-worktree diffs, scheduled routines, and cloud
 * tasks. Everything is a viewer over data other commands already own — there
 * are no mutation endpoints. See src/lib/serve/.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { startServeServer, DEFAULT_SERVE_PORT, SERVE_HOST } from '../lib/serve/server.js';
import { startControlServer } from '../lib/serve/control.js';
import { ensureControlToken } from '../lib/serve/token.js';

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Read-only local web companion: team diffs, routines, and cloud status (binds 127.0.0.1 only).')
    .option('-p, --port <n>', `Port to bind on ${SERVE_HOST}`, String(DEFAULT_SERVE_PORT))
    .option('--interval <ms>', 'SSE refresh cadence in milliseconds', '3000')
    .option(
      '--control',
      'Authenticated control mode (RUSH-1731): adds bearer-gated POST /api/run and /api/session/:id/message so the iOS cockpit can dispatch + steer. Enables binding beyond loopback — pair a device with `agents devices pair-ios`.',
      false,
    )
    .option(
      '--bind <addr>',
      'Address to bind in --control mode (e.g. your tailnet IP, or 0.0.0.0). Ignored without --control; read-only serve is always loopback.',
      SERVE_HOST,
    )
    .action(async (opts: { port?: string; interval?: string; control?: boolean; bind?: string }) => {
      const port = parseInt(opts.port ?? '', 10) || DEFAULT_SERVE_PORT;
      const intervalMs = parseInt(opts.interval ?? '', 10) || 3000;

      try {
        if (opts.control) {
          const bind = opts.bind || SERVE_HOST;
          const minted = ensureControlToken('default');
          const { server, port: bound } = await startControlServer(port, bind, {
            cwd: process.cwd(),
            intervalMs,
          });
          const url = `http://${bind}:${bound}`;
          console.log(`${chalk.green('agents serve --control')} ${chalk.dim('→')} ${chalk.cyan(url)}`);
          if (minted.created) {
            console.log(chalk.yellow('New control token (shown once — store it in the cockpit now):'));
            console.log(`  ${chalk.bold(minted.token)}  ${chalk.dim(`(id ${minted.id})`)}`);
          } else {
            console.log(chalk.dim('Using existing control token(s). Issue another with `agents devices pair-ios`.'));
          }
          if (bind !== SERVE_HOST) {
            console.log(chalk.dim('bearer-gated · bind beyond loopback — keep this on the tailnet, never public Funnel · Ctrl-C to stop'));
          } else {
            console.log(chalk.dim('bearer-gated · loopback (pass --bind <tailnet-ip> to reach it from the phone) · Ctrl-C to stop'));
          }

          const shutdown = () => server.close(() => process.exit(0));
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
          return;
        }

        const { server, port: bound } = await startServeServer(port, {
          cwd: process.cwd(),
          intervalMs,
        });
        const url = `http://${SERVE_HOST}:${bound}`;
        console.log(`${chalk.green('agents serve')} ${chalk.dim('→')} ${chalk.cyan(url)}`);
        console.log(chalk.dim('read-only · localhost only · Ctrl-C to stop'));

        const shutdown = () => {
          server.close(() => process.exit(0));
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (msg.includes('EADDRINUSE')) {
          console.error(chalk.red(`Port ${port} is already in use. Pass --port <n> to pick another.`));
        } else {
          console.error(chalk.red(`Could not start serve: ${msg}`));
        }
        process.exit(1);
      }
    });
}
