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
import { readShareConfig, readWriteToken } from './config.js';
import { captureCover } from './capture.js';
import { deriveMeta, injectOgMeta } from './og.js';

export interface PublishOptions {
  slug?: string;
  /** e.g. `30d`, `12h`, or an absolute date like `2026-08-01`. */
  expire?: string;
  contentType?: string;
  /** Generate + attach an OG cover for HTML pages (default true). */
  cover?: boolean;
  /** DI seam for tests — override the real HTTP PUT. */
  uploader?: (
    url: string,
    body: Buffer,
    headers: Record<string, string>,
  ) => Promise<{ ok: boolean; status: number; url?: string }>;
  /** DI seam for tests — override cover capture (returns a PNG buffer or null). */
  capturer?: (htmlPath: string) => Promise<Buffer | null>;
}

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
  throw new Error(`Bad --expire '${spec}'. Use e.g. 30d, 12h, or an absolute date like 2026-08-01.`);
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
 * Notion-style default slug: `<project>-<feature>-<6hex>`. Project scopes the link
 * to the repo the agent is in; the random tail keeps it unguessable + collision-free.
 * A leading `plan-` on the filename is dropped (it's redundant under the project).
 */
export function defaultSlug(filePath: string, dir?: string): string {
  const feature = slugify(filePath).replace(/^plan-/, '') || 'page';
  return `${detectProject(dir)}-${feature}-${randomBytes(3).toString('hex')}`;
}

function guessContentType(filePath: string): string {
  if (/\.html?$/i.test(filePath)) return 'text/html; charset=utf-8';
  if (/\.css$/i.test(filePath)) return 'text/css; charset=utf-8';
  if (/\.js$/i.test(filePath)) return 'text/javascript; charset=utf-8';
  if (/\.json$/i.test(filePath)) return 'application/json';
  if (/\.svg$/i.test(filePath)) return 'image/svg+xml';
  if (/\.txt$|\.md$/i.test(filePath)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

export async function publishFile(
  filePath: string,
  opts: PublishOptions = {},
): Promise<{ url: string; expiresAt?: string; coverUrl?: string }> {
  const cfg = readShareConfig();
  if (!cfg) {
    throw new Error(
      "Not set up yet. Run 'agents share setup' (provision your own endpoint) or 'agents share join' (use an existing one).",
    );
  }
  const token = readWriteToken();
  const slug = (opts.slug ?? defaultSlug(filePath)).replace(/^\/+/, '');
  const expiresAt = parseExpire(opts.expire);
  const pageUrl = `${cfg.baseUrl}/${slug}`;

  const put =
    opts.uploader ??
    (async (u: string, b: Buffer, h: Record<string, string>) => {
      const res = await fetch(u, { method: 'PUT', headers: h, body: new Uint8Array(b) });
      return { ok: res.ok, status: res.status, url: u };
    });
  const authHeaders = (contentType: string): Record<string, string> => {
    const h: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': contentType };
    if (expiresAt) h['x-share-expires-at'] = expiresAt;
    return h;
  };

  let body = readFileSync(filePath);
  const isHtml = /\.html?$/i.test(filePath);
  let coverUrl: string | undefined;

  // Cover: screenshot the page's hero → upload <slug>.png → inject og:image meta.
  if (isHtml && opts.cover !== false) {
    const capture = opts.capturer ?? captureCover;
    const png = await capture(filePath).catch(() => null);
    if (png) {
      const imgUrl = `${pageUrl}.png`;
      const cr = await put(`${cfg.baseUrl}/${slug}.png`, png, authHeaders('image/png'));
      if (cr.ok) {
        coverUrl = imgUrl;
        const { title, description } = deriveMeta(body.toString('utf8'));
        body = Buffer.from(
          injectOgMeta(body.toString('utf8'), { title, description, imageUrl: imgUrl, pageUrl }),
          'utf8',
        );
      }
    }
  }

  const r = await put(pageUrl, body, authHeaders(opts.contentType ?? guessContentType(filePath)));
  if (!r.ok) {
    throw new Error(
      `Publish failed (${r.status}) for ${pageUrl}. Check the write token, or that 'agents share setup' completed.`,
    );
  }
  return { url: r.url ?? pageUrl, expiresAt, coverUrl };
}
