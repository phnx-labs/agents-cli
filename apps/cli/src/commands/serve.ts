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

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Read-only local web companion: team diffs, routines, and cloud status (binds 127.0.0.1 only).')
    .option('-p, --port <n>', `Port to bind on ${SERVE_HOST}`, String(DEFAULT_SERVE_PORT))
    .option('--interval <ms>', 'SSE refresh cadence in milliseconds', '3000')
    .action(async (opts: { port?: string; interval?: string }) => {
      const port = parseInt(opts.port ?? '', 10) || DEFAULT_SERVE_PORT;
      const intervalMs = parseInt(opts.interval ?? '', 10) || 3000;

      try {
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
