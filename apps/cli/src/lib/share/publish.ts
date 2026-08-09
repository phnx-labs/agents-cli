// The publish path for `agents share <file>` — an authed PUT to the Worker.
// Pure logic (slug, expiry) is exported for tests; the network call is behind a DI seam.
//
// For HTML publishes it also captures a 1200×630 cover (the page's own hero) and
// injects og:image / twitter:card meta, so the link unfurls into a preview card in
// Slack / iMessage / Twitter / Discord. The cover is best-effort: if no headless
// browser is available it's skipped and the plain link still publishes.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readShareConfig, readWriteToken, type ShareConfig } from './config.js';
import { resolveGitHubUsername } from '../git.js';
import { captureCover, OG_WIDTH, OG_HEIGHT, OG_SCALE } from './capture.js';
import { deriveMeta, injectOgMeta } from './og.js';
import { injectAnalyticsBeacon } from './analytics.js';

export type PutFn = (
  url: string,
  body: Buffer,
  headers: Record<string, string>,
) => Promise<{ ok: boolean; status: number; url?: string }>;

export interface PublishEndpoint {
  baseUrl: string;
  token: string;
}

export interface PublishOptions {
  slug?: string;
  /**
   * Auto-expire window. Relative (`30d`, `12h`), absolute (`2026-08-01`), or
   * `never` / `none` / `permanent` for no expiry. When omitted, publishes default
   * to {@link DEFAULT_SHARE_EXPIRE} so an accidental share decays instead of
   * living forever (RUSH-2443).
   */
  expire?: string;
  contentType?: string;
  /**
   * Hide this page from the public `/<user>` gallery and `agents share list`
   * (metadata `visibility=unlisted`). The direct URL is still world-readable —
   * unlisted, not secret (RUSH-2443). Alias of `--private` on the CLI.
   */
  unlisted?: boolean;
  /**
   * Bypass the pre-publish sensitive-content scan (emails / credential-shaped
   * strings). Required when the page intentionally carries those patterns.
   */
  force?: boolean;
  /** Generate + attach an OG cover for HTML pages (default true). */
  cover?: boolean;
  /** Inject the Cloudflare Web Analytics beacon (default true for HTML). */
  analytics?: boolean;
  /** Override the analytics token from share config. */
  analyticsToken?: string;
  /** Override the GitHub username used for the URL namespace. */
  githubUser?: string;
  /** DI seam for tests — override the persisted share endpoint config. */
  config?: ShareConfig;
  /** DI seam for tests — override the keychain-backed write token. */
  writeToken?: string;
  /** DI seam for tests — override the real HTTP PUT. */
  uploader?: PutFn;
  /** DI seam for tests — override cover capture (returns a PNG buffer or null). */
  capturer?: (htmlPath: string) => Promise<Buffer | null>;
}

export interface PublishResult {
  url: string;
  expiresAt?: string;
  coverUrl?: string;
  /** True when the page was published with `visibility=unlisted`. */
  unlisted?: boolean;
}

/** Default auto-expire for unflagged publishes — accidental links decay (RUSH-2443). */
export const DEFAULT_SHARE_EXPIRE = '30d';

const UNIT_MS: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

/** `30d` / `12h` / `2026-08-01` → an absolute ISO timestamp (or undefined). */
export function parseExpire(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  const rel = /^(\d+)\s*([smhdw])$/i.exec(spec.trim());
  if (rel) {
    return new Date(Date.now() + parseInt(rel[1], 10) * UNIT_MS[rel[2].toLowerCase()]).toISOString();
  }
  const d = new Date(spec);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  throw new Error(
    `Bad --expire '${spec}'. Use e.g. 30d, 12h, an absolute date like 2026-08-01, or 'never' for no expiry.`,
  );
}

/**
 * Resolve the publish expiry. Omitted → {@link DEFAULT_SHARE_EXPIRE}. Explicit
 * `never` / `none` / `permanent` → no expiry. Anything else → {@link parseExpire}.
 */
export function resolveExpire(spec: string | undefined): string | undefined {
  if (spec === undefined) return parseExpire(DEFAULT_SHARE_EXPIRE);
  const trimmed = spec.trim().toLowerCase();
  if (trimmed === 'never' || trimmed === 'none' || trimmed === 'permanent') return undefined;
  return parseExpire(spec);
}

