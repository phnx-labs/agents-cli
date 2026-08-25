// `agents artifacts share` — publish an HTML file to a shareable link. Signed-in
// users hit the managed endpoint (share.agents-cli.sh) with the Phoenix bearer;
// otherwise the existing BYO Cloudflare R2 + Worker path. See cli/docs/share.md.
//
// Registered under the `artifacts` group by commands/artifacts.ts; the
// provisioning door lives beside it at `agents artifacts setup`
// (commands/artifacts-setup.ts), which calls `runShareProvision` below.

import { existsSync } from 'node:fs';
import { formatBytes } from '../lib/format.js';
import { Option, type Command } from 'commander';
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
  putWorkerSecret,
  updateWorker,
  WORKER_PHOENIX_ID_BASE_SECRET,
  type CloudflareRequester,
  setWorkerSecret,
} from '../lib/share/provision.js';
import {
  publishFile,
  resolveShareUsername,
  parseMetaEntries,
  resolveShareVisibility,
  type PublishResult,
  type ShareVisibility,
} from '../lib/share/publish.js';
import { deleteShare, resolveDeleteTarget, type DeleteShareResult } from '../lib/share/delete.js';
import { renderWorkerScript } from '../lib/share/worker-template.js';
import { analyticsEnabled } from '../lib/share/analytics.js';
import {
  phoenixIdBaseForDeploy,
  resolveShareBackend,
  type ResolveShareBackendOpts,
  type ShareBackend,
} from '../lib/share/backend.js';
import { resolveGitHubUsername } from '../lib/git.js';
import { setHelpSections } from '../lib/help.js';
import type { PhoenixSession } from '../lib/identity/client.js';

export function formatSharePublishResult(result: PublishResult, json = false): string {
  if (json) return JSON.stringify(result, null, 2);

  const lines = [chalk.green(result.url)];
  if (result.label) {
    const hint = result.labelSource === 'derived' ? chalk.dim(' (derived — pass --label to set one)') : '';
    lines.push(chalk.dim(`  "${result.label}"`) + hint);
  }
  if (result.coverUrl) lines.push(chalk.dim(`  cover ${result.coverUrl}`));
  if (result.expiresAt) lines.push(chalk.dim(`  expires ${new Date(result.expiresAt).toLocaleString()}`));
  else lines.push(chalk.dim('  expires never'));
  const visibility = result.visibility ?? (result.unlisted ? 'unlisted' : 'public');
  if (visibility === 'unlisted') {
    lines.push(chalk.dim('  visibility: unlisted (noindex, hidden from gallery)'));
  } else {
    lines.push(chalk.dim(`  visibility: ${visibility}`));
  }
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
  /** Human display title (explicit `--label` or auto-derived), or null for a
   * share published before this field existed. */
  label: string | null;
  /** Harness/agent name that published this (`AGENTS_AGENT_NAME`), or null. */
  agent: string | null;
  /** Session id that published this, or null. */
  session: string | null;
  /** Hostname the publish ran from, or null. */
  host: string | null;
  /** git repo name at publish time, or null (published outside a git repo, or
   * before this field existed). */
  repo: string | null;
  /** Count of retained prior versions under this slug (see `share revisions`). */
  revisionCount: number;
  /** Arbitrary `--meta key=value` entries attached at publish time (RUSH-2683)
   * — everything that isn't a reserved provenance/label key. `{}` when none
   * were set, or when the deployed Worker predates this field. */
  meta: Record<string, string>;
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
 * (`agents artifacts share update`) instead of letting the caller hit a 404 or an
 * HTML body and get a confusing parse error. */
const OUTDATED_TEMPLATE_HINT =
  'Your deployed share Worker has no machine-readable listing route — it predates `agents artifacts share list`. ' +
  'Run `agents artifacts share update` to deploy the current Worker template, then retry (`agents artifacts share status` shows whether an update is due).';

async function defaultListingFetch(url: string): Promise<{ status: number; contentType: string; body: string }> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() };
}

/** Normalize the Worker's `meta` field (arbitrary `--meta key=value` entries,
 * RUSH-2683) into a plain string record — `{}` for a missing/malformed field
 * (a deployed Worker that predates it, or a non-object value), never throws. */
function parseMetaField(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = String(v);
  }
  return out;
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
      label: item.label == null ? null : String(item.label),
      agent: item.agent == null ? null : String(item.agent),
      session: item.session == null ? null : String(item.session),
      host: item.host == null ? null : String(item.host),
      repo: item.repo == null ? null : String(item.repo),
      revisionCount: typeof item.revisionCount === 'number' ? item.revisionCount : 0,
      meta: parseMetaField(item.meta),
    };
  });
  return { user, count: objects.length, objects };
}

/** Namespace for list/revisions: managed uses the verified Phoenix userId;
 * BYO still resolves GitHub username (gh / git config / --for-user). */
async function namespaceForBackend(backend: ShareBackend, githubUser?: string): Promise<string> {
  if (backend.kind === 'managed') return backend.namespace;
  return resolveShareUsername({ githubUser: githubUser || backend.namespace || undefined });
}

