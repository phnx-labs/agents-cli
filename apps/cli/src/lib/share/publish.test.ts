import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parseExpire,
  slugify,
  detectProject,
  defaultSlug,
  attachOgCover,
  publishFile,
  publishToEndpoint,
  buildShareKey,
} from './publish.js';
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

describe('publishFile', () => {
  it('publishes the rendered file under the GitHub username namespace and returns the link for hooks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-publish-'));
    const file = join(dir, 'plan-render-output.html');
    writeFileSync(file, '<!doctype html><title>Plan</title>', 'utf-8');
    const uploads: Array<{ url: string; body: string; headers: Record<string, string> }> = [];

    const result = await publishFile(file, {
      slug: 'plan-render-output',
      githubUser: 'octocat',
      expire: '2030-01-01',
      cover: false,
      config: {
        baseUrl: 'https://share.example',
        accountId: 'acct',
        workerName: 'worker',
        bucketName: 'bucket',
      },
      writeToken: 'token',
      uploader: async (url, body, headers) => {
        uploads.push({ url, body: body.toString('utf8'), headers });
        return { ok: true, status: 200, url };
      },
    });

    expect(result).toEqual({
      url: 'https://share.example/octocat/plan-render-output',
      expiresAt: '2030-01-01T00:00:00.000Z',
      coverUrl: undefined,
    });
    expect(uploads).toEqual([
      {
        url: 'https://share.example/octocat/plan-render-output',
        body: '<!doctype html><title>Plan</title>',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'text/html; charset=utf-8',
          'x-share-expires-at': '2030-01-01T00:00:00.000Z',
        },
      },
    ]);
  });
});

