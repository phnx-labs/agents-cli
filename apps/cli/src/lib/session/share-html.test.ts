import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { renderSessionMarkdownDocument } from '../../commands/sessions-render.js';
import { buildChips, escapeHtml, formatDuration, renderSessionHtmlDocument, sessionPageTitle } from './share-html.js';
import type { SessionMeta } from './types.js';

const TESTDATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'testdata/render');

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'share-claude-0001',
    shortId: 'a1b2c3d4',
    agent: 'claude',
    timestamp: '2026-08-17T10:00:00.000Z',
    filePath: path.join(TESTDATA, 'claude.jsonl'),
    ...overrides,
  };
}

describe('renderSessionHtmlDocument', () => {
  it('wraps a real rendered transcript in one self-contained page', () => {
    const session = meta();
    const markdown = renderSessionMarkdownDocument(session);
    const html = renderSessionHtmlDocument(session, markdown);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    // Self-contained: nothing to fetch, so the page renders from an R2 object alone.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).toContain('<style>');
    // The transcript body actually made it in.
    expect(html).toContain('<h2>Conversation</h2>');
  });

  it('neutralizes HTML a transcript merely talked about, instead of executing it', () => {
    // The bug this guards: marked passes raw HTML through by default, so a session
    // that printed a <script> tag would ship an executable one on a public URL.
    const session = meta();
    const markdown = 'A session that printed <script>alert(document.cookie)</script> and <img src=x onerror=alert(1)>.';
    const html = renderSessionHtmlDocument(session, markdown);

    const body = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
    // No live tags: the text survives verbatim, but nothing the browser executes.
    expect(body).not.toMatch(/<script\b/i);
    expect(body).not.toMatch(/<img\b/i);
    expect(body).toContain('&lt;script&gt;');
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(body).toContain('alert(document.cookie)');
  });

  it('drops a javascript: link target but keeps its text', () => {
    const html = renderSessionHtmlDocument(meta(), '[click me](javascript:alert(1))');
    const body = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
    expect(body).not.toContain('javascript:');
    expect(body).toContain('click me');
  });

  it('keeps ordinary links and code fences intact', () => {
    const html = renderSessionHtmlDocument(meta(), '[docs](https://agents-cli.sh)\n\n```bash\nls -la\n```\n');
    const body = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
    expect(body).toContain('href="https://agents-cli.sh"');
    expect(body).toContain('<pre><code class="language-bash">ls -la');
  });

  it('titles the page from the document heading so the share label derives from it', () => {
    const html = renderSessionHtmlDocument(meta(), '# Fix the retry bug\n\nbody text\n');
    expect(html).toContain('<title>Fix the retry bug</title>');
    // The heading becomes the page header, so it must not also appear in the body.
    const body = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
    expect(body).not.toContain('<h1>');
  });

  it('states redaction honestly in the footer', () => {
    expect(renderSessionHtmlDocument(meta(), 'x')).toContain('Secret-redacted transcript');
    expect(renderSessionHtmlDocument(meta(), 'x', { redacted: false })).toContain('Unredacted transcript');
  });
});

describe('buildChips', () => {
  it('shows the session facts a reader needs', () => {
    const chips = buildChips(meta({
      model: 'claude-opus-5',
      mode: 'auto',
      project: 'agents-cli',
      gitBranch: 'sessions-share',
      ticketId: 'RUSH-2784',
      durationMs: 13 * 60_000,
      messageCount: 42,
      toolCallCount: 7,
    }));
    const byLabel = Object.fromEntries(chips.map((c) => [c.label, c.value]));
    expect(byLabel).toMatchObject({
      agent: 'claude',
      model: 'claude-opus-5',
      mode: 'auto',
      project: 'agents-cli',
      branch: 'sessions-share',
      ticket: 'RUSH-2784',
      date: '2026-08-17',
      duration: '13 minutes',
      turns: '42',
      tools: '7',
    });
  });

  it('never puts the operator identity or local paths in the page chrome', () => {
    // account is an email (the publish-time scan rejects those, correctly) and cwd
    // is a local home path — neither belongs on a published page.
    const chips = buildChips(meta({
      account: 'alice@example.com',
      cwd: '/Users/alice/private',
      machine: 'zion',
    }));
    const rendered = JSON.stringify(chips);
    expect(rendered).not.toContain('alice@example.com');
    expect(rendered).not.toContain('/Users/alice');
    expect(rendered).not.toContain('zion');
  });

  it('omits a fact the session does not carry rather than inventing one', () => {
    const labels = buildChips(meta()).map((c) => c.label);
    expect(labels).toEqual(['agent', 'date']);
  });
});

describe('formatDuration', () => {
  it('reads like a human wrote it', () => {
    expect(formatDuration(20_000)).toBe('under a minute');
    expect(formatDuration(60_000)).toBe('1 minute');
    expect(formatDuration(13 * 60_000)).toBe('13 minutes');
    expect(formatDuration(2 * 3_600_000)).toBe('2 hours');
    expect(formatDuration(3 * 86_400_000)).toBe('3 days');
  });
});

describe('sessionPageTitle', () => {
  it('falls back to the session identity when the document has no heading', () => {
    expect(sessionPageTitle(meta(), 'no heading here')).toBe('claude session a1b2c3d4');
  });
});

describe('escapeHtml', () => {
  it('escapes every character that could break out of text or an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`))
      .toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});
