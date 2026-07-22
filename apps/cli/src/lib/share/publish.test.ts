import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseExpire, slugify, detectProject, defaultSlug, attachOgCover } from './publish.js';
import { renderWorkerScript } from './worker-template.js';

describe('attachOgCover', () => {
  const ctx = (
    put: (u: string, b: Buffer, h: Record<string, string>) => Promise<{ ok: boolean; status: number; url?: string }>,
    capturer: (p: string) => Promise<Buffer | null>,
  ) => ({ pngUrl: 'https://s.sh/x.png', pageUrl: 'https://s.sh/x', put, pngHeaders: {}, capturer });

  it('uploads the cover and injects og:image + the true (2×) dimensions on success', async () => {
    const puts: string[] = [];
    const put = async (u: string) => {
      puts.push(u);
      return { ok: true, status: 200, url: u };
    };
    const r = await attachOgCover('/tmp/p.html', Buffer.from('<head></head>'), ctx(put, async () => Buffer.from('PNG')));
    expect(r.coverUrl).toBe('https://s.sh/x.png');
    expect(puts).toEqual(['https://s.sh/x.png']);
    const html = r.body.toString();
    expect(html).toContain('og:image" content="https://s.sh/x.png"');
    expect(html).toContain('<meta property="og:image:width" content="2400">'); // 1200 * OG_SCALE(2)
    expect(html).toContain('<meta property="og:image:height" content="1260">');
  });

  it('publishes the plain page (no meta, original body) when the cover upload fails', async () => {
    const put = async () => ({ ok: false, status: 403 });
    const r = await attachOgCover('/tmp/p.html', Buffer.from('<head></head>'), ctx(put, async () => Buffer.from('PNG')));
    expect(r.coverUrl).toBeUndefined();
    expect(r.body.toString()).toBe('<head></head>');
    expect(r.body.toString()).not.toContain('og:image');
  });

  it('never attempts an upload when the capturer yields nothing', async () => {
    let uploads = 0;
    const put = async () => {
      uploads++;
      return { ok: true, status: 200 };
    };
    const r = await attachOgCover('/tmp/p.html', Buffer.from('<head></head>'), ctx(put, async () => null));
    expect(r.coverUrl).toBeUndefined();
    expect(uploads).toBe(0);
    expect(r.body.toString()).not.toContain('og:image');
  });

  it('swallows a throwing capturer — a cover is never a reason to fail a publish', async () => {
    const put = async () => ({ ok: true, status: 200 });
    const r = await attachOgCover(
      '/tmp/p.html',
      Buffer.from('<head></head>'),
      ctx(put, async () => {
        throw new Error('boom');
      }),
    );
    expect(r.coverUrl).toBeUndefined();
  });
});