describe('publishToEndpoint', () => {
  it('PUTs the HTML body to <base>/<user>/<slug> with bearer auth, expiry, and content type', async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-publish-')), 'plan.html');
    writeFileSync(htmlPath, '<!doctype html><title>Plan</title><main>done</main>');

    let seen: {
      method?: string;
      url?: string;
      authorization?: string;
      contentType?: string;
      expiresAt?: string;
      body?: string;
    } = {};

    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        seen = {
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          contentType: req.headers['content-type'],
          expiresAt: req.headers['x-share-expires-at'],
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.writeHead(201).end('ok');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const result = await publishToEndpoint(
        htmlPath,
        { baseUrl: `${baseUrl}/`, token: 'secret-token' },
        { slug: '/ticket-plan', githubUser: 'octocat', expire: '2030-01-01', cover: false },
      );

      expect(result.url).toBe(`${baseUrl}/octocat/ticket-plan`);
      expect(result.expiresAt).toBe(new Date('2030-01-01').toISOString());
      expect(seen).toEqual({
        method: 'PUT',
        url: '/octocat/ticket-plan',
        authorization: 'Bearer secret-token',
        contentType: 'text/html; charset=utf-8',
        expiresAt: new Date('2030-01-01').toISOString(),
        body: '<!doctype html><title>Plan</title><main>done</main>',
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('injects the analytics beacon when a token is provided', async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-analytics-')), 'plan.html');
    writeFileSync(htmlPath, '<!doctype html><html><head></head><body>hi</body></html>');
    let body = '';

    await publishToEndpoint(
      htmlPath,
      { baseUrl: 'https://share.example', token: 'secret-token' },
      {
        slug: 'tracked',
        githubUser: 'octocat',
        cover: false,
        analyticsToken: 'cf-token-xyz',
        uploader: async (_url, b) => {
          body = b.toString('utf8');
          return { ok: true, status: 200 };
        },
      },
    );

    expect(body).toContain('static.cloudflareinsights.com/beacon.min.js');
    expect(body).toContain('data-cf-beacon=');
    expect(body).toContain('cf-token-xyz');
  });

  it('skips analytics when --no-analytics is set even if a token is configured', async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-no-analytics-')), 'plan.html');
    writeFileSync(htmlPath, '<!doctype html><html><head></head><body>hi</body></html>');
    let body = '';

    await publishToEndpoint(
      htmlPath,
      { baseUrl: 'https://share.example', token: 'secret-token' },
      {
        slug: 'private',
        githubUser: 'octocat',
        cover: false,
        analyticsToken: 'cf-token-xyz',
        analytics: false,
        uploader: async (_url, b) => {
          body = b.toString('utf8');
          return { ok: true, status: 200 };
        },
      },
    );

    expect(body).not.toContain('cloudflareinsights.com');
  });

  it('throws with the failed status when the endpoint rejects the publish', async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-reject-')), 'plan.html');
    writeFileSync(htmlPath, '<h1>nope</h1>');
    await expect(
      publishToEndpoint(
        htmlPath,
        { baseUrl: 'https://share.example.test', token: 'secret-token' },
        {
          slug: 'denied',
          githubUser: 'octocat',
          cover: false,
          uploader: async () => ({ ok: false, status: 403 }),
        },
      ),
    ).rejects.toThrow('Publish failed (403) for https://share.example.test/octocat/denied');
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

  it('builds <project>-<feature>-<16hex> and drops a redundant leading plan-', () => {
    const d = mkdtempSync(join(tmpdir(), 'projx-'));
    const slug = defaultSlug('/somewhere/plan-fleet-cockpit.html', d);
    // 16 hex chars = 8 random bytes = 64-bit nonce (hardened from 24-bit, RUSH-1821).
    expect(slug).toMatch(/-fleet-cockpit-[0-9a-f]{16}$/);
    expect(slug).not.toContain('plan-fleet-cockpit');
    expect(slug.startsWith(expectedProject(d) + '-')).toBe(true);
  });

  it('the random tail is a full 64-bit (16 hex char) nonce, not the old 24-bit one', () => {
    const d = mkdtempSync(join(tmpdir(), 'projn-'));
    const tail = defaultSlug('/x/report.html', d).split('-').pop()!;
    expect(tail).toMatch(/^[0-9a-f]{16}$/);
    expect(tail).toHaveLength(16);
  });

  it('two publishes of the same file get distinct (hashed) slugs', () => {
    const d = mkdtempSync(join(tmpdir(), 'projy-'));
    expect(defaultSlug('/x/report.html', d)).not.toBe(defaultSlug('/x/report.html', d));
  });
});

describe('buildShareKey', () => {
  it('prefixes the slug with the sanitized GitHub username', () => {
    expect(buildShareKey('octocat', 'my-game')).toBe('octocat/my-game');
  });

  it('sanitizes both parts and collapses slashes in the slug', () => {
    expect(buildShareKey('Octo Cat', 'foo/bar baz')).toBe('octo-cat/foo-bar-baz');
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

  it('supports per-user namespaces and renders a gallery at /<user>', async () => {
    const worker = await import(
      `data:text/javascript;base64,${Buffer.from(src).toString('base64')}#${Date.now()}`
    );
    const store = new Map<string, {
      body: BodyInit | null;
      httpMetadata: { contentType?: string };
      customMetadata: Record<string, string>;
      uploaded: string;
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
            uploaded: new Date().toISOString(),
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
        list: async (opts: { prefix?: string; limit?: number }) => {
          const objects = Array.from(store.entries())
            .filter(([k]) => !opts.prefix || k.startsWith(opts.prefix))
            .map(([key, value]) => ({
              key,
              uploaded: value.uploaded,
              httpMetadata: value.httpMetadata,
              customMetadata: value.customMetadata,
              size: 0,
            }));
          return { objects: opts.limit ? objects.slice(0, opts.limit) : objects };
        },
      },
    };

    const put1 = await worker.default.fetch(new Request('https://share.test/octocat/game-one', {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/html; charset=utf-8' },
      body: '<h1>game one</h1>',
    }), env);
    expect(put1.status).toBe(200);

    const put2 = await worker.default.fetch(new Request('https://share.test/octocat/game-two', {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/html; charset=utf-8' },
      body: '<h1>game two</h1>',
    }), env);
    expect(put2.status).toBe(200);

    const gallery = await worker.default.fetch(new Request('https://share.test/octocat'), env);
    expect(gallery.status).toBe(200);
    const galleryHtml = await gallery.text();
    expect(galleryHtml).toContain('@octocat');
    expect(galleryHtml).toContain('/octocat/game-one');
    expect(galleryHtml).toContain('/octocat/game-two');

    const get = await worker.default.fetch(new Request('https://share.test/octocat/game-one'), env);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('game one');
  });

  it('paginates gallery listings and skips expired shares', async () => {
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
        uploaded: string;
      }>([
        ['octocat/live-one', { body: '<h1>one</h1>', httpMetadata: {}, customMetadata: {}, uploaded: '2026-07-22T00:00:00.000Z' }],
        ['octocat/live-two', { body: '<h1>two</h1>', httpMetadata: {}, customMetadata: {}, uploaded: '2026-07-22T00:00:00.000Z' }],
        ['octocat/expired', { body: '<h1>old</h1>', httpMetadata: {}, customMetadata: { 'expires-at': '2026-07-21T00:00:00.000Z' }, uploaded: '2026-07-21T00:00:00.000Z' }],
        ['octocat/live-one.png', { body: 'png', httpMetadata: {}, customMetadata: {}, uploaded: '2026-07-22T00:00:00.000Z' }],
      ]);
      const listCalls: Array<{ prefix?: string; limit?: number; cursor?: string; include?: string[] }> = [];
      const env = {
        WRITE_TOKEN: 'secret',
        BUCKET: {
          put: async () => {},
          get: async () => null,
          delete: async () => {},
          list: async (opts: { prefix?: string; limit?: number; cursor?: string; include?: string[] }) => {
            listCalls.push(opts);
            const all = Array.from(store.entries())
              .filter(([k]) => !opts.prefix || k.startsWith(opts.prefix))
              .map(([key, value]) => ({
                key,
                uploaded: value.uploaded,
                httpMetadata: value.httpMetadata,
                customMetadata: opts.include?.includes('customMetadata') ? value.customMetadata : undefined,
                size: 0,
              }));
            const start = opts.cursor ? Number(opts.cursor) : 0;
            const pageSize = opts.limit === 1 ? 1 : 2;
            const page = all.slice(start, start + pageSize);
            const next = start + pageSize;
            return { objects: page, truncated: next < all.length, cursor: String(next) };
          },
        },
      };

      const gallery = await worker.default.fetch(new Request('https://share.test/octocat'), env);
      expect(gallery.status).toBe(200);
      const galleryHtml = await gallery.text();
      expect(galleryHtml).toContain('/octocat/live-one');
      expect(galleryHtml).toContain('/octocat/live-two');
      expect(galleryHtml).not.toContain('/octocat/expired');
      expect(galleryHtml).not.toContain('/octocat/live-one.png');
      expect(listCalls.filter((call) => call.include?.includes('customMetadata')).length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still resolves legacy flat slugs for backward compatibility', async () => {
    const worker = await import(
      `data:text/javascript;base64,${Buffer.from(src).toString('base64')}#${Date.now()}`
    );
    const store = new Map<string, {
      body: BodyInit | null;
      httpMetadata: { contentType?: string };
      customMetadata: Record<string, string>;
      uploaded: string;
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
            uploaded: new Date().toISOString(),
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
        list: async () => ({ objects: [] }),
      },
    };

    const put = await worker.default.fetch(new Request('https://share.test/legacy-flat-slug', {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/html; charset=utf-8' },
      body: '<h1>legacy</h1>',
    }), env);
    expect(put.status).toBe(200);

    const get = await worker.default.fetch(new Request('https://share.test/legacy-flat-slug'), env);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('legacy');
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
        uploaded: string;
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
              uploaded: new Date().toISOString(),
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
          list: async () => ({ objects: [] }),
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
