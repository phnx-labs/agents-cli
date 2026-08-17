import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { publishToEndpoint, scanShareContent } from '../lib/share/publish.js';
import { redactEmails } from '../lib/redact.js';
import { renderSessionHtmlDocument } from '../lib/session/share-html.js';
import type { SessionMeta } from '../lib/session/types.js';
import { renderSessionMarkdownDocument } from './sessions-render.js';
import { buildSharePublishOptions, defaultSessionSlug } from './sessions-share.js';

const TESTDATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/session/testdata/render');

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    shortId: 'a1b2c3d4',
    agent: 'claude',
    timestamp: '2026-08-17T10:00:00.000Z',
    project: 'agents-cli',
    filePath: path.join(TESTDATA, 'claude.jsonl'),
    ...overrides,
  };
}

describe('defaultSessionSlug', () => {
  it('is stable per session, so re-sharing updates one URL instead of littering new ones', () => {
    const session = meta();
    expect(defaultSessionSlug(session)).toBe('session-a1b2c3d4');
    expect(defaultSessionSlug(session)).toBe(defaultSessionSlug({ ...session, project: 'other' }));
  });

  it('falls back to the full id when a session carries no short id', () => {
    expect(defaultSessionSlug(meta({ shortId: '' }))).toBe('session-a1b2c3d4-0000-0000-0000-000000000000');
  });
});

describe('buildSharePublishOptions', () => {
  it('is unlisted unless --public — the one default that must not silently invert', () => {
    expect(buildSharePublishOptions(meta(), {}).unlisted).toBe(true);
    expect(buildSharePublishOptions(meta(), { public: false }).unlisted).toBe(true);
    expect(buildSharePublishOptions(meta(), { public: true }).unlisted).toBe(false);
  });

  it('tags the share as a session so `artifacts share list --agent/--session` can find it', () => {
    expect(buildSharePublishOptions(meta(), {}).meta).toEqual({ kind: 'session' });
  });

  it('passes the remaining flags through without inventing values', () => {
    expect(buildSharePublishOptions(meta(), {})).toMatchObject({
      slug: 'session-a1b2c3d4',
      expire: undefined,   // publishToEndpoint applies the 30d default
      force: false,
      cover: true,
      label: undefined,
    });
    expect(buildSharePublishOptions(meta(), { slug: 'custom', label: 'Title', expire: 'never', force: true, cover: false }))
      .toMatchObject({ slug: 'custom', label: 'Title', expire: 'never', force: true, cover: false });
  });
});

describe('email masking runs on the artifact the scanner scans', () => {
  it('catches an address Markdown escaping hid from a Markdown-stage mask', () => {
    // `foo\@example.com` does not match the email pattern in Markdown (the
    // backslash breaks the local part), but marked drops the backslash, so the
    // published HTML carries a live address the publish scan then refuses.
    const markdown = 'contact foo\\@example.com for context';
    const page = renderSessionHtmlDocument(meta(), markdown);
    expect(page).toContain('foo@example.com');           // survived the Markdown stage
    expect(scanShareContent(page).some((h) => h.kind === 'email')).toBe(true);

    const masked = redactEmails(page);
    expect(masked).not.toContain('foo@example.com');
    expect(scanShareContent(masked).filter((h) => h.kind === 'email')).toEqual([]);
  });
});

/**
 * The publish path the command drives, exercised for real against the endpoint's
 * own DI seams (uploader/username) rather than a mock of it — the request that
 * would go over the wire is inspected exactly as the Worker would receive it.
 */
describe('publishing a rendered session', () => {
  function shareSession(session: SessionMeta, opts: { unlisted: boolean }) {
    const markdown = renderSessionMarkdownDocument(session);
    const html = renderSessionHtmlDocument(session, markdown);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-session-share-test-'));
    const file = path.join(dir, `${defaultSessionSlug(session)}.html`);
    fs.writeFileSync(file, html, { mode: 0o600 });
    const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    return {
      file,
      sent,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
      run: () => publishToEndpoint(file, { baseUrl: 'https://share.example', token: 't' }, {
        slug: defaultSessionSlug(session),
        unlisted: opts.unlisted,
        githubUser: 'octocat',
        cover: false,
        analytics: false,
        uploader: async (url, body, headers) => {
          sent.push({ url, headers, body });
          return { ok: true, status: 200, url };
        },
      }),
    };
  }

  it('publishes unlisted to a session-scoped URL under the user namespace', async () => {
    const harness = shareSession(meta(), { unlisted: true });
    try {
      const result = await harness.run();
      expect(result.url).toBe('https://share.example/octocat/session-a1b2c3d4');
      expect(result.unlisted).toBe(true);
      expect(harness.sent).toHaveLength(1);
      expect(harness.sent[0].headers['x-share-visibility']).toBe('unlisted');
      // Default expiry applies, so a forgotten session link decays.
      expect(result.expiresAt).toBeTruthy();
    } finally {
      harness.cleanup();
    }
  });

  it('uploads the rendered page itself, not the raw transcript', async () => {
    const harness = shareSession(meta(), { unlisted: true });
    try {
      await harness.run();
      const body = harness.sent[0].body.toString('utf8');
      expect(body.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(body).toContain('agents session');
    } finally {
      harness.cleanup();
    }
  });

  it('marks the share public only when the operator opts in', async () => {
    const harness = shareSession(meta(), { unlisted: false });
    try {
      const result = await harness.run();
      expect(result.unlisted).toBeFalsy();
      expect(harness.sent[0].headers['x-share-visibility']).toBeUndefined();
    } finally {
      harness.cleanup();
    }
  });
});