export type SensitiveHitKind = 'email' | 'credential';

export interface SensitiveHit {
  kind: SensitiveHitKind;
  /** Short redacted sample so the error names *what* was found without dumping it. */
  sample: string;
}

/** Email addresses — the RUSH-2428 incident page carried seven of these. */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Credential-shaped strings that an agent routinely dumps into reports: GitHub
 * PATs, OpenAI/Anthropic/etc. API keys, AWS access keys, Slack tokens, and a
 * generic long `sk-…` / `Bearer …` form. Keep the set tight — false positives
 * force `--force` and train agents to bypass the gate.
 */
const CREDENTIAL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bghp_[A-Za-z0-9_]{20,}\b/g, label: 'ghp_…' },
  { re: /\bgho_[A-Za-z0-9_]{20,}\b/g, label: 'gho_…' },
  { re: /\bghu_[A-Za-z0-9_]{20,}\b/g, label: 'ghu_…' },
  { re: /\bghs_[A-Za-z0-9_]{20,}\b/g, label: 'ghs_…' },
  { re: /\bghr_[A-Za-z0-9_]{20,}\b/g, label: 'ghr_…' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: 'github_pat_…' },
  { re: /\bsk-(?:ant|proj|live|test)?[_-]?[A-Za-z0-9]{16,}\b/g, label: 'sk-…' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AKIA…' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'xox…' },
  { re: /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}\b/gi, label: 'Bearer …' },
];

function redactSample(raw: string, max = 12): string {
  if (raw.length <= max) return raw.slice(0, 4) + '…';
  return raw.slice(0, Math.min(6, max)) + '…';
}

/**
 * Scan a text body for email addresses and credential-shaped strings. Returns
 * the first few hits (deduped by kind+sample). Binary / non-text bodies yield
 * nothing — the gate is for HTML/text reports, not screenshots.
 */
export function scanShareContent(body: string | Buffer): SensitiveHit[] {
  // Skip clearly-binary content (null bytes in the first 1KB) so a PNG/MP4
  // publish never false-positives on binary noise.
  if (Buffer.isBuffer(body)) {
    const head = body.subarray(0, Math.min(body.length, 1024));
    if (head.includes(0)) return [];
  }
  const text = typeof body === 'string' ? body : body.toString('utf8');
  const hits: SensitiveHit[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(EMAIL_RE)) {
    const sample = redactSample(m[0]);
    const key = `email:${sample}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ kind: 'email', sample });
    if (hits.length >= 5) return hits;
  }

  for (const { re, label } of CREDENTIAL_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m) continue;
    const sample = label;
    const key = `credential:${sample}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ kind: 'credential', sample });
    if (hits.length >= 5) return hits;
  }

  return hits;
}

/** Build the refuse message when the pre-publish scan finds sensitive content. */
export function formatSensitiveContentError(hits: SensitiveHit[]): string {
  const kinds = Array.from(new Set(hits.map((h) => h.kind)));
  const samples = hits.map((h) => h.sample).join(', ');
  const what =
    kinds.length === 2
      ? 'email addresses and credential-shaped strings'
      : kinds[0] === 'email'
        ? 'email addresses'
        : 'credential-shaped strings';
  return (
    `Refusing to publish: the file contains ${what} (${samples}). ` +
    `Shares are world-readable by URL — pass --force to publish anyway, ` +
    `or --unlisted --expire 12h to bound the blast radius.`
  );
}

/** Derive a URL-safe slug from a filename (or pass one through). */
export function slugify(name: string): string {
  return (
    basename(name)
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'page'
  );
}

function sanitizeSlugPart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The project the file belongs to — git repo name, else the cwd's basename. */
export function detectProject(dir: string = process.cwd()): string {
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (top) return sanitizeSlugPart(basename(top)) || 'share';
  } catch {
    // not a git repo — fall through to cwd basename
  }
  return sanitizeSlugPart(basename(dir)) || 'share';
}