/** Fetch and parse the machine-readable listing of the caller's namespace from the
 * Worker's `?format=json` route. Fails loud when share was never configured, when
 * the deployed template is known-outdated (RUSH-2449 templateHash), or when the
 * live response proves the route is absent (404 or a non-JSON 200 = the old HTML
 * gallery) — never a silent empty/wrong result. Signed-in users hit the managed
 * endpoint; BYO still uses `readShareConfig()`. */
export async function runShareList(
  opts: {
    githubUser?: string;
    config?: ShareConfig;
    writeToken?: string;
    byo?: boolean;
    /** DI seam — override `readSession()`. Named `phoenixSession` because
     * `session` is already the listing filter (session id). */
    phoenixSession?: PhoenixSession | null;
    fetchListing?: ListingFetchFn;
    /** Only shares published by this agent/harness (case-insensitive, exact). */
    agent?: string;
    /** Only shares published from this session id (exact). */
    session?: string;
    /** Only shares whose label contains this text (case-insensitive substring). */
    label?: string;
  } = {},
): Promise<ShareListResult> {
  const backend = resolveShareBackend({
    githubUser: opts.githubUser,
    config: opts.config,
    writeToken: opts.writeToken,
    byo: opts.byo,
    session: opts.phoenixSession,
    requireToken: false,
  } satisfies ResolveShareBackendOpts);
  // Managed: the platform Worker is current; skip the BYO template-hash gate.
  // A known-stale BYO template can't have the listing route — say so before any
  // network call. 'unknown' (provisioned before templateHash tracking) is
  // attempted, then caught by the response checks below if the route is absent.
  let templateStatus: 'current' | 'outdated' | 'unknown' = 'current';
  if (backend.kind === 'byo') {
    const cfg = opts.config ?? readShareConfig();
    templateStatus = cfg ? shareTemplateStatus(cfg) : 'unknown';
    if (templateStatus === 'outdated') {
      throw new Error(OUTDATED_TEMPLATE_HINT);
    }
  }

  const user = await namespaceForBackend(backend, opts.githubUser);
  const listUrl = `${backend.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(user)}?format=json`;
  const fetchListing = opts.fetchListing ?? defaultListingFetch;
  const res = await fetchListing(listUrl);

  if (res.status === 404) {
    // A single-segment path 404s either because the namespace is genuinely empty
    // (current template — the listing route gates on the namespace holding objects,
    // so a namespace with nothing falls through to an object GET) OR because the
    // endpoint predates the listing route entirely. The recorded templateHash
    // disambiguates: a 'current' template HAS the route, so its 404 means an empty
    // namespace ("nothing published"); otherwise the route may be absent, so point
    // at `agents artifacts share update`. Managed is always 'current'.
    if (templateStatus === 'current') {
      return { user, count: 0, objects: [] };
    }
    throw new Error(OUTDATED_TEMPLATE_HINT);
  }
  if (res.status !== 200) {
    throw new Error(
      `Listing failed (${res.status}) for ${listUrl}. Check the endpoint is reachable, or that 'agents artifacts setup' / 'agents auth login' completed.`,
    );
  }
  if (!/application\/json/i.test(res.contentType)) {
    // A 200 that isn't JSON means the old Worker ignored ?format=json and served
    // the HTML gallery — the deployed template is outdated. Managed never hits
    // this (platform Worker is current); fail loud if it somehow does.
    if (backend.kind === 'managed') {
      throw new Error(`Managed listing at ${listUrl} did not return JSON (${res.contentType || 'no content-type'}).`);
    }
    throw new Error(OUTDATED_TEMPLATE_HINT);
  }
  const parsed = parseShareListing(user, res.body);
  return applyShareListFilters(parsed, opts);
}

/** Client-side filtering over an already-fetched listing (RUSH-2683) — the
 * Worker has no query surface for this, so it narrows the fetched set instead
 * of a second round trip. `count` reflects the FILTERED set, matching what the
 * caller actually sees. */
function applyShareListFilters(
  result: ShareListResult,
  filters: { agent?: string; session?: string; label?: string },
): ShareListResult {
  let objects = result.objects;
  if (filters.agent) {
    const needle = filters.agent.toLowerCase();
    objects = objects.filter((o) => (o.agent ?? '').toLowerCase() === needle);
  }
  if (filters.session) {
    objects = objects.filter((o) => o.session === filters.session);
  }
  if (filters.label) {
    const needle = filters.label.toLowerCase();
    objects = objects.filter((o) => (o.label ?? '').toLowerCase().includes(needle));
  }
  return { user: result.user, count: objects.length, objects };
}

/** Human-readable bytes, e.g. `1.2 KB`, `640 B`. */
/** Render an arbitrary `--meta` map as `k=v k2=v2` for a human table row, or
 * undefined when there's nothing to show (RUSH-2683). */
