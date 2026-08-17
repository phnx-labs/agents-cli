import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parseExpire,
  resolveExpire,
  DEFAULT_SHARE_EXPIRE,
  scanShareContent,
  formatSensitiveContentError,
  slugify,
  detectProject,
  defaultSlug,
  attachOgCover,
  publishFile,
  publishToEndpoint,
  buildShareKey,
  resolveShareProvenance,
  parseMetaEntries,
  assertMetadataSize,
  deriveLabel,
  sanitizeLabel,
  toHeaderValue,
  redactEmails,
  RESERVED_META_KEYS,
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
      // Suppress auto-captured provenance (agent/session/host/repo/date) so the
      // test is deterministic regardless of the ambient env it runs in.
      provenance: {},
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
      label: 'Plan',
      labelSource: 'derived',
    });
    expect(uploads).toEqual([
      {
        url: 'https://share.example/octocat/plan-render-output',
        body: '<!doctype html><title>Plan</title>',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'text/html; charset=utf-8',
          'x-share-expires-at': '2030-01-01T00:00:00.000Z',
          'x-share-label': 'Plan',
          'x-share-label-source': 'derived',
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

  it('serves static media with a real content-type so it renders inline (not octet-stream)', async () => {
    // GitHub's camo image proxy only renders an inline `![](url)` when the asset is
    // served with an image/video content-type; octet-stream is refused. Screenshots
    // and recordings uploaded as PR evidence must therefore carry the right type.
    const dir = mkdtempSync(join(tmpdir(), 'agents-share-media-'));
    const cases: Array<[string, string]> = [
      ['shot.png', 'image/png'],
      ['before.jpg', 'image/jpeg'],
      ['flow.gif', 'image/gif'],
      ['ui.webp', 'image/webp'],
      ['demo.mp4', 'video/mp4'],
      ['capture.mov', 'video/quicktime'],
    ];
    for (const [name, expected] of cases) {
      const filePath = join(dir, name);
      writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02]));
      let contentType = '';
      await publishToEndpoint(
        filePath,
        { baseUrl: 'https://share.example', token: 'secret-token' },
        {
          slug: 'media',
          githubUser: 'octocat',
          cover: false,
          uploader: async (_url, _body, headers) => {
            contentType = headers['content-type'];
            return { ok: true, status: 200 };
          },
        },
      );
      expect(contentType, name).toBe(expected);
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

  it('defaults an omitted --expire to 30d and sends x-share-expires-at (RUSH-2443)', async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-def-exp-')), 'plan.html');
    writeFileSync(htmlPath, '<h1>ok</h1>');
    let expiresHeader = '';
    const result = await publishToEndpoint(
      htmlPath,
      { baseUrl: 'https://share.example', token: 'tok' },
      {
        slug: 'def-exp',
        githubUser: 'octocat',
        cover: false,
        uploader: async (_u, _b, headers) => {
          expiresHeader = headers['x-share-expires-at'] ?? '';
          return { ok: true, status: 200 };
        },
      },
    );
    expect(expiresHeader).toBeTruthy();
    expect(result.expiresAt).toBe(expiresHeader);
    const ms = Date.parse(expiresHeader) - Date.now();
    expect(ms).toBeGreaterThan(29.9 * 864e5);
    expect(ms).toBeLessThan(30.1 * 864e5);
  });

  it("--expire never omits the expiry header (permanent share)", async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-never-')), 'plan.html');
    writeFileSync(htmlPath, '<h1>ok</h1>');
    let headersSeen: Record<string, string> = {};
    const result = await publishToEndpoint(
      htmlPath,
      { baseUrl: 'https://share.example', token: 'tok' },
      {
        slug: 'forever',
        githubUser: 'octocat',
        expire: 'never',
        cover: false,
        uploader: async (_u, _b, headers) => {
          headersSeen = headers;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(headersSeen['x-share-expires-at']).toBeUndefined();
    expect(result.expiresAt).toBeUndefined();
  });

  it('sends x-share-visibility: unlisted when --unlisted is set', async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-unlisted-')), 'plan.html');
    writeFileSync(htmlPath, '<h1>ok</h1>');
    let visibility = '';
    const result = await publishToEndpoint(
      htmlPath,
      { baseUrl: 'https://share.example', token: 'tok' },
      {
        slug: 'hidden',
        githubUser: 'octocat',
        expire: 'never',
        unlisted: true,
        cover: false,
        uploader: async (_u, _b, headers) => {
          visibility = headers['x-share-visibility'] ?? '';
          return { ok: true, status: 200 };
        },
      },
    );
    expect(visibility).toBe('unlisted');
    expect(result.unlisted).toBe(true);
  });

  it('refuses a page with emails unless --force (RUSH-2443 / RUSH-2428)', async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-scan-')), 'report.html');
    writeFileSync(htmlPath, '<h1>Spend</h1><p>alice@example.com spent $12</p>');
    let uploads = 0;
    await expect(
      publishToEndpoint(
        htmlPath,
        { baseUrl: 'https://share.example', token: 'tok' },
        {
          slug: 'spend',
          githubUser: 'octocat',
          cover: false,
          uploader: async () => {
            uploads++;
            return { ok: true, status: 200 };
          },
        },
      ),
    ).rejects.toThrow(/Refusing to publish.*email/);
    expect(uploads).toBe(0);

    // --force bypasses the gate.
    const ok = await publishToEndpoint(
      htmlPath,
      { baseUrl: 'https://share.example', token: 'tok' },
      {
        slug: 'spend',
        githubUser: 'octocat',
        cover: false,
        force: true,
        uploader: async () => {
          uploads++;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(ok.url).toContain('/spend');
    expect(uploads).toBe(1);
  });

  it('refuses a credential in --meta unless --force, even when the file body is clean (RUSH-2683 review fix)', async () => {
    // --label and --meta land in PUBLIC customMetadata (visible in the
    // gallery, `share list --json`, `share revisions`) exactly like the file
    // body — the pre-publish scan previously ran on the body only, so a
    // credential-shaped --meta value or --label sailed straight through with
    // no --force gate at all.
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-scan-meta-')), 'report.html');
    writeFileSync(htmlPath, '<h1>Clean body, no secrets here</h1>');
    let uploads = 0;
    await expect(
      publishToEndpoint(
        htmlPath,
        { baseUrl: 'https://share.example', token: 'tok' },
        {
          slug: 'meta-secret',
          githubUser: 'octocat',
          cover: false,
          meta: { note: 'AKIAABCDEFGHIJKLMNOP' },
          uploader: async () => {
            uploads++;
            return { ok: true, status: 200 };
          },
        },
      ),
    ).rejects.toThrow(/Refusing to publish.*credential/);
    expect(uploads).toBe(0);

    // --force bypasses this gate too.
    const ok = await publishToEndpoint(
      htmlPath,
      { baseUrl: 'https://share.example', token: 'tok' },
      {
        slug: 'meta-secret',
        githubUser: 'octocat',
        cover: false,
        force: true,
        meta: { note: 'AKIAABCDEFGHIJKLMNOP' },
        uploader: async () => {
          uploads++;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(ok.url).toContain('/meta-secret');
    expect(uploads).toBe(1);
  });

  it('refuses an email in an explicit --label unless --force (RUSH-2683 review fix)', async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-scan-label-')), 'report.html');
    writeFileSync(htmlPath, '<h1>Clean body</h1>');
    let uploads = 0;
    await expect(
      publishToEndpoint(
        htmlPath,
        { baseUrl: 'https://share.example', token: 'tok' },
        {
          slug: 'label-secret',
          githubUser: 'octocat',
          cover: false,
          label: 'contact: alice@example.com',
          uploader: async () => {
            uploads++;
            return { ok: true, status: 200 };
          },
        },
      ),
    ).rejects.toThrow(/Refusing to publish.*email/);
    expect(uploads).toBe(0);
  });
});

describe('resolveShareProvenance (RUSH-2683)', () => {
  it('reads session/agent from env, host from the override, repo from git', () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'share-prov-git-'));
    initGitRepo(gitDir);
    const p = resolveShareProvenance({
      env: { AGENTS_SESSION_ID: 'sess-1', AGENTS_AGENT_NAME: 'claude' } as NodeJS.ProcessEnv,
      hostname: 'zion',
      dir: gitDir,
      now: new Date('2026-08-14T12:00:00.000Z'),
    });
    expect(p.session).toBe('sess-1');
    expect(p.agent).toBe('claude');
    expect(p.host).toBe('zion');
    expect(p.repo).toBe(basename(gitDir).toLowerCase());
    expect(p.date).toBe('2026-08-14');
  });

  it('falls back to AGENT_SESSION_ID when AGENTS_SESSION_ID is unset', () => {
    const p = resolveShareProvenance({ env: { AGENT_SESSION_ID: 'sess-legacy' } as NodeJS.ProcessEnv, dir: mkdtempSync(join(tmpdir(), 'share-prov-')) });
    expect(p.session).toBe('sess-legacy');
  });

  it('leaves session/agent/repo undefined outside an agent run and outside git — never invented', () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-prov-nogit-'));
    const p = resolveShareProvenance({ env: {} as NodeJS.ProcessEnv, dir });
    expect(p.session).toBeUndefined();
    expect(p.agent).toBeUndefined();
    expect(p.repo).toBeUndefined();
    // host and date are always present — real facts about where/when the publish ran.
    expect(p.host).toBeTruthy();
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('parseMetaEntries (RUSH-2683)', () => {
  it('parses valid key=value pairs', () => {
    expect(parseMetaEntries(['kind=plan', 'ticket=RUSH-2683'])).toEqual({ kind: 'plan', ticket: 'RUSH-2683' });
  });

  it('allows = inside the value', () => {
    expect(parseMetaEntries(['query=a=b=c'])).toEqual({ query: 'a=b=c' });
  });

  it('rejects a pair with no =', () => {
    expect(() => parseMetaEntries(['kindplan'])).toThrow(/Bad --meta/);
  });

  it('rejects an uppercase or symbol-bearing key', () => {
    expect(() => parseMetaEntries(['Kind=plan'])).toThrow(/lowercase/);
    expect(() => parseMetaEntries(['kind.x=plan'])).toThrow(/lowercase/);
  });

  it('rejects every reserved key', () => {
    for (const key of RESERVED_META_KEYS) {
      expect(() => parseMetaEntries([`${key}=x`]), key).toThrow(/reserved/);
    }
  });
});

describe('assertMetadataSize (RUSH-2683)', () => {
  it('accepts a small payload', () => {
    expect(() => assertMetadataSize({ label: 'Q3 report', agent: 'claude' })).not.toThrow();
  });

  it('refuses a payload over the 2KB cap', () => {
    expect(() => assertMetadataSize({ blob: 'x'.repeat(3000) })).toThrow(/over the 2048-byte cap/);
  });
});

describe('deriveLabel (RUSH-2683)', () => {
  it('prefers the HTML <title>', () => {
    expect(deriveLabel('/tmp/plan.html', Buffer.from('<html><head><title>Fleet Plan</title></head></html>'))).toBe('Fleet Plan');
  });

  it('falls back to a Markdown frontmatter title', () => {
    const body = Buffer.from('---\ntitle: Q3 Report\nkind: plan\n---\n# body\n');
    expect(deriveLabel('/tmp/report.md', body)).toBe('Q3 Report');
  });

  it('falls back to the filename when neither is present', () => {
    expect(deriveLabel('/tmp/fleet-status-report.html', Buffer.from('<h1>no title tag</h1>'))).toBe('fleet status report');
  });

  it('never throws or blocks on an empty file', () => {
    expect(deriveLabel('/tmp/empty.html', Buffer.alloc(0))).toBe('empty.html'.replace(/\.[^.]+$/, ''));
  });

  it('collapses a multi-line <title> to a single line (RUSH-2683 review fix)', () => {
    // `[^<]{1,200}` in the <title> regex matches newlines, and .trim() only
    // strips leading/trailing whitespace — a multi-line title used to reach
    // Headers.set() as-is, which throws an unhandled TypeError and crashes
    // the whole publish. deriveLabel must return a single-line string.
    const html = '<html><head><title>Fleet\nStatus\n  Report</title></head></html>';
    const label = deriveLabel('/tmp/plan.html', Buffer.from(html));
    expect(label).toBe('Fleet Status Report');
    expect(label).not.toMatch(/\n/);
    expect(() => new Headers({ 'x-share-label': label })).not.toThrow();
  });
});

describe('sanitizeLabel (RUSH-2683 review fix)', () => {
  it('collapses embedded newlines and internal runs of whitespace to a single space', () => {
    expect(sanitizeLabel('Fleet\nStatus\tReport')).toBe('Fleet Status Report');
  });

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeLabel('  Q3 Report  ')).toBe('Q3 Report');
  });

  it('is a no-op on an already-clean single-line label', () => {
    expect(sanitizeLabel('Fleet Plan')).toBe('Fleet Plan');
  });
});

describe('publishToEndpoint provenance / label / meta / revision headers (RUSH-2683)', () => {
  it('sends provenance, an explicit label, and --meta as x-share-* headers', async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-prov-')), 'plan.html');
    writeFileSync(htmlPath, '<h1>ok</h1>');
    let headersSeen: Record<string, string> = {};
    const result = await publishToEndpoint(
      htmlPath,
      { baseUrl: 'https://share.example', token: 'tok' },
      {
        slug: 'prov',
        githubUser: 'octocat',
        cover: false,
        label: 'Fleet Plan',
        meta: { kind: 'plan', ticket: 'RUSH-2683' },
        provenance: { agent: 'claude', session: 'sess-1', host: 'zion', repo: 'agents-cli', date: '2026-08-14' },
        uploader: async (_u, _b, headers) => {
          headersSeen = headers;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(headersSeen['x-share-agent']).toBe('claude');
    expect(headersSeen['x-share-session']).toBe('sess-1');
    expect(headersSeen['x-share-host']).toBe('zion');
    expect(headersSeen['x-share-repo']).toBe('agents-cli');
    expect(headersSeen['x-share-date']).toBe('2026-08-14');
    expect(headersSeen['x-share-label']).toBe('Fleet Plan');
    expect(headersSeen['x-share-label-source']).toBe('explicit');
    expect(JSON.parse(headersSeen['x-share-meta'])).toEqual({ kind: 'plan', ticket: 'RUSH-2683' });
    expect(result.label).toBe('Fleet Plan');
    expect(result.labelSource).toBe('explicit');
  });

  it('sanitizes an explicit --label with an embedded newline instead of crashing on Headers.set() (RUSH-2683 review fix)', async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-label-newline-')), 'x.html');
    writeFileSync(htmlPath, '<h1>ok</h1>');
    let headersSeen: Record<string, string> = {};
    const result = await publishToEndpoint(
      htmlPath,
      { baseUrl: 'https://share.example', token: 'tok' },
      {
        slug: 'label-newline',
        githubUser: 'octocat',
        cover: false,
        label: 'Fleet\nStatus Report',
        provenance: {},
        uploader: async (_u, _b, headers) => {
          headersSeen = headers;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(headersSeen['x-share-label']).toBe('Fleet Status Report');
    expect(result.label).toBe('Fleet Status Report');
  });

  it('derives a label and marks it derived when --label is omitted', async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-derived-')), 'x.html');
    writeFileSync(htmlPath, '<html><head><title>Auto Title</title></head></html>');
    let headersSeen: Record<string, string> = {};
    const result = await publishToEndpoint(
      htmlPath,
      { baseUrl: 'https://share.example', token: 'tok' },
      {
        slug: 'derived',
        githubUser: 'octocat',
        cover: false,
        provenance: {},
        uploader: async (_u, _b, headers) => {
          headersSeen = headers;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(headersSeen['x-share-label']).toBe('Auto Title');
    expect(headersSeen['x-share-label-source']).toBe('derived');
    expect(result.labelSource).toBe('derived');
  });

  it('sends x-share-no-revision when --no-revision is set', async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-norev-')), 'x.html');
    writeFileSync(htmlPath, '<h1>ok</h1>');
    let headersSeen: Record<string, string> = {};
    await publishToEndpoint(
      htmlPath,
      { baseUrl: 'https://share.example', token: 'tok' },
      {
        slug: 'norev',
        githubUser: 'octocat',
        cover: false,
        noRevision: true,
        provenance: {},
        uploader: async (_u, _b, headers) => {
          headersSeen = headers;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(headersSeen['x-share-no-revision']).toBe('1');
  });

  it('refuses a publish whose combined metadata exceeds the size cap, before any upload', async () => {
    const htmlPath = join(mkdtempSync(join(tmpdir(), 'agents-share-bigmeta-')), 'x.html');
    writeFileSync(htmlPath, '<h1>ok</h1>');
    let uploads = 0;
    await expect(
      publishToEndpoint(
        htmlPath,
        { baseUrl: 'https://share.example', token: 'tok' },
        {
          slug: 'bigmeta',
          githubUser: 'octocat',
          cover: false,
          provenance: {},
          meta: { blob: 'x'.repeat(3000) },
          uploader: async () => {
            uploads++;
            return { ok: true, status: 200 };
          },
        },
      ),
    ).rejects.toThrow(/over the 2048-byte cap/);
    expect(uploads).toBe(0);
  });
});

function initGitRepo(dir: string): void {
  // detectProject/gitRepoName shell out to `git rev-parse --show-toplevel`; make
  // the temp dir a real (if trivial) git repo so that path is exercised for real
  // rather than mocked.
  execFileSync('git', ['-C', dir, 'init', '-q']);
}

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

describe('resolveExpire (RUSH-2443 default + never)', () => {
  it(`defaults omitted --expire to ${DEFAULT_SHARE_EXPIRE}`, () => {
    const iso = resolveExpire(undefined)!;
    const ms = Date.parse(iso) - Date.now();
    expect(ms).toBeGreaterThan(29.9 * 864e5);
    expect(ms).toBeLessThan(30.1 * 864e5);
  });

  it("treats 'never' / 'none' / 'permanent' as no expiry", () => {
    expect(resolveExpire('never')).toBeUndefined();
    expect(resolveExpire('none')).toBeUndefined();
    expect(resolveExpire('permanent')).toBeUndefined();
    expect(resolveExpire('  NEVER  ')).toBeUndefined();
  });

  it('still parses relative and absolute specs', () => {
    expect(Date.parse(resolveExpire('12h')!) - Date.now()).toBeGreaterThan(11.9 * 36e5);
    expect(resolveExpire('2030-01-01')).toBe(new Date('2030-01-01').toISOString());
  });
});

describe('scanShareContent (RUSH-2443 pre-publish gate)', () => {
  it('flags email addresses', () => {
    const hits = scanShareContent('Contact alice@example.com and bob@corp.io');
    expect(hits.some((h) => h.kind === 'email')).toBe(true);
  });

  it('flags credential-shaped strings (ghp_, sk-, AKIA, Bearer)', () => {
    const hits = scanShareContent(
      [
        'token ghp_abcdefghijklmnopqrstuvwxyz012345',
        'key sk-ant-api03-abcdefghijklmnopqrst',
        'aws AKIAIOSFODNN7EXAMPLE',
        'auth Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xx',
      ].join('\n'),
    );
    expect(hits.some((h) => h.kind === 'credential')).toBe(true);
  });

  it('returns nothing for a clean HTML page', () => {
    expect(scanShareContent('<!doctype html><title>Plan</title><main>ok</main>')).toEqual([]);
  });

  it('skips binary bodies (null bytes in the head)', () => {
    const pngish = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
    expect(scanShareContent(pngish)).toEqual([]);
  });

  it('formatSensitiveContentError names the kinds and points at --force / --unlisted', () => {
    const msg = formatSensitiveContentError([
      { kind: 'email', sample: 'alice…' },
      { kind: 'credential', sample: 'ghp_…' },
    ]);
    expect(msg).toMatch(/email addresses and credential-shaped strings/);
    expect(msg).toMatch(/--force/);
    expect(msg).toMatch(/--unlisted/);
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

describe('toHeaderValue', () => {
  it('keeps ordinary text untouched', () => {
    expect(toHeaderValue('Q3 fleet plan')).toBe('Q3 fleet plan');
  });

  it('transliterates the punctuation that actually reaches a header', () => {
    expect(toHeaderValue('the "plan" — it’s done…')).toBe('the "plan" - it\'s done...');
  });

  it('produces a value fetch can encode, for every input that used to crash', () => {
    // fetch encodes header values as a ByteString: any code point > 255 throws
    // `TypeError: Cannot convert argument to a ByteString`. Publishing a session
    // whose title ended in U+2026 hit exactly this, mid-upload.
    for (const input of ['title ending in …', 'ship it \u{1F680}', '会話の記録', 'Malmö café']) {
      const value = toHeaderValue(input);
      expect(() => new Headers({ 'x-share-label': value })).not.toThrow();
      expect([...value].every((ch) => ch.codePointAt(0)! <= 255)).toBe(true);
    }
  });

  it('degrades a value that HAD content and lost it all to a marker', () => {
    expect(toHeaderValue('会話の記録')).toBe('(unnamed)');
  });

  it('leaves an empty value empty — `--meta note=` means empty, not unnamed', () => {
    expect(toHeaderValue('')).toBe('');
    expect(toHeaderValue('   ')).toBe('');
  });

  it('keeps latin1 accents, which headers can carry', () => {
    expect(toHeaderValue('Malmö café')).toBe('Malmö café');
  });
});

describe('x-share-meta survives a value the header folder rewrites', () => {
  it('transliterates each value before JSON.stringify, so the Worker can still parse it', async () => {
    // Folding the SERIALIZED json rewrote a curly quote inside a value into a bare
    // `"`, which is structural in JSON. The Worker swallows the parse error, so
    // every --meta key vanished silently on a 200 — worse than the loud throw the
    // ByteString fix replaced.
    const dir = mkdtempSync(join(tmpdir(), 'share-meta-'));
    const file = join(dir, 'page.html');
    writeFileSync(file, '<html><head><title>t</title></head><body>ok</body></html>');
    const sent: Record<string, string>[] = [];
    await publishToEndpoint(file, { baseUrl: 'https://share.example', token: 't' }, {
      slug: 'meta-page',
      githubUser: 'octocat',
      cover: false,
      analytics: false,
      meta: { note: 'the “plan” is done', who: 'it’s me' },
      uploader: async (url, _b, headers) => { sent.push(headers); return { ok: true, status: 200, url }; },
    });
    const header = sent[0]['x-share-meta'];
    expect(() => JSON.parse(header)).not.toThrow();
    expect(JSON.parse(header)).toEqual({ note: 'the "plan" is done', who: "it's me" });
    expect([...header].every((ch) => ch.codePointAt(0)! <= 255)).toBe(true);
  });
});

describe('redactEmails', () => {
  it('clears the very scan it sits next to — the two share one pattern by construction', () => {
    const text = 'author alice@example.com committed; ping bob.smith+tag@sub.domain.co.uk';
    const masked = redactEmails(text);
    expect(masked).toBe('author [EMAIL] committed; ping [EMAIL]');
    expect(scanShareContent(masked).filter((hit) => hit.kind === 'email')).toEqual([]);
  });

  it('drops the domain too — a personal domain identifies its owner', () => {
    expect(redactEmails('someone@their-own-domain.dev')).toBe('[EMAIL]');
  });

  it('leaves ordinary text alone', () => {
    expect(redactEmails('scoped @mentions and a@b are not addresses'))
      .toBe('scoped @mentions and a@b are not addresses');
  });
});