function expectedProject(dir: string): string {
  return basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

describe('detectProject / defaultSlug', () => {
  it('falls back to the dir basename outside a git repo', () => {
    const d = mkdtempSync(join(tmpdir(), 'share-proj-'));
    expect(detectProject(d)).toBe(expectedProject(d));
  });

  it('builds <project>-<feature>-<6hex> and drops a redundant leading plan-', () => {
    const d = mkdtempSync(join(tmpdir(), 'projx-'));
    const slug = defaultSlug('/somewhere/plan-fleet-cockpit.html', d);
    expect(slug).toMatch(/-fleet-cockpit-[0-9a-f]{6}$/);
    expect(slug).not.toContain('plan-fleet-cockpit');
    expect(slug.startsWith(expectedProject(d) + '-')).toBe(true);
  });

  it('two publishes of the same file get distinct (hashed) slugs', () => {
    const d = mkdtempSync(join(tmpdir(), 'projy-'));
    expect(defaultSlug('/x/report.html', d)).not.toBe(defaultSlug('/x/report.html', d));
  });
});

describe('parseExpire', () => {
  it('turns a relative window into a future ISO timestamp', () => {
    const iso = parseExpire('30d')!;
    const ms = Date.parse(iso) - Date.now();
    // ~30 days, allow a minute of slack
    expect(ms).toBeGreaterThan(29.9 * 864e5);
    expect(ms).toBeLessThan(30.1 * 864e5);
  });

  it('supports h / m / w units', () => {
    expect(Date.parse(parseExpire('12h')!) - Date.now()).toBeGreaterThan(11.9 * 36e5);
    expect(Date.parse(parseExpire('2w')!) - Date.now()).toBeGreaterThan(13.9 * 864e5);
  });

  it('accepts an absolute date', () => {
    expect(parseExpire('2030-01-01')).toBe(new Date('2030-01-01').toISOString());
  });

  it('is undefined when unset, throws on garbage', () => {
    expect(parseExpire(undefined)).toBeUndefined();
    expect(() => parseExpire('soon-ish')).toThrow(/Bad --expire/);
  });
});

describe('slugify', () => {
  it('derives a clean slug from a filename', () => {
    expect(slugify('/tmp/agents-1.20.65-scale.html')).toBe('agents-1-20-65-scale');
    expect(slugify('Plan Draft (v2).HTML')).toBe('plan-draft-v2');
  });
  it('never yields an empty slug', () => {
    expect(slugify('.....')).toBe('page');
  });
});

describe('renderWorkerScript', () => {
  const src = renderWorkerScript();
  it('gates writes on the WRITE_TOKEN and serves reads publicly', () => {
    expect(src).toContain('env.WRITE_TOKEN');
    expect(src).toContain("request.method === 'PUT'");
    expect(src).toContain("request.method === 'GET'");
    expect(src).toContain('env.BUCKET.put');
    expect(src).toContain('env.BUCKET.get');
  });
  it('enforces expiry with a 410 + lazy delete', () => {
    expect(src).toContain('410');
    expect(src).toContain('env.BUCKET.delete');
    expect(src).toContain("'expires-at'");
    expect(src).toContain('Date.parse(expiresAt)');
  });
  it('is a module Worker (default export fetch)', () => {
    expect(src).toContain('export default');
    expect(src).toContain('async fetch(request, env)');
  });

  it('stores expires-at metadata and returns 410 after expiry', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
      const worker = await import(
        `data:text/javascript;base64,${Buffer.from(src).toString('base64')}#${Date.now()}`
      );
      const store = new Map<string, {
        body: BodyInit | null;
        httpMetadata: { contentType?: string };
        customMetadata: Record<string, string>;
      }>();
      const env = {
        WRITE_TOKEN: 'secret',
        BUCKET: {
          put: async (key: string, body: BodyInit | null, opts: {
            httpMetadata?: { contentType?: string };
            customMetadata?: Record<string, string>;
          }) => {
            store.set(key, {
              body,
              httpMetadata: opts.httpMetadata ?? {},
              customMetadata: opts.customMetadata ?? {},
            });
          },
          get: async (key: string) => {
            const item = store.get(key);
            if (!item) return null;
            return {
              body: item.body,
              customMetadata: item.customMetadata,
              httpEtag: '"etag"',
              writeHttpMetadata(headers: Headers) {
                if (item.httpMetadata.contentType) headers.set('content-type', item.httpMetadata.contentType);
              },
            };
          },
          delete: async (key: string) => {
            store.delete(key);
          },
        },
      };

      const put = await worker.default.fetch(new Request('https://share.test/page', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'text/html; charset=utf-8',
          'x-share-expires-at': '2026-07-22T00:00:01.000Z',
        },
        body: '<h1>hello</h1>',
      }), env);
      expect(put.status).toBe(200);
      expect(store.get('page')?.customMetadata).toEqual({ 'expires-at': '2026-07-22T00:00:01.000Z' });

      vi.setSystemTime(new Date('2026-07-22T00:00:02.000Z'));
      const get = await worker.default.fetch(new Request('https://share.test/page'), env);
      expect(get.status).toBe(410);
      expect(await get.text()).toContain('expired');
      expect(store.has('page')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