function formatMetaPairs(meta: Record<string, string> | undefined): string | undefined {
  if (!meta) return undefined;
  const entries = Object.entries(meta);
  if (entries.length === 0) return undefined;
  return entries.map(([k, v]) => `${k}=${v}`).join(' ');
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
    const bits = [when, formatBytes(o.size)];
    if (o.agent) bits.push(o.agent);
    if (o.revisionCount > 0) bits.push(`${o.revisionCount} ${o.revisionCount === 1 ? 'revision' : 'revisions'}`);
    if (o.expiresAt) bits.push(`expires ${o.expiresAt.slice(0, 10)}`);
    const metaPairs = formatMetaPairs(o.meta);
    if (metaPairs) bits.push(metaPairs);
    const line = bits.join(' · ');
    const title = o.label ? `${chalk.bold(o.label)}\n  ` : '';
    return `${title}${chalk.cyan(o.slug)}  ${chalk.dim(line)}\n  ${chalk.green(o.url)}`;
  });
  return [header, ...rows].join('\n');
}

/** One retained prior version of a slug, as reported by the Worker's
 * `?revisions=json` route. */
export interface ShareRevisionItem {
  /** R2 object key, `<user>/<slug>/rev-<ts>-<rand>`. */
  key: string;
  url: string;
  size: number;
  contentType: string | null;
  /** ISO timestamp this version was replaced (when the copy was made). */
  uploadedAt: string;
  expiresAt: string | null;
  label: string | null;
  agent: string | null;
  session: string | null;
  host: string | null;
  repo: string | null;
  /** Arbitrary `--meta key=value` entries attached at publish time (RUSH-2683)
   * — everything that isn't a reserved provenance/label key. `{}` when none
   * were set, or when the deployed Worker predates this field. */
  meta: Record<string, string>;
}

export interface ShareRevisionsResult {
  /** The canonical `<user>/<slug>` key these are revisions of. */
  key: string;
  count: number;
  revisions: ShareRevisionItem[];
}

/** Parse the Worker's `?revisions=json` payload, failing loud (with the same
 * outdated-template hint as {@link parseShareListing}) on an unexpected shape. */
export function parseShareRevisions(key: string, body: string): ShareRevisionsResult {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(OUTDATED_TEMPLATE_HINT);
  }
  const revisionsRaw = (data as { revisions?: unknown } | null)?.revisions;
  if (!data || typeof data !== 'object' || !Array.isArray(revisionsRaw)) {
    throw new Error(OUTDATED_TEMPLATE_HINT);
  }
  const revisions: ShareRevisionItem[] = revisionsRaw.map((o) => {
    const item = o as Record<string, unknown>;
    return {
      key: String(item.key ?? ''),
      url: String(item.url ?? ''),
      size: typeof item.size === 'number' ? item.size : 0,
      contentType: item.contentType == null ? null : String(item.contentType),
      uploadedAt: String(item.uploadedAt ?? ''),
      expiresAt: item.expiresAt == null ? null : String(item.expiresAt),
      label: item.label == null ? null : String(item.label),
      agent: item.agent == null ? null : String(item.agent),
      session: item.session == null ? null : String(item.session),
      host: item.host == null ? null : String(item.host),
      repo: item.repo == null ? null : String(item.repo),
      meta: parseMetaField(item.meta),
    };
  });
  return { key, count: revisions.length, revisions };
}

/** Fetch and parse the retained prior versions of one published slug. `target`
 * accepts the same three forms as `agents artifacts unshare` (a full URL, `<user>/<slug>`,
 * or a bare slug resolved against the caller's own namespace) — reuses
 * {@link resolveDeleteTarget} rather than re-deriving the key. */
export async function runShareRevisions(
  target: string,
  opts: {
    githubUser?: string;
    config?: ShareConfig;
    writeToken?: string;
    byo?: boolean;
    session?: PhoenixSession | null;
    fetchListing?: ListingFetchFn;
  } = {},
): Promise<ShareRevisionsResult> {
  const backend = resolveShareBackend({
    githubUser: opts.githubUser,
    config: opts.config,
    writeToken: opts.writeToken,
    byo: opts.byo,
    session: opts.session,
    requireToken: false,
  } satisfies ResolveShareBackendOpts);
  if (backend.kind === 'byo') {
    const cfg = opts.config ?? readShareConfig();
    if (cfg && shareTemplateStatus(cfg) === 'outdated') {
      throw new Error(OUTDATED_TEMPLATE_HINT);
    }
  }

  const githubUser =
    backend.kind === 'managed'
      ? backend.namespace
      : opts.githubUser || backend.namespace || undefined;
  const { key } = await resolveDeleteTarget(target, { githubUser });
  const revUrl = `${backend.baseUrl.replace(/\/+$/, '')}/${key}?revisions=json`;
  const fetchListing = opts.fetchListing ?? defaultListingFetch;
  const res = await fetchListing(revUrl);

  if (res.status !== 200) {
    throw new Error(
      `Revisions lookup failed (${res.status}) for ${revUrl}. Check the endpoint is reachable, or that 'agents artifacts setup' / 'agents auth login' completed.`,
    );
  }
  if (!/application\/json/i.test(res.contentType)) {
    if (backend.kind === 'managed') {
      throw new Error(`Managed revisions at ${revUrl} did not return JSON (${res.contentType || 'no content-type'}).`);
    }
    throw new Error(OUTDATED_TEMPLATE_HINT);
  }
  return parseShareRevisions(key, res.body);
}