/**
 * Notion-style default slug: `<project>-<feature>-<16hex>`. Project scopes the link
 * to the repo the agent is in; the random tail keeps it unguessable + collision-free.
 * A leading `plan-` on the filename is dropped (it's redundant under the project).
 *
 * The tail is 8 random bytes (64-bit, 16 hex chars). Reads are public — the URL is
 * the only capability — so the nonce must be genuinely infeasible to brute-force,
 * not merely unlisted; 64 bits puts a blind guess out of reach. (See docs/share.md
 * §Security for the threat model and `--expire` for sensitive content.)
 */
export function defaultSlug(filePath: string, dir?: string): string {
  const feature = slugify(filePath).replace(/^plan-/, '') || 'page';
  return `${detectProject(dir)}-${feature}-${randomBytes(8).toString('hex')}`;
}

function guessContentType(filePath: string): string {
  if (/\.html?$/i.test(filePath)) return 'text/html; charset=utf-8';
  if (/\.css$/i.test(filePath)) return 'text/css; charset=utf-8';
  if (/\.js$/i.test(filePath)) return 'text/javascript; charset=utf-8';
  if (/\.json$/i.test(filePath)) return 'application/json';
  if (/\.svg$/i.test(filePath)) return 'image/svg+xml';
  // Raster images + video: agents publish screenshots and screen recordings as PR
  // evidence, and GitHub's image proxy (camo) only renders an inline `![](url)` when
  // the asset is served with a real image/video content-type — octet-stream is
  // refused. Type them so the share URL embeds instead of downloading.
  if (/\.png$/i.test(filePath)) return 'image/png';
  if (/\.jpe?g$/i.test(filePath)) return 'image/jpeg';
  if (/\.gif$/i.test(filePath)) return 'image/gif';
  if (/\.webp$/i.test(filePath)) return 'image/webp';
  if (/\.avif$/i.test(filePath)) return 'image/avif';
  if (/\.ico$/i.test(filePath)) return 'image/x-icon';
  if (/\.mp4$/i.test(filePath)) return 'video/mp4';
  if (/\.mov$/i.test(filePath)) return 'video/quicktime';
  if (/\.webm$/i.test(filePath)) return 'video/webm';
  if (/\.pdf$/i.test(filePath)) return 'application/pdf';
  if (/\.txt$|\.md$/i.test(filePath)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * Best-effort OG cover: capture a screenshot, upload it as `<slug>.png`, and return
 * the page body with og:image meta injected (+ the cover URL). All IO is injected
 * (`put`, `capturer`), so this whole path is unit-testable without config/keychain.
 * Any miss — no capturer output, a failed upload — returns the original body and no
 * coverUrl, so publishing never fails because a cover couldn't be made.
 */
export async function attachOgCover(
  filePath: string,
  body: Buffer,
  ctx: {
    /** Absolute URL to PUT the cover to, `${pageUrl}.png`. Doubles as the cover URL. */
    pngUrl: string;
    pageUrl: string;
    put: PutFn;
    pngHeaders: Record<string, string>;
    capturer: (p: string) => Promise<Buffer | null>;
  },
): Promise<{ body: Buffer; coverUrl?: string }> {
  const png = await ctx.capturer(filePath).catch(() => null);
  if (!png) return { body };
  const cr = await ctx.put(ctx.pngUrl, png, ctx.pngHeaders);
  if (!cr.ok) return { body };
  const { title, description } = deriveMeta(body.toString('utf8'));
  const injected = injectOgMeta(body.toString('utf8'), {
    title,
    description,
    imageUrl: ctx.pngUrl,
    pageUrl: ctx.pageUrl,
    imageWidth: OG_WIDTH * OG_SCALE,
    imageHeight: OG_HEIGHT * OG_SCALE,
  });
  return { body: Buffer.from(injected, 'utf8'), coverUrl: ctx.pngUrl };
}

/** Resolve the publisher's GitHub username, with an explicit override winning first. */
export async function resolveShareUsername(opts: { githubUser?: string } = {}): Promise<string> {
  if (opts.githubUser) {
    const sanitized = sanitizeSlugPart(opts.githubUser);
    if (sanitized) return sanitized;
  }
  const resolved = await resolveGitHubUsername();
  if (resolved) return sanitizeSlugPart(resolved);
  throw new Error(
    "Could not determine your GitHub username for the share URL namespace. " +
      "Authenticate with `gh auth login`, set `git config --global github.user <user>`, " +
      "or pass `--github-user <user>`.",
  );
}

/** Build the R2 object key from a namespace username and a slug part. */
export function buildShareKey(username: string, slugPart: string): string {
  const user = sanitizeSlugPart(username);
  const part = sanitizeSlugPart(slugPart.replace(/\//g, '-'));
  if (!user) throw new Error('GitHub username is required for the share URL namespace.');
  if (!part) throw new Error('Share slug is empty.');
  return `${user}/${part}`;
}

export async function publishFile(
  filePath: string,
  opts: PublishOptions = {},
): Promise<PublishResult> {
  const cfg = opts.config ?? readShareConfig();
  if (!cfg) {
    throw new Error(
      "Not set up yet. Run 'agents share setup' (provision your own endpoint) or 'agents share join' (use an existing one).",
    );
  }
  const token = opts.writeToken ?? readWriteToken();
  const username = await resolveShareUsername(opts);
  const analyticsToken = opts.analyticsToken ?? cfg.analyticsToken;
  return publishToEndpoint(filePath, { baseUrl: cfg.baseUrl, token }, {
    ...opts,
    githubUser: username,
    analyticsToken,
  });
}

export async function publishToEndpoint(
  filePath: string,
  endpoint: PublishEndpoint,
  opts: PublishOptions = {},
): Promise<PublishResult> {
  const username = await resolveShareUsername(opts);
  const slugPart = (opts.slug ?? defaultSlug(filePath)).replace(/^\/+/, '');
  const key = buildShareKey(username, slugPart);
  const expiresAt = resolveExpire(opts.expire);
  const unlisted = opts.unlisted === true;
  const pageUrl = `${endpoint.baseUrl.replace(/\/+$/, '')}/${key}`;

  const put =
    opts.uploader ??
    (async (u: string, b: Buffer, h: Record<string, string>) => {
      const res = await fetch(u, { method: 'PUT', headers: h, body: new Uint8Array(b) });
      return { ok: res.ok, status: res.status, url: u };
    });
  const authHeaders = (contentType: string): Record<string, string> => {
    const h: Record<string, string> = { authorization: `Bearer ${endpoint.token}`, 'content-type': contentType };
    if (expiresAt) h['x-share-expires-at'] = expiresAt;
    if (unlisted) h['x-share-visibility'] = 'unlisted';
    return h;
  };

  let body: Buffer = readFileSync(filePath);
  let coverUrl: string | undefined;
  const isHtml = /\.html?$/i.test(filePath);

  // Pre-publish scan (RUSH-2443): refuse emails / credential-shaped strings
  // unless --force. Runs on the raw file before analytics/cover mutation so a
  // beacon injection never triggers a false positive. Binary media is a no-op.
  if (opts.force !== true) {
    const hits = scanShareContent(body);
    if (hits.length > 0) {
      throw new Error(formatSensitiveContentError(hits));
    }
  }

  // Analytics: cookieless CF Web Analytics beacon, injected for HTML by default.
  if (isHtml && opts.analytics !== false && opts.analyticsToken) {
    body = Buffer.from(injectAnalyticsBeacon(body.toString('utf8'), opts.analyticsToken), 'utf8');
  }

  // Cover: screenshot the page's hero → upload <slug>.png → inject og:image meta.
  // Unlisted pages still get a cover (the direct URL is the capability), but the
  // cover inherits visibility=unlisted so it is also omitted from the gallery.
  if (isHtml && opts.cover !== false) {
    const res = await attachOgCover(filePath, body, {
      pngUrl: `${pageUrl}.png`,
      pageUrl,
      put,
      pngHeaders: authHeaders('image/png'),
      capturer: opts.capturer ?? captureCover,
    });
    body = res.body;
    coverUrl = res.coverUrl;
  }

  const r = await put(pageUrl, body, authHeaders(opts.contentType ?? guessContentType(filePath)));
  if (!r.ok) {
    throw new Error(
      `Publish failed (${r.status}) for ${pageUrl}. Check the write token, or that 'agents share setup' completed.`,
    );
  }
  return {
    url: r.url ?? pageUrl,
    expiresAt,
    coverUrl,
    ...(unlisted ? { unlisted: true } : {}),
  };
}
