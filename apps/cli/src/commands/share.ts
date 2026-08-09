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
  readWriteToken,
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
  hashWorkerScript,
  updateWorker,
  type CloudflareRequester,
  setWorkerSecret,
} from '../lib/share/provision.js';
import { publishFile, resolveShareUsername, type PublishResult } from '../lib/share/publish.js';
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

/** Compare the configured endpoint's last-deployed template hash against the
 * hash of the CURRENT `worker-template.ts` render. A config with no recorded
 * hash (every endpoint provisioned before this field existed) is "unknown" —
 * never "current" or "outdated", since there is nothing to compare against. */
export function shareTemplateStatus(cfg: ShareConfig): 'current' | 'outdated' | 'unknown' {
  if (!cfg.templateHash) return 'unknown';
  return cfg.templateHash === hashWorkerScript(renderWorkerScript()) ? 'current' : 'outdated';
}

/** One published object as reported by the Worker's `?format=json` listing route. */
export interface ShareListItem {
  slug: string;
  url: string;
  /** Object size in bytes. */
  size: number;
  /** Stored content type, or null if the Worker had none recorded. */
  contentType: string | null;
  /** ISO timestamp the object was last written (R2 `uploaded`). */
  publishedAt: string;
  /** ISO auto-expire timestamp, or null for a permanent share. */
  expiresAt: string | null;
}

export interface ShareListResult {
  /** The namespace listed. */
  user: string;
  count: number;
  objects: ShareListItem[];
}

/** DI seam for tests — override the real HTTP GET of the JSON listing route. */
export type ListingFetchFn = (url: string) => Promise<{ status: number; contentType: string; body: string }>;

/** Shown whenever the deployed Worker has no `?format=json` listing route — an
 * endpoint provisioned before this feature. Points at the RUSH-2449 update path
 * (`agents share update`) instead of letting the caller hit a 404 or an HTML body
 * and get a confusing parse error. */
const OUTDATED_TEMPLATE_HINT =
  'Your deployed share Worker has no machine-readable listing route — it predates `agents share list`. ' +
  'Run `agents share update` to deploy the current Worker template, then retry (`agents share status` shows whether an update is due).';

async function defaultListingFetch(url: string): Promise<{ status: number; contentType: string; body: string }> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() };
}

/** Parse the Worker's listing JSON into a validated result, failing loud (with the
 * outdated-template hint) on any body that isn't the expected shape — an old Worker
 * serves the HTML gallery for a non-empty namespace, which must not be silently
 * accepted as "you have published nothing". */
export function parseShareListing(user: string, body: string): ShareListResult {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(OUTDATED_TEMPLATE_HINT);
  }
  const objectsRaw = (data as { objects?: unknown } | null)?.objects;
  if (!data || typeof data !== 'object' || !Array.isArray(objectsRaw)) {
    throw new Error(OUTDATED_TEMPLATE_HINT);
  }
  const objects: ShareListItem[] = objectsRaw.map((o) => {
    const item = o as Record<string, unknown>;
    return {
      slug: String(item.slug ?? ''),
      url: String(item.url ?? ''),
      size: typeof item.size === 'number' ? item.size : 0,
      contentType: item.contentType == null ? null : String(item.contentType),
      publishedAt: String(item.publishedAt ?? ''),
      expiresAt: item.expiresAt == null ? null : String(item.expiresAt),
    };
  });
  return { user, count: objects.length, objects };
}

/** Fetch and parse the machine-readable listing of the caller's namespace from the
 * Worker's `?format=json` route. Fails loud when share was never configured, when
 * the deployed template is known-outdated (RUSH-2449 templateHash), or when the
 * live response proves the route is absent (404 or a non-JSON 200 = the old HTML
 * gallery) — never a silent empty/wrong result. */