export function formatShareRevisions(result: ShareRevisionsResult, json = false): string {
  if (json) return JSON.stringify(result, null, 2);
  if (result.count === 0) {
    return chalk.dim(`No retained revisions for ${result.key} (only the current version exists).`);
  }
  const header =
    chalk.bold(result.key) + chalk.dim(`  ${result.count} retained ${result.count === 1 ? 'revision' : 'revisions'}`);
  const rows = result.revisions.map((r) => {
    const bits = [r.uploadedAt ? r.uploadedAt.slice(0, 10) : 'unknown', formatBytes(r.size)];
    if (r.agent) bits.push(r.agent);
    if (r.label) bits.push(r.label);
    const metaPairs = formatMetaPairs(r.meta);
    if (metaPairs) bits.push(metaPairs);
    return `${chalk.cyan(r.uploadedAt || r.key)}  ${chalk.dim(bits.join(' · '))}\n  ${chalk.green(r.url)}`;
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
  if (result.revisions?.length) {
    lines.push(chalk.dim(`  ${result.revisions.length} retained ${result.revisions.length === 1 ? 'revision' : 'revisions'} deleted`));
  }
  return lines.join('\n');
}

interface ShareDeleteCliOpts {
  keepCover?: boolean;
  keepRevisions?: boolean;
  ifExists?: boolean;
  forUser?: string;
  deleteJson?: boolean;
}

/** Shared handler for `agents artifacts share delete <targets...>` and the
 * nested `agents artifacts unshare <targets...>` alias. Deletes each target independently and
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
        keepRevisions: opts.keepRevisions === true,
        ifExists: opts.ifExists === true,
        githubUser: opts.forUser,
      });
      results.push({ target, result });
      if (!opts.deleteJson) console.log(formatShareDeleteResult(result));
    } catch (e) {
      results.push({ target, error: (e as Error).message });
      if (!opts.deleteJson) console.error(chalk.red(`${target}: ${(e as Error).message}`));
    }
  }

  if (opts.deleteJson) {
    console.log(JSON.stringify(results, null, 2));
  }

  if (results.some((r) => r.error)) {
    process.exitCode = 1;
  }
}

function registerShareDeleteOptions(cmd: Command): Command {
  return cmd
    .option('--keep-cover', 'leave the sibling <slug>.png OG cover in place (default: delete it too)')
    .option('--keep-revisions', 'leave retained revisions (<slug>/rev-*) in place (default: delete them too)')
    .option('--if-exists', 'treat an already-missing target as a no-op success instead of an error')
    // Named --for-user / --delete-json, not --github-user / --json: `share
    // <file>` (the parent of the nested `share delete`) already owns both
    // those long names, and commander resolves an option's long name against
    // the WHOLE ancestor chain — a same-named child option is silently
    // dropped at parse time even when it parses alone (RUSH-2687; verified
    // with a real program.parseAsync(), see share.test.ts). Matches the
    // `revisions` precedent (--for-user/--revisions-json) below, and applies
    // equally to the top-level `unshare` alias so both spellings stay
    // identical even though `unshare` itself has no ancestor collision.
    .option('--for-user <user>', 'GitHub username for resolving a bare-slug target (default: resolved from gh/git config)')
    .option('--delete-json', 'emit machine-readable results');
}

const SHARE_DELETE_EXAMPLES = `
      # Delete by full URL — also takes down the sibling OG cover and any retained revisions
      agents artifacts share delete https://share.agents-cli.sh/octocat/my-plan-a1b2

      # Delete by <user>/<slug>, or a bare slug in your own namespace
      agents artifacts share delete octocat/my-plan-a1b2
      agents artifacts unshare my-plan-a1b2

      # Several at once
      agents artifacts unshare my-plan-a1b2 old-report-9f3c

      # Keep the cover image up (rare — you usually want both gone)
      agents artifacts unshare my-plan-a1b2 --keep-cover

      # Keep retained revisions up too (rare — they're world-readable by URL like the page itself)
      agents artifacts unshare my-plan-a1b2 --keep-revisions

      # Don't error if it's already gone
      agents artifacts unshare my-plan-a1b2 --if-exists
`;

const SHARE_DELETE_NOTES = `
  A follow-up GET is required to resolve 404 before this reports success — the
  Worker's DELETE is idempotent and returns {"ok":true} even for a key that was
  never there, so that response alone is never proof of a takedown.

  Also deletes any retained revisions of the target (RUSH-2683) — a share that was
  republished at least once leaves its prior version(s) live at their own URL until
  they're purged too, so leaving them up would defeat the point of taking the page
  down. Pass --keep-revisions to leave them (they still expire via the bucket's
  lifecycle rule on their own schedule either way).

  agents artifacts share delete === agents artifacts unshare (same command, different name).
`;

/**
 * Register the `share` subtree under its parent group — `agents artifacts share`
 * (see commands/artifacts.ts). `agents artifacts unshare` is the nested alias
 * registered via {@link registerUnshareCommand} on the artifacts group.
 * registration on the ROOT program, so it is {@link registerUnshareCommand}, not
 * part of this subtree.
 */
export function registerShareCommands(artifactsCmd: Command): void {
  const shareCmd = artifactsCmd
    .command('share')
    .description('Publish an HTML file to a shareable link — managed if signed in, otherwise your Cloudflare R2.')
    .argument('[file]', 'file to publish (HTML or any static asset)')
    .option('--slug <slug>', 'custom URL slug under your namespace (default: <project>-<feature>-<hash>)')
    .option('--github-user <user>', 'GitHub username for the share namespace (default: resolved from gh/git config; ignored on the managed endpoint)')
    .option('--expire <spec>', "auto-expire (default 30d). e.g. 12h, 30d, 2026-08-01, or 'never'")
    .addOption(
      new Option('--visibility <level>', 'public | unlisted (default public). unlisted is a capability URL: GET still works, hidden from the gallery, X-Robots-Tag: noindex')
        .choices(['public', 'unlisted'])
        .default('public'),
    )
    .addOption(new Option('--unlisted', 'hidden alias of --visibility unlisted').hideHelp())
    .addOption(new Option('--private', 'hidden alias of --visibility unlisted').hideHelp())
    .option('--force', 'publish even when the file contains emails or credential-shaped strings')
    .option('--no-cover', 'skip the OG preview image (HTML pages get one by default)')
    .option('--no-analytics', 'skip injecting the Cloudflare Web Analytics beacon')
    .option('--label <text>', 'human display title, shown in the gallery and `share list` (default: derived from the HTML <title>, frontmatter title, or filename)')
    .option('--title <text>', 'alias of --label')
    .option(
      '--meta <key=value>',
      'structured metadata (repeatable), e.g. --meta kind=plan --meta ticket=RUSH-2683. Recommended keys: kind (plan|report|visual|screenshot|recording|deck|doc), project, ticket, status (draft|final). Reserved (set automatically, not settable): agent, session, host, repo, date, label',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--no-revision', "overwrite an existing slug in place — skip keeping the prior version as a <slug>/rev-<ts> backup (default: keep it, see 'agents artifacts share revisions')")
    .option('--json', 'emit machine-readable publish result for plan-render hooks and scripts')
    .action(async (file: string | undefined, opts: {
      slug?: string;
      githubUser?: string;
      expire?: string;
      visibility?: ShareVisibility;
      unlisted?: boolean;
      private?: boolean;
      force?: boolean;
      cover?: boolean;
      analytics?: boolean;
      label?: string;
      title?: string;
      meta: string[];
      revision?: boolean;
      json?: boolean;
    }) => {
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
        const meta = parseMetaEntries(opts.meta);
        const visibility = resolveShareVisibility({
          visibility: opts.visibility,
          unlisted: opts.unlisted === true || opts.private === true,
        });
        const result = await publishFile(file, {
          slug: opts.slug,
          githubUser: opts.githubUser,
          expire: opts.expire,
          visibility,
          unlisted: visibility === 'unlisted',
          force: opts.force,
          cover: opts.cover,
          analytics: opts.analytics,
          label: opts.label ?? opts.title,
          meta,
          noRevision: opts.revision === false,
        });
        console.log(formatSharePublishResult(result, Boolean(opts.json)));
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exitCode = 1;
      }
    });

  setHelpSections(shareCmd, {
    examples: `
      # Signed in? Just publish — no Cloudflare setup (managed endpoint)
      agents auth login
      agents artifacts share ./out/plan.html

      # Hide from the public gallery (direct URL still works, noindex) and expire sooner
      agents artifacts share ./out/report.html --visibility unlisted --expire 12h

      # Permanent public page (opt out of the default 30d expiry)
      agents artifacts share ./out/landing.html --slug landing --expire never

      # Custom slug, expiring in 7 days
      agents artifacts share ./out/report.html --slug q3-report --expire 7d

      # Human title + structured metadata, shown in the gallery and share list
      agents artifacts share ./out/plan.html --label "Q3 fleet plan" --meta kind=plan --meta ticket=RUSH-2683

      # Republish without keeping the previous version as a revision
      agents artifacts share ./out/plan.html --slug q3-report --no-revision
${SHARE_DELETE_EXAMPLES}
      # One-time setup (or join an existing endpoint)
      agents artifacts setup
      agents artifacts share join https://share.agents-cli.sh

      # Push a worker-template.ts change out to an already-provisioned endpoint
      agents artifacts share update
    `,
    notes: `
  Signed-in users publish to the managed endpoint (share.agents-cli.sh) with the
  Phoenix session — no Cloudflare account, bucket, or write token. Without a
  session, the existing BYO Cloudflare path still applies (setup / join).

  Default expiry is 30d so an accidental publish decays. Pass --expire never for
  a permanent link. --visibility unlisted (hidden aliases: --unlisted / --private)
  hides the page from the public gallery and agents artifacts share list; the
  direct URL is still world-readable (unlisted, not secret) and GET sends
  X-Robots-Tag: noindex. A pre-publish scan refuses emails and credential-shaped
  strings unless --force is passed.

  Every publish carries provenance auto-captured from the exec env/git/clock
  (agent, session, host, repo, date) — never invented, only sent when present —
  plus a label (explicit --label/--title, else derived from the HTML <title>,
  frontmatter title, or filename; never blocks on a prompt) and any --meta
  key=value pairs. Republishing an existing slug keeps the prior version as a
  retained revision by default; see 'agents artifacts share revisions'.
${SHARE_DELETE_NOTES}
    `,
  });

  const shareDeleteCmd = registerShareDeleteOptions(
    shareCmd
      .command('delete <targets...>')
      .description('Take down a published page (and by default its OG cover). Verifies the page 404s before reporting success. Nested alias: agents artifacts unshare.'),
  );
  setHelpSections(shareDeleteCmd, { examples: SHARE_DELETE_EXAMPLES, notes: SHARE_DELETE_NOTES });
  shareDeleteCmd.action(async (targets: string[], opts: ShareDeleteCliOpts) => {
    await runShareDelete(targets, opts);
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
    // Named --update-json, not --json: `share <file>` (the parent) already
    // owns --json for its own publish-time result. Commander resolves an
    // option's long name against the WHOLE ancestor chain, so a same-named
    // child option is silently dropped at parse time (RUSH-2687).
    .option('--update-json', 'emit a machine-readable result')
    .action(async (opts: { bundle: string; account?: string; token?: string; force?: boolean; updateJson?: boolean }) => {
      try {
        const result = await runShareUpdate(opts);
        if (opts.updateJson) {
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
      agents artifacts share update

      # Force a re-deploy even though the template hash already matches
      agents artifacts share update --force
    `,
    notes: `
  Reuses the existing account/worker/bucket from 'agents artifacts share status' and the
  existing write token — it never re-provisions a bucket, touches routes, or
  regenerates the token. See 'agents artifacts share status' for whether an update is due.
    `,
  });

  shareCmd
    .command('status')
    .description('Show the configured share endpoint and namespace.')
    .action(async () => {
      let backend: ShareBackend;
      try {
        backend = resolveShareBackend({ requireToken: false });
      } catch (e) {
        console.log(chalk.dim((e as Error).message));
        return;
      }
      if (backend.kind === 'managed') {
        console.log(`${chalk.bold('backend')}   ${chalk.green('managed')}`);
        console.log(`${chalk.bold('endpoint')}  ${chalk.green(backend.baseUrl)}`);
        console.log(`${chalk.bold('namespace')} ${chalk.cyan(`${backend.baseUrl}/${backend.namespace}`)}`);
        console.log(chalk.dim("Phoenix session — no Cloudflare setup. Force BYO with AGENTS_SHARE_BACKEND=byo."));
        return;
      }
      const cfg = readShareConfig();
      if (!cfg) {
        console.log(chalk.dim("Not configured. Run 'agents artifacts setup' or 'agents artifacts share join'."));
        return;
      }
      console.log(`${chalk.bold('backend')}   ${chalk.green('byo')}`);
      console.log(`${chalk.bold('endpoint')}  ${chalk.green(cfg.baseUrl)}`);
      console.log(chalk.dim(`worker ${cfg.workerName} · bucket ${cfg.bucketName} · account ${cfg.accountId || 'missing'}`));
      if (!cfg.accountId) {
        console.log(chalk.dim('account id empty — publish still uses baseUrl + WRITE_TOKEN; `agents artifacts share update` needs --account or join'));
      }
      const user = await resolveGitHubUsername();
      console.log(`${chalk.bold('namespace')} ${user ? chalk.cyan(`${cfg.baseUrl}/${user}`) : chalk.yellow('unknown — set gh auth or github.user')}`);
      console.log(`${chalk.bold('analytics')} ${analyticsEnabled(cfg) ? chalk.green('enabled') : chalk.dim('not configured')}`);
      const templateStatus = shareTemplateStatus(cfg);
      const templateLabel =
        templateStatus === 'current'
          ? chalk.green('current')
          : templateStatus === 'outdated'
            ? chalk.yellow('outdated — run `agents artifacts share update`')
            : chalk.dim("unknown — provisioned before version tracking; run `agents artifacts share update` to adopt it");
      console.log(`${chalk.bold('template')}  ${templateLabel}`);
    });

  const shareListCmd = shareCmd
    .command('list')
    .description("List the pages you've published to your share namespace (human table; --list-json for scripts).")
    // Named --for-user / --list-json, not --github-user / --json: `share
    // <file>` (the parent) already owns both those long names, and commander
    // resolves an option's long name against the WHOLE ancestor chain — a
    // same-named child option is silently dropped at parse time even when it
    // parses alone (RUSH-2687; verified with a real program.parseAsync(), see
    // share.test.ts). Matches the `revisions` precedent (--for-user/
    // --revisions-json) and the `delete`/`unshare` precedent (--for-user/
    // --delete-json) below.
    .option('--for-user <user>', 'GitHub username whose namespace to list (default: resolved from gh/git config)')
    .option('--agent <name>', 'filter to shares published by this agent/harness (case-insensitive)')
    .option('--session <id>', 'filter to shares published from this session id')
    // Named --label-contains, not --label: `share <file>` (the parent) already owns
    // `--label`/`--title`, same collision class as --for-user/--list-json above.
    .option('--label-contains <substr>', 'filter to shares whose label contains this text (case-insensitive)')
    .option('--list-json', 'emit the machine-readable listing (slug, url, size, contentType, publishedAt, expiresAt, label, agent, session, host, repo, revisionCount, meta)')
    .action(async (opts: { forUser?: string; agent?: string; session?: string; labelContains?: string; listJson?: boolean }) => {
      try {
        const result = await runShareList({
          githubUser: opts.forUser,
          agent: opts.agent,
          session: opts.session,
          label: opts.labelContains,
        });
        console.log(formatShareList(result, Boolean(opts.listJson)));
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exitCode = 1;
      }
    });

  setHelpSections(shareListCmd, {
    examples: `
      # Everything you've published, newest first
      agents artifacts share list

      # Machine-readable — e.g. pull every still-public URL with jq
      agents artifacts share list --list-json | jq -r '.objects[].url'

      # List another namespace
      agents artifacts share list --for-user octocat

      # Narrow by who/what published it
      agents artifacts share list --agent claude
      agents artifacts share list --label-contains "fleet plan"
    `,
    notes: `
  Lists the ACTIVE pages in your namespace — expired links and the sibling .png OG
  covers are omitted (it mirrors the public gallery). Signed-in users list the
  managed endpoint (share.agents-cli.sh/<userId>); otherwise BYO. It reads the
  endpoint's JSON listing route, which ships with the current Worker template. If
  a BYO Worker predates this feature the command says so and points you at 'agents
  artifacts share update' (RUSH-2449) rather than returning a wrong or empty result
  — see 'agents artifacts share status' for whether an update is due.

  --agent/--session/--label-contains filter the fetched listing client-side;
  --list-json's count reflects the filtered set.
    `,
  });

  const shareRevisionsCmd = shareCmd
    .command('revisions <target>')
    .description('Show the retained prior versions of a published slug, newest first (human table; --revisions-json for scripts).')
    // Named --for-user / --revisions-json, not --github-user / --json: `share
    // <file>` (the parent) already owns both those long names, and commander
    // resolves an option's long name against the WHOLE ancestor chain — a
    // same-named child option is silently dropped at parse time even when it
    // parses alone (RUSH-2687; verified with a real program.parseAsync(), see
    // share.test.ts). Same collision class as `list`/`update`/`delete` above.
    .option('--for-user <user>', 'GitHub username for resolving a bare-slug target (default: resolved from gh/git config)')
    .option('--revisions-json', 'emit the machine-readable revision list')
    .action(async (target: string, opts: { forUser?: string; revisionsJson?: boolean }) => {
      try {
        const result = await runShareRevisions(target, { githubUser: opts.forUser });
        console.log(formatShareRevisions(result, Boolean(opts.revisionsJson)));
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exitCode = 1;
      }
    });

  setHelpSections(shareRevisionsCmd, {
    examples: `
      # Prior versions kept under this slug (bare slug — your own namespace)
      agents artifacts share revisions q3-report

      # By <user>/<slug> or full URL, same target forms as 'agents artifacts unshare'
      agents artifacts share revisions octocat/q3-report
      agents artifacts share revisions https://share.agents-cli.sh/octocat/q3-report

      # Machine-readable, and a bare slug resolved against another namespace
      agents artifacts share revisions q3-report --revisions-json
      agents artifacts share revisions q3-report --for-user octocat
    `,
    notes: `
  A revision is created automatically on every republish of an existing slug
  (pass --no-revision at publish time to skip it) — this is history, never
  shown on the public gallery or in 'agents artifacts share list' beyond its
  count. Each revision's own URL is still directly reachable and honors its own
  recorded expiry. Signed-in users resolve a bare slug against the managed
  Phoenix namespace; otherwise BYO (GitHub username / --for-user).
    `,
  });

  shareCmd
    .command('analytics')
    .description('Show the Cloudflare Web Analytics status for this share endpoint.')
    .action(async () => {
      let backend: ShareBackend | undefined;
      try {
        backend = resolveShareBackend({ requireToken: false });
      } catch (e) {
        console.log(chalk.dim((e as Error).message));
        return;
      }
      if (backend.kind === 'managed') {
        console.log(chalk.yellow('Cloudflare Web Analytics is a BYO feature.'));
        console.log(
          chalk.dim(
            `You're on the managed endpoint (${backend.baseUrl}). Per-page analytics for the managed endpoint is not in this release — provision your own Cloudflare with 'agents artifacts setup --analytics-token <token>', or force BYO with AGENTS_SHARE_BACKEND=byo.`,
          ),
        );
        return;
      }
      const cfg = readShareConfig();
      if (!cfg) {
        console.log(chalk.dim("Not configured. Run 'agents artifacts setup' or 'agents artifacts share join'."));
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

/**
 * Register `agents artifacts unshare <targets...>` as the nested alias of
 * `agents artifacts share delete`. Top-level `agents unshare` is retired.
 */
export function registerUnshareCommand(artifactsCmd: Command): void {
  const unshareCmd = registerShareDeleteOptions(
    artifactsCmd
      .command('unshare <targets...>')
      .description('Alias of `agents artifacts share delete` — take down a published page (and by default its OG cover).'),
  );
  setHelpSections(unshareCmd, { examples: SHARE_DELETE_EXAMPLES, notes: SHARE_DELETE_NOTES });
  unshareCmd.action(async (targets: string[], opts: ShareDeleteCliOpts) => {
    await runShareDelete(targets, opts);
  });
}

/** Provision a fresh R2 bucket + Worker on the user's Cloudflare and persist the
 * endpoint config + write token. Shared by both modes of `agents artifacts setup`
 * (the flag-driven provision and the interactive wizard). */
export async function runShareProvision(opts: {
  bundle: string;
  worker: string;
  bucket: string;
  account?: string;
  token?: string;
  domain?: string;
  analyticsToken?: string;
  request?: CloudflareRequester;
  /** Bind PHOENIX_ID_BASE even when the mapped hostname is not the managed domain. */
  managed?: boolean;
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
    const phoenixIdBase = phoenixIdBaseForDeploy({ managed: opts.managed }, { baseUrl, domain });
    if (phoenixIdBase) {
      await putWorkerSecret(
        apiToken,
        accountId,
        workerName,
        WORKER_PHOENIX_ID_BASE_SECRET,
        phoenixIdBase,
        provisionOpts,
      );
      spin.text = `Worker '${workerName}' Phoenix ID base set`;
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
    console.log(chalk.dim('Publish with:  ') + chalk.cyan('agents artifacts share <file>'));
    console.log(
      chalk.dim(
        `Fleet: push the token with 'agents secrets export share --device <box>' and pull config with 'agents repo pull'.`,
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
 * `updateWorker` in `lib/share/provision.ts` for how the token — and, on a
 * managed endpoint, `PHOENIX_ID_BASE` — survives the re-upload). Idempotent:
 * no-ops the script upload when the deployed hash already matches unless
 * `force`; a managed endpoint still re-applies `PHOENIX_ID_BASE`. */
export async function runShareUpdate(opts: {
  bundle?: string;
  account?: string;
  token?: string;
  force?: boolean;
  request?: CloudflareRequester;
  /** Bind PHOENIX_ID_BASE even when the configured hostname is not the managed domain. */
  managed?: boolean;
} = {}): Promise<ShareUpdateResult> {
  const cfg = readShareConfig();
  if (!cfg) {
    throw new Error("Not configured. Run 'agents artifacts setup' (to provision) or 'agents artifacts share join' first.");
  }

  const { apiToken, accountId: acctFromBundle } = readCloudflareCreds(opts.bundle ?? DEFAULT_CF_BUNDLE, {
    apiToken: opts.token,
    accountId: opts.account,
  });
  const accountId = opts.account || acctFromBundle || cfg.accountId;
  if (!accountId) {
    throw new Error(
      "Share endpoint has no Cloudflare account id — `agents artifacts share update` cannot call the API. Pass --account <id>, or re-run 'agents artifacts share join'.",
    );
  }
  const writeToken = readWriteToken();
  const script = renderWorkerScript();
  const phoenixIdBase = phoenixIdBaseForDeploy({ managed: opts.managed }, cfg);
  const provisionOpts = {
    ...(opts.request ? { request: opts.request } : {}),
    force: opts.force,
    ...(phoenixIdBase !== undefined ? { phoenixIdBase } : {}),
  };

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
    writeShareConfig({ ...cfg, accountId, templateHash: result.templateHash });
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
 * details + write token and persist them. Shared by `agents artifacts share join`
 * and the `agents artifacts setup` wizard. */
export async function runShareJoin(baseUrl?: string, opts: { token?: string } = {}): Promise<void> {
  const { password, input } = await import('@inquirer/prompts');
  const existing = readShareConfig();
  const clean = baseUrl?.replace(/\/+$/, '');
  if (!clean && !existing) {
    throw new Error(
      "No synced share endpoint found. Pull config first with 'agents repo pull', or pass the endpoint URL: agents artifacts share join <baseUrl>.",
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
  console.log(chalk.green(`Joined ${chalk.bold(cfg.baseUrl)} — publish with `) + chalk.cyan('agents artifacts share <file>'));
}
