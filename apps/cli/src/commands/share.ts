// `agents share` — publish an HTML file to your own Cloudflare R2 behind a tiny
// Worker, and get a shareable link (~$0). See apps/cli/docs/share.md.

import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import chalk from 'chalk';
import {
  DEFAULT_BUCKET_NAME,
  DEFAULT_CF_BUNDLE,
  DEFAULT_WORKER_NAME,
  type ShareConfig,
  generateWriteToken,
  readCloudflareCreds,
  readShareConfig,
  storeWriteToken,
  writeShareConfig,
} from '../lib/share/config.js';
import {
  addCustomDomain,
  createBucket,
  deployWorker,
  enableWorkersDev,
  findZoneId,
} from '../lib/share/provision.js';
import { publishFile } from '../lib/share/publish.js';
import { renderWorkerScript } from '../lib/share/worker-template.js';

export function registerShareCommands(program: Command): void {
  const shareCmd = program
    .command('share')
    .description('Publish an HTML file to your own Cloudflare R2 and get a shareable link (~$0).')
    .argument('[file]', 'file to publish (HTML or any static asset)')
    .option('--slug <slug>', 'custom URL slug (default: derived from the filename)')
    .option('--expire <spec>', 'auto-expire, e.g. 30d, 12h, or 2026-08-01')
    .action(async (file: string | undefined, opts: { slug?: string; expire?: string }) => {
      if (!file) {
        shareCmd.help();
        return;
      }
      if (!existsSync(file)) {
        console.error(chalk.red(`No such file: ${file}`));
        process.exitCode = 1;
        return;
      }
      try {
        const { url, expiresAt } = await publishFile(file, { slug: opts.slug, expire: opts.expire });
        console.log(chalk.green(url));
        if (expiresAt) console.log(chalk.dim(`  expires ${new Date(expiresAt).toLocaleString()}`));
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exitCode = 1;
      }
    });

  shareCmd
    .command('setup')
    .description('One-time: provision an R2 bucket + Worker on your Cloudflare and save the config.')
    .option('--bundle <name>', 'secrets bundle holding the Cloudflare API token', DEFAULT_CF_BUNDLE)
    .option('--worker <name>', 'Worker name', DEFAULT_WORKER_NAME)
    .option('--bucket <name>', 'R2 bucket name', DEFAULT_BUCKET_NAME)
    .option('--account <id>', 'Cloudflare account id (else read from the bundle / prompt)')
    .option('--domain <host>', 'also map a custom domain (e.g. share.agents-cli.sh) if the token owns the zone')
    .action(async (opts: { bundle: string; worker: string; bucket: string; account?: string; domain?: string }) => {
      try {
        await runSetup(opts);
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exitCode = 1;
      }
    });

  shareCmd
    .command('join')
    .description('Use an existing share endpoint (no provisioning) — pass the base URL and paste the write token.')
    .argument('<baseUrl>', 'base URL of the endpoint, e.g. https://share.agents-cli.sh')
    .action(async (baseUrl: string) => {
      try {
        await runJoin(baseUrl);
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exitCode = 1;
      }
    });

  shareCmd
    .command('status')
    .description('Show the configured share endpoint.')
    .action(() => {
      const cfg = readShareConfig();
      if (!cfg) {
        console.log(chalk.dim("Not configured. Run 'agents share setup' or 'agents share join'."));
        return;
      }
      console.log(`${chalk.bold('endpoint')}  ${chalk.green(cfg.baseUrl)}`);
      console.log(chalk.dim(`worker ${cfg.workerName} · bucket ${cfg.bucketName} · account ${cfg.accountId}`));
    });
}

async function runSetup(opts: {
  bundle: string;
  worker: string;
  bucket: string;
  account?: string;
  domain?: string;
}): Promise<void> {
  const { default: ora } = await import('ora');
  const { input } = await import('@inquirer/prompts');

  const { apiToken, accountId: acctFromBundle } = readCloudflareCreds(opts.bundle);
  const accountId =
    opts.account || acctFromBundle || (await input({ message: 'Cloudflare account id' }));
  if (!accountId) throw new Error('A Cloudflare account id is required.');

  const workerName = opts.worker;
  const bucketName = opts.bucket;
  const token = generateWriteToken();

  const spin = ora('Provisioning on Cloudflare…').start();
  try {
    await createBucket(apiToken, accountId, bucketName);
    spin.text = `R2 bucket '${bucketName}' ready`;
    await deployWorker(apiToken, accountId, workerName, renderWorkerScript(), bucketName, token);
    spin.text = `Worker '${workerName}' deployed`;
    const subdomain = await enableWorkersDev(apiToken, accountId, workerName);
    let baseUrl = `https://${workerName}.${subdomain}.workers.dev`;
    let domain: string | undefined;

    if (opts.domain) {
      spin.text = `Mapping ${opts.domain}…`;
      const zoneId = await findZoneId(apiToken, opts.domain);
      if (zoneId) {
        await addCustomDomain(apiToken, accountId, workerName, zoneId, opts.domain);
        baseUrl = `https://${opts.domain}`;
        domain = opts.domain;
      } else {
        spin.warn(`Zone for ${opts.domain} not visible to this token — staying on workers.dev`);
      }
    }
    spin.succeed('Provisioned');

    const cfg: ShareConfig = { baseUrl, accountId, workerName, bucketName, domain };
    writeShareConfig(cfg);
    storeWriteToken(token);

    console.log(chalk.green(`\nShare endpoint ready → ${chalk.bold(baseUrl)}`));
    console.log(chalk.dim('Publish with:  ') + chalk.cyan('agents share <file>'));
    console.log(
      chalk.dim(
        `Fleet: push the token with 'agents secrets export share --host <box>' and pull config with 'agents repo pull'.`,
      ),
    );
  } catch (e) {
    spin.fail('Provisioning failed');
    throw e;
  }
}

async function runJoin(baseUrl: string): Promise<void> {
  const { password, input } = await import('@inquirer/prompts');
  const clean = baseUrl.replace(/\/+$/, '');
  const workerName = await input({ message: 'Worker name', default: DEFAULT_WORKER_NAME });
  const bucketName = await input({ message: 'Bucket name', default: DEFAULT_BUCKET_NAME });
  const accountId = await input({ message: 'Cloudflare account id' });
  const token = await password({ message: 'Write token (from the endpoint owner)', mask: true });
  if (!token) throw new Error('A write token is required to join.');
  const domain = clean.startsWith('https://') && !clean.includes('.workers.dev')
    ? clean.replace(/^https:\/\//, '')
    : undefined;
  writeShareConfig({ baseUrl: clean, accountId, workerName, bucketName, domain });
  storeWriteToken(token);
  console.log(chalk.green(`Joined ${chalk.bold(clean)} — publish with `) + chalk.cyan('agents share <file>'));
}