export async function runShareList(
  opts: { githubUser?: string; config?: ShareConfig; fetchListing?: ListingFetchFn } = {},
): Promise<ShareListResult> {
  const cfg = opts.config ?? readShareConfig();
  if (!cfg) {
    throw new Error(
      "Not set up yet. Run 'agents share setup' (provision your own endpoint) or 'agents share join' (use an existing one).",
    );
  }
  // A known-stale template can't have the listing route — say so before any network
  // call. 'unknown' (provisioned before templateHash tracking) is attempted, then
  // caught by the response checks below if the route turns out to be absent.
  const templateStatus = shareTemplateStatus(cfg);
  if (templateStatus === 'outdated') {
    throw new Error(OUTDATED_TEMPLATE_HINT);
  }

  const user = await resolveShareUsername({ githubUser: opts.githubUser });
  const listUrl = `${cfg.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(user)}?format=json`;
  const fetchListing = opts.fetchListing ?? defaultListingFetch;
  const res = await fetchListing(listUrl);

  if (res.status === 404) {
    // A single-segment path 404s either because the namespace is genuinely empty
    // (current template — the listing route gates on the namespace holding objects,
    // so a namespace with nothing falls through to an object GET) OR because the
    // endpoint predates the listing route entirely. The recorded templateHash
    // disambiguates: a 'current' template HAS the route, so its 404 means an empty
    // namespace ("nothing published"); otherwise the route may be absent, so point
    // at `agents share update`.
    if (templateStatus === 'current') {
      return { user, count: 0, objects: [] };
    }
    throw new Error(OUTDATED_TEMPLATE_HINT);
  }
  if (res.status !== 200) {
    throw new Error(
      `Listing failed (${res.status}) for ${listUrl}. Check the endpoint is reachable, or that 'agents share setup' completed.`,
    );
  }
  if (!/application\/json/i.test(res.contentType)) {
    // A 200 that isn't JSON means the old Worker ignored ?format=json and served
    // the HTML gallery — the deployed template is outdated.
    throw new Error(OUTDATED_TEMPLATE_HINT);
  }
  return parseShareListing(user, res.body);
}

