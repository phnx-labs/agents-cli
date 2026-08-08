// `agents share` — publish an HTML file to your own Cloudflare R2 behind a tiny
// Worker, and get a shareable link (~$0). See apps/cli/docs/share.md.

import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import chalk from 'chalk';
import {
  DEFAULT_BUCKET_NAME,
  DEFAULT_CF_BUNDLE,
  DEFAULT_SHARE_DOMAIN,
  DEFAULT_WORKER_NAME,
  type ShareConfig,
  generateWriteToken,
  readCloudflareCreds,
  readShareConfig,
  readWriteTokenEnv,
  readWriteTokenFromBundle,
  storeWriteToken,
  writeShareConfig,
} from '../lib/share/config.js';
import {
  addCustomDomain,
  configureBucketLifecycle,
  createBucket,
  deployWorker,
  enableWorkersDev,
  findZoneId,
  type CloudflareRequester,
  setWorkerSecret,
} from '../lib/share/provision.js';
import { publishFile, type PublishResult } from '../lib/share/publish.js';
import { deleteShare, type DeleteShareResult } from '../lib/share/delete.js';
import { renderWorkerScript } from '../lib/share/worker-template.js';
import { analyticsEnabled } from '../lib/share/analytics.js';
import { resolveGitHubUsername } from '../lib/git.js';
import { setHelpSections } from '../lib/help.js';

export function formatSharePublishResult(result: PublishResult, json = false): string {
  if (json) return JSON.stringify(result, null, 2);

  const lines = [chalk.green(result.url)];
  if (result.coverUrl) lines.push(chalk.dim(`  cover ${result.coverUrl}`));
  if (result.expiresAt) lines.push(chalk.dim(`  expires ${new Date(result.expiresAt).toLocaleString()}`));
  return lines.join('\n');
}

export function formatShareDeleteResult(result: DeleteShareResult, json = false): string {
  if (json) return JSON.stringify(result, null, 2);
  if (result.skipped) return chalk.dim(`skipped — ${result.url} was already gone`);

  const lines = [chalk.green(`deleted ${result.url}`)];
  if (result.cover) {
    lines.push(
      result.cover.existedBefore
        ? chalk.dim(`  cover deleted ${result.cover.url}`)
        : chalk.dim(`  cover (none) ${result.cover.url}`),
    );
  }
  return lines.join('\n');
}

interface ShareDeleteCliOpts {
  keepCover?: boolean;
  ifExists?: boolean;
  githubUser?: string;
  json?: boolean;
}

/** Shared handler for `agents share delete <targets...>` and the top-level
 * `agents unshare <targets...>` alias. Deletes each target independently and
 * continues past a failed one (rm-style), reporting all results and exiting
 * non-zero if any target failed to verify as gone.
 *
 * `deleteFn` is a DI seam for tests (defaults to the real `deleteShare`) — it is
 * never exposed as a CLI flag, only used to inject a fake config/checker/deleter
 * without touching the keychain or a live endpoint. */
