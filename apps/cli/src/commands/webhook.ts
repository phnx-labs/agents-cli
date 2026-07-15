/**
 * `agents webhook` — localhost receiver for signed public webhook ingress.
 *
 * The receiver intentionally binds localhost by default. Public exposure is a
 * separate `agents funnel up <host>` step so the HTTP process can be tested and
 * rotated without changing the Tailscale Funnel config.
 */
import type { Command } from 'commander';
import type { Server } from 'http';
import chalk from 'chalk';
import { readAndResolveBundleEnv } from '../lib/secrets/bundles.js';
import { startWebhookServer, type WebhookSecrets } from '../lib/triggers/webhook.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readWebhookSecrets(bundleName: string): WebhookSecrets {
  const { env } = readAndResolveBundleEnv(bundleName, {
    caller: 'webhook serve',
  });
  const secrets: WebhookSecrets = {};
  if (env.GITHUB_WEBHOOK_SECRET) secrets.github = env.GITHUB_WEBHOOK_SECRET;
  if (env.LINEAR_WEBHOOK_SECRET) secrets.linear = env.LINEAR_WEBHOOK_SECRET;
  if (!secrets.github && !secrets.linear) {
    throw new Error(
      `Bundle '${bundleName}' must contain GITHUB_WEBHOOK_SECRET or LINEAR_WEBHOOK_SECRET.`,
    );
  }
  return secrets;
}

function waitForListening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

export function registerWebhookCommand(program: Command): void {
  const webhook = program
    .command('webhook')
    .description('Run a localhost signed webhook receiver for routine triggers.');

  webhook
    .command('serve')
    .description('Receive signed GitHub/Linear webhooks on /hooks/<source> and fire matching routines.')
    .requiredOption('--secrets-bundle <name>', 'agents secrets bundle containing GITHUB_WEBHOOK_SECRET and/or LINEAR_WEBHOOK_SECRET')
    .option('--host <addr>', `Bind address (default ${DEFAULT_HOST})`, DEFAULT_HOST)
    .option('-p, --port <n>', `Local port (default ${DEFAULT_PORT})`, String(DEFAULT_PORT))
    .option('--rate-limit <n>', 'Accepted deliveries per source per minute', '60')
    .action(async (opts: { secretsBundle: string; host?: string; port?: string; rateLimit?: string }) => {
      let secrets: WebhookSecrets;
      try {
        secrets = readWebhookSecrets(opts.secretsBundle);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }

      const port = positiveInt(opts.port, DEFAULT_PORT);
      const rateLimit = positiveInt(opts.rateLimit, 60);

      try {
        const server = startWebhookServer({
          host: opts.host ?? DEFAULT_HOST,
          port,
          secrets,
          rateLimitPerMinute: rateLimit,
          onDelivery: (webhook, fired) => {
            console.log(
              `${new Date().toISOString()} ${webhook.source}:${webhook.event} ` +
              `${fired.length ? `fired ${fired.map((f) => f.jobName).join(', ')}` : 'no match'}`,
            );
          },
        });
        await waitForListening(server);
        const address = server.address();
        const bound = typeof address === 'object' && address ? address.port : port;
        console.log(`${chalk.green('agents webhook')} ${chalk.dim('→')} ${chalk.cyan(`http://${opts.host ?? DEFAULT_HOST}:${bound}`)}`);
        console.log(chalk.dim('signed · localhost by default · endpoints: /hooks/github, /hooks/linear · Ctrl-C to stop'));

        const shutdown = () => {
          server.close(() => process.exit(0));
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (err) {
        console.error(chalk.red(`Could not start webhook receiver: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