/** Human-readable bytes, e.g. `1.2 KB`, `640 B`. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatShareList(result: ShareListResult, json = false): string {
  if (json) return JSON.stringify(result, null, 2);
  if (result.count === 0) {
    return chalk.dim(`No active pages published under @${result.user}.`);
  }
  const header =
    chalk.bold(`@${result.user}`) +
    chalk.dim(`  ${result.count} published ${result.count === 1 ? 'page' : 'pages'}`);
  const rows = result.objects.map((o) => {
    const when = o.publishedAt ? o.publishedAt.slice(0, 10) : 'unknown';
    const meta = `${when} · ${formatBytes(o.size)}${o.expiresAt ? ` · expires ${o.expiresAt.slice(0, 10)}` : ''}`;
    return `${chalk.cyan(o.slug)}  ${chalk.dim(meta)}\n  ${chalk.green(o.url)}`;
  });
  return [header, ...rows].join('\n');
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

      # Push a worker-template.ts change out to an already-provisioned endpoint
      agents share update
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

  const shareUpdateCmd = shareCmd
    .command('update')
    .description('Re-deploy the Worker script to the current template on an already-provisioned endpoint (idempotent).')
    .option('--bundle <name>', 'secrets bundle holding the Cloudflare API token', DEFAULT_CF_BUNDLE)
    .option('--account <id>', 'Cloudflare account id override (default: the configured endpoint\'s account)')
    .option('--token <t>', 'Cloudflare API token (else read from --bundle)')
    .option('--force', 're-deploy even if the deployed template already matches')
    .option('--json', 'emit a machine-readable result')
    .action(async (opts: { bundle: string; account?: string; token?: string; force?: boolean; json?: boolean }) => {
      try {
        const result = await runShareUpdate(opts);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.updated) {
          console.log(chalk.green(`Worker '${result.workerName}' updated → template ${result.templateHash.slice(0, 12)}…`));
        } else {
          console.log(chalk.dim(`Worker '${result.workerName}' already matches the current template — no-op.`));
        }
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exitCode = 1;
      }
    });

  setHelpSections(shareUpdateCmd, {
    examples: `
      # Push a worker-template.ts change out to your already-provisioned endpoint
      agents share update

      # Force a re-deploy even though the template hash already matches
      agents share update --force
    `,
    notes: `
  Reuses the existing account/worker/bucket from 'agents share status' and the
  existing write token — it never re-provisions a bucket, touches routes, or
  regenerates the token. See 'agents share status' for whether an update is due.
    `,
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
      const templateStatus = shareTemplateStatus(cfg);
      const templateLabel =
        templateStatus === 'current'
          ? chalk.green('current')
          : templateStatus === 'outdated'
            ? chalk.yellow('outdated — run `agents share update`')
            : chalk.dim("unknown — provisioned before version tracking; run `agents share update` to adopt it");
      console.log(`${chalk.bold('template')}  ${templateLabel}`);
    });

  const shareListCmd = shareCmd
    .command('list')
    .description("List the pages you've published to your share namespace (human table; --json for scripts).")
    .option('--github-user <user>', 'GitHub username whose namespace to list (default: resolved from gh/git config)')
    .option('--json', 'emit the machine-readable listing (slug, url, size, contentType, publishedAt, expiresAt)')
    .action(async (opts: { githubUser?: string; json?: boolean }) => {
      try {
        const result = await runShareList({ githubUser: opts.githubUser });
        console.log(formatShareList(result, Boolean(opts.json)));
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exitCode = 1;
      }
    });

  setHelpSections(shareListCmd, {
    examples: `
      # Everything you've published, newest first
      agents share list

      # Machine-readable — e.g. pull every still-public URL with jq
      agents share list --json | jq -r '.objects[].url'

      # List another namespace
      agents share list --github-user octocat
    `,
    notes: `
  Lists the ACTIVE pages in your namespace — expired links and the sibling .png OG
  covers are omitted (it mirrors the public gallery). It reads the endpoint's JSON
  listing route, which ships with the current Worker template. If your deployed
  Worker predates this feature the command says so and points you at 'agents share
  update' (RUSH-2449) rather than returning a wrong or empty result — see 'agents
  share status' for whether an update is due.
    `,
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
  const script = renderWorkerScript();

  const spin = ora('Provisioning on Cloudflare…').start();
  try {
    const provisionOpts = opts.request ? { request: opts.request } : {};
    await createBucket(apiToken, accountId, bucketName, provisionOpts);
    spin.text = `R2 bucket '${bucketName}' ready`;
    await configureBucketLifecycle(apiToken, accountId, bucketName, provisionOpts);
    spin.text = `R2 bucket '${bucketName}' lifecycle ready`;
    await deployWorker(apiToken, accountId, workerName, script, bucketName, provisionOpts);
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

    const cfg: ShareConfig = {
      baseUrl,
      accountId,
      workerName,
      bucketName,
      domain,
      analyticsToken: opts.analyticsToken,
      templateHash: hashWorkerScript(script),
    };
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

export interface ShareUpdateResult {
  updated: boolean;
  templateHash: string;
  baseUrl: string;
  workerName: string;
}

/** Re-deploy the Worker script on an ALREADY-provisioned endpoint to match the
 * current `worker-template.ts`. Reuses the existing account/worker/bucket and
 * write token from `readShareConfig()`/the `share` bundle — never creates a
 * bucket, touches routes/domains, or regenerates the token (see
 * `updateWorker` in `lib/share/provision.ts` for how the token survives the
 * re-upload). Idempotent: no-ops when the deployed hash already matches
 * unless `force`. */
export async function runShareUpdate(opts: {
  bundle?: string;
  account?: string;
  token?: string;
  force?: boolean;
  request?: CloudflareRequester;
} = {}): Promise<ShareUpdateResult> {
  const cfg = readShareConfig();
  if (!cfg) {
    throw new Error("Not configured. Run 'agents share setup' (to provision) or 'agents share join' first.");
  }

  const { apiToken, accountId: acctFromBundle } = readCloudflareCreds(opts.bundle ?? DEFAULT_CF_BUNDLE, {
    apiToken: opts.token,
    accountId: opts.account,
  });
  const accountId = opts.account || acctFromBundle || cfg.accountId;
  const writeToken = readWriteToken();
  const script = renderWorkerScript();
  const provisionOpts = { ...(opts.request ? { request: opts.request } : {}), force: opts.force };

  const result = await updateWorker(
    apiToken,
    accountId,
    cfg.workerName,
    cfg.bucketName,
    script,
    writeToken,
    cfg.templateHash,
    provisionOpts,
  );

  if (!result.skipped) {
    writeShareConfig({ ...cfg, templateHash: result.templateHash });
  }

  return { updated: !result.skipped, templateHash: result.templateHash, baseUrl: cfg.baseUrl, workerName: cfg.workerName };
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