export async function runShareDelete(
  targets: string[],
  opts: ShareDeleteCliOpts,
  deleteFn: typeof deleteShare = deleteShare,
): Promise<void> {
  const results: Array<{ target: string; result?: DeleteShareResult; error?: string }> = [];
  for (const target of targets) {
    try {
      const result = await deleteFn(target, {
        keepCover: opts.keepCover === true,
        ifExists: opts.ifExists === true,
        githubUser: opts.githubUser,
      });
      results.push({ target, result });
      if (!opts.json) console.log(formatShareDeleteResult(result));
    } catch (e) {
      results.push({ target, error: (e as Error).message });
      if (!opts.json) console.error(chalk.red(`${target}: ${(e as Error).message}`));
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  }

  if (results.some((r) => r.error)) {
    process.exitCode = 1;
  }
}

function registerShareDeleteOptions(cmd: Command): Command {
  return cmd
    .option('--keep-cover', 'leave the sibling <slug>.png OG cover in place (default: delete it too)')
    .option('--if-exists', 'treat an already-missing target as a no-op success instead of an error')
    .option('--github-user <user>', 'GitHub username for resolving a bare-slug target (default: resolved from gh/git config)')
    .option('--json', 'emit machine-readable results');
}

const SHARE_DELETE_EXAMPLES = `
      # Delete by full URL — also takes down the sibling OG cover
      agents share delete https://share.agents-cli.sh/octocat/my-plan-a1b2

      # Delete by <user>/<slug>, or a bare slug in your own namespace
      agents share delete octocat/my-plan-a1b2
      agents unshare my-plan-a1b2

      # Several at once
      agents unshare my-plan-a1b2 old-report-9f3c

      # Keep the cover image up (rare — you usually want both gone)
      agents unshare my-plan-a1b2 --keep-cover

      # Don't error if it's already gone
      agents unshare my-plan-a1b2 --if-exists
`;

const SHARE_DELETE_NOTES = `
  A follow-up GET is required to resolve 404 before this reports success — the
  Worker's DELETE is idempotent and returns {"ok":true} even for a key that was
  never there, so that response alone is never proof of a takedown.

  agents share delete === agents unshare (same command, different name).
`;

export function registerShareCommands(program: Command): void {
  const shareCmd = program
    .command('share')
    .description('Publish an HTML file to your own Cloudflare R2 and get a shareable link (~$0).')
    .argument('[file]', 'file to publish (HTML or any static asset)')
    .option('--slug <slug>', 'custom URL slug under your namespace (default: <project>-<feature>-<hash>)')
    .option('--github-user <user>', 'GitHub username for the share namespace (default: resolved from gh/git config)')
    .option('--expire <spec>', 'auto-expire, e.g. 30d, 12h, or 2026-08-01')
    .option('--no-cover', 'skip the OG preview image (HTML pages get one by default)')
    .option('--no-analytics', 'skip injecting the Cloudflare Web Analytics beacon')
    .option('--json', 'emit machine-readable publish result for plan-render hooks and scripts')
    .action(async (file: string | undefined, opts: { slug?: string; githubUser?: string; expire?: string; cover?: boolean; analytics?: boolean; json?: boolean }) => {
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
        const { url, expiresAt, coverUrl } = await publishFile(file, {
          slug: opts.slug,
          githubUser: opts.githubUser,
          expire: opts.expire,
          cover: opts.cover,
          analytics: opts.analytics,
        });
        console.log(formatSharePublishResult({ url, expiresAt, coverUrl }, Boolean(opts.json)));
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exitCode = 1;
      }
    });

  setHelpSections(shareCmd, {
    examples: `
      # Publish an HTML file — gets an auto OG cover + a shareable link
      agents share ./out/plan.html

      # Custom slug, expiring in 30 days
      agents share ./out/report.html --slug q3-report --expire 30d
${SHARE_DELETE_EXAMPLES}
      # One-time setup (or join an existing endpoint)
      agents share setup
      agents share join https://share.agents-cli.sh
    `,
    notes: SHARE_DELETE_NOTES,
  });

  const shareDeleteCmd = registerShareDeleteOptions(
    shareCmd
      .command('delete <targets...>')
      .description('Take down a published page (and by default its OG cover). Verifies the page 404s before reporting success. Top-level alias: agents unshare.'),
  );
  setHelpSections(shareDeleteCmd, { examples: SHARE_DELETE_EXAMPLES, notes: SHARE_DELETE_NOTES });
  shareDeleteCmd.action(async (targets: string[], opts: ShareDeleteCliOpts) => {
    await runShareDelete(targets, opts);
  });

  const unshareCmd = registerShareDeleteOptions(
    program
      .command('unshare <targets...>')
      .description('Alias of `agents share delete` — take down a published page (and by default its OG cover).'),
  );
  setHelpSections(unshareCmd, { examples: SHARE_DELETE_EXAMPLES, notes: SHARE_DELETE_NOTES });
  unshareCmd.action(async (targets: string[], opts: ShareDeleteCliOpts) => {
    await runShareDelete(targets, opts);
  });

  shareCmd
    .command('setup')
    .description('One-time: provision an R2 bucket + Worker on your Cloudflare and save the config.')
    .option('--bundle <name>', 'secrets bundle holding the Cloudflare API token', DEFAULT_CF_BUNDLE)
    .option('--worker <name>', 'Worker name', DEFAULT_WORKER_NAME)
    .option('--bucket <name>', 'R2 bucket name', DEFAULT_BUCKET_NAME)
    .option('--account <id>', 'Cloudflare account id (else read from the bundle / prompt)')
    .option('--token <t>', 'Cloudflare API token (else read from the --bundle)')
    .option('--domain <host>', `custom domain to map (default: ${DEFAULT_SHARE_DOMAIN}; workers.dev if zone is not visible)`)
    .option('--analytics-token <token>', 'Cloudflare Web Analytics token to inject into published HTML pages')
    .action(async (opts: { bundle: string; worker: string; bucket: string; account?: string; token?: string; domain?: string; analyticsToken?: string }) => {
      try {
        await runShareProvision(opts);
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exitCode = 1;
      }
    });

  shareCmd
    .command('join')
    .description('Use an existing synced share endpoint and write token (no provisioning).')
    .argument('[baseUrl]', 'base URL of the endpoint, e.g. https://share.agents-cli.sh')
    .option('--token <token>', 'write token (else SHARE_WRITE_TOKEN env, existing bundle, or prompt)')
    .action(async (baseUrl: string | undefined, opts: { token?: string }) => {
      try {
        await runShareJoin(baseUrl, opts);
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exitCode = 1;
      }
    });

  shareCmd
    .command('status')
    .description('Show the configured share endpoint and namespace.')
    .action(async () => {
      const cfg = readShareConfig();
      if (!cfg) {
        console.log(chalk.dim("Not configured. Run 'agents share setup' or 'agents share join'."));
        return;
      }
      console.log(`${chalk.bold('endpoint')}  ${chalk.green(cfg.baseUrl)}`);
      console.log(chalk.dim(`worker ${cfg.workerName} · bucket ${cfg.bucketName} · account ${cfg.accountId}`));
      const user = await resolveGitHubUsername();
      console.log(`${chalk.bold('namespace')} ${user ? chalk.cyan(`${cfg.baseUrl}/${user}`) : chalk.yellow('unknown — set gh auth or github.user')}`);
      console.log(`${chalk.bold('analytics')} ${analyticsEnabled(cfg) ? chalk.green('enabled') : chalk.dim('not configured')}`);
    });

  shareCmd
    .command('analytics')
    .description('Show the Cloudflare Web Analytics status for this share endpoint.')
    .action(async () => {
      const cfg = readShareConfig();
      if (!cfg) {
        console.log(chalk.dim("Not configured. Run 'agents share setup' or 'agents share join'."));
        return;
      }
      if (!analyticsEnabled(cfg)) {
        console.log(chalk.yellow('Cloudflare Web Analytics is not configured.'));
        console.log(chalk.dim("Re-run setup with --analytics-token <token> or add analyticsToken to agents.yaml share:."));
        return;
      }
      const dashboard = cfg.domain
        ? `https://dash.cloudflare.com/${cfg.accountId}/web-analytics/${cfg.domain}`
        : `https://dash.cloudflare.com/${cfg.accountId}/web-analytics`;
      console.log(`${chalk.bold('analytics')}  ${chalk.green('enabled')}`);
      console.log(`${chalk.bold('token')}    ${chalk.dim(cfg.analyticsToken!.slice(0, 8) + '…')}`);
      console.log(`${chalk.bold('dashboard')} ${chalk.cyan(dashboard)}`);
      const user = await resolveGitHubUsername();
      if (user) {
        console.log(chalk.dim(`Per-page breakdown is available under Paths in the dashboard (filter by /${user}/).`));
      }
    });
}

