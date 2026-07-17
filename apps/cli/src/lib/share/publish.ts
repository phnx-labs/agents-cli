// The publish path for `agents share <file>` — an authed PUT to the Worker.
// Pure logic (slug, expiry) is exported for tests; the network call is behind a DI seam.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readShareConfig, readWriteToken } from './config.js';

export interface PublishOptions {
  slug?: string;
  /** e.g. `30d`, `12h`, or an absolute date like `2026-08-01`. */
  expire?: string;
  contentType?: string;
  /** DI seam for tests — override the real HTTP PUT. */
  uploader?: (
    url: string,
    body: Buffer,
    headers: Record<string, string>,
  ) => Promise<{ ok: boolean; status: number; url?: string }>;
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
): Promise<{ url: string; expiresAt?: string }> {
  const cfg = readShareConfig();
  if (!cfg) {
    throw new Error(
      "Not set up yet. Run 'agents share setup' (provision your own endpoint) or 'agents share join' (use an existing one).",
    );
  }
  const token = readWriteToken();
  const body = readFileSync(filePath);
  const slug = (opts.slug ?? slugify(filePath)).replace(/^\/+/, '');
  const expiresAt = parseExpire(opts.expire);
  const url = `${cfg.baseUrl}/${slug}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': opts.contentType ?? guessContentType(filePath),
  };
  if (expiresAt) headers['x-share-expires-at'] = expiresAt;

  const put =
    opts.uploader ??
    (async (u, b, h) => {
      const res = await fetch(u, { method: 'PUT', headers: h, body: new Uint8Array(b) });
      return { ok: res.ok, status: res.status, url: u };
    });

  const r = await put(url, body, headers);
  if (!r.ok) {
    throw new Error(
      `Publish failed (${r.status}) for ${url}. Check the write token, or that 'agents share setup' completed.`,
    );
  }
  return { url: r.url ?? url, expiresAt };
}