/** Provision a fresh R2 bucket + Worker on the user's Cloudflare and persist the
 * endpoint config + write token. Shared by `agents share setup` and the unified
 * `agents setup share` wizard. */
export async function runShareProvision(opts: {
  bundle: string;
  worker: string;
  bucket: string;
  account?: string;
  token?: string;
  domain?: string;
  analyticsToken?: string;
  request?: CloudflareRequester;
}): Promise<void> {
  const { default: ora } = await import('ora');
  const { input } = await import('@inquirer/prompts');

  const { apiToken, accountId: acctFromBundle } = readCloudflareCreds(opts.bundle, {
    apiToken: opts.token,
    accountId: opts.account,
  });
  const accountId =
    opts.account || acctFromBundle || (await input({ message: 'Cloudflare account id' }));
  if (!accountId) throw new Error('A Cloudflare account id is required.');

  const workerName = opts.worker;
  const bucketName = opts.bucket;
  const token = generateWriteToken();
  const requestedDomain = cleanHostname(opts.domain) ?? DEFAULT_SHARE_DOMAIN;

  const spin = ora('Provisioning on Cloudflare…').start();
  try {
    const provisionOpts = opts.request ? { request: opts.request } : {};
    await createBucket(apiToken, accountId, bucketName, provisionOpts);
    spin.text = `R2 bucket '${bucketName}' ready`;
    await configureBucketLifecycle(apiToken, accountId, bucketName, provisionOpts);
    spin.text = `R2 bucket '${bucketName}' lifecycle ready`;
    await deployWorker(apiToken, accountId, workerName, renderWorkerScript(), bucketName, provisionOpts);
    spin.text = `Worker '${workerName}' deployed`;
    await setWorkerSecret(apiToken, accountId, workerName, token, provisionOpts);
    spin.text = `Worker '${workerName}' write token set`;
    const subdomain = await enableWorkersDev(apiToken, accountId, workerName, provisionOpts);
    let baseUrl = `https://${workerName}.${subdomain}.workers.dev`;
    let domain: string | undefined;

    if (requestedDomain) {
      spin.text = `Mapping ${requestedDomain}…`;
      const zoneId = await findZoneId(apiToken, requestedDomain, provisionOpts);
      if (zoneId) {
        await addCustomDomain(apiToken, accountId, workerName, zoneId, requestedDomain, provisionOpts);
        baseUrl = `https://${requestedDomain}`;
        domain = requestedDomain;
      } else {
        spin.warn(`Zone for ${requestedDomain} not visible to this token — staying on workers.dev`);
      }
    }
    spin.succeed('Provisioned');

    const cfg: ShareConfig = { baseUrl, accountId, workerName, bucketName, domain, analyticsToken: opts.analyticsToken };
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

function cleanHostname(domain: string | undefined): string | undefined {
  const raw = domain?.trim().replace(/\/+$/, '');
  if (!raw) return undefined;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname || undefined;
  } catch {
    return raw;
  }
}

/** Join an existing share endpoint (no provisioning): prompt for the endpoint
 * details + write token and persist them. Shared by `agents share join` and the
 * unified `agents setup share` wizard. */
export async function runShareJoin(baseUrl?: string, opts: { token?: string } = {}): Promise<void> {
  const { password, input } = await import('@inquirer/prompts');
  const existing = readShareConfig();
  const clean = baseUrl?.replace(/\/+$/, '');
  if (!clean && !existing) {
    throw new Error(
      "No synced share endpoint found. Pull config first with 'agents repo pull', or pass the endpoint URL: agents share join <baseUrl>.",
    );
  }

  let cfg: ShareConfig;
  if (existing && (!clean || clean === existing.baseUrl)) {
    cfg = existing;
  } else {
    if (!clean) throw new Error('Share endpoint URL is required.');
    const workerName = await input({ message: 'Worker name', default: DEFAULT_WORKER_NAME });
    const bucketName = await input({ message: 'Bucket name', default: DEFAULT_BUCKET_NAME });
    const accountId = await input({ message: 'Cloudflare account id' });
    const domain = clean.startsWith('https://') && !clean.includes('.workers.dev')
      ? clean.replace(/^https:\/\//, '')
      : undefined;
    cfg = { baseUrl: clean, accountId, workerName, bucketName, domain };
  }

  let token = opts.token?.trim() || readWriteTokenEnv() || '';
  if (!token) {
    try {
      token = readWriteTokenFromBundle();
    } catch {
      token = '';
    }
  }
  if (!token) {
    token = await password({ message: 'Write token (from the endpoint owner)', mask: true });
  }
  if (!token) throw new Error('A write token is required to join.');
  writeShareConfig(cfg);
  storeWriteToken(token);
  console.log(chalk.green(`Joined ${chalk.bold(cfg.baseUrl)} — publish with `) + chalk.cyan('agents share <file>'));
}
