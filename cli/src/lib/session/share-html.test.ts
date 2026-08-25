import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { renderSessionMarkdownDocument } from '../../commands/sessions-render.js';
import { renderConversationMarkdown } from './render.js';
import { buildChips, escapeHtml, formatDuration, renderSessionHtmlDocument, sessionPageTitle } from './share-html.js';
import type { SessionEvent, SessionMeta } from './types.js';

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

  it('lets --reasoning fold actually collapse, instead of printing escaped tags', () => {
    // The exact block session/render.ts pushes on the `fold` branch. Escaping it
    // along with everything else published "&lt;details&gt;" as visible text and no
    // disclosure widget, so the documented flag shipped broken.
    const folded = '<details>\n<summary>Reasoning</summary>\n\nthe model weighed two options\n\n</details>';
    const html = renderSessionHtmlDocument(meta(), folded);
    const body = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));

    expect(body).toContain('<details>');
    expect(body).toContain('<summary>Reasoning</summary>');
    expect(body).toContain('</details>');
    expect(body).not.toContain('&lt;details&gt;');
    // The reasoning text itself still renders as ordinary Markdown inside it.
    expect(body).toContain('the model weighed two options');
  });

  it('closes the disclosure element, so a later turn is not swallowed into it', () => {
    // An unclosed <details> makes the browser nest everything after it inside the
    // collapsed element: the page showed the reasoning toggle and then nothing.
    // Assert the PAIR, and assert on the closing tag specifically — a test that
    // only checks `not.toContain('&lt;details&gt;')` passes while `&lt;/details&gt;`
    // is on the page.
    const session = meta({ filePath: path.join(TESTDATA, 'claude-thinking.jsonl') });
    const html = renderSessionHtmlDocument(session, renderSessionMarkdownDocument(session, { reasoning: 'fold' }));
    const count = (re: RegExp) => (html.match(re) || []).length;

    expect(count(/<details>/g)).toBe(1);
    expect(count(/<\/details>/g)).toBe(1);
    expect(count(/&lt;\/?details&gt;/g)).toBe(0);
    // The turn that follows the reasoning is still a sibling, not a child.
    expect(html).toContain('off by one');
  });

  it('escapes a details tag that only appears in prose, and keeps what follows visible', () => {
    // `<details>` on its own is a complete INLINE html token, so a transcript that
    // merely discusses the tag used to emit a live, unclosed element that hid every
    // later turn.
    const html = renderSessionHtmlDocument(
      meta(),
      'Use a <details> element to collapse it.\n\n## Assistant\n\nthe turn after it\n',
    );
    expect(html).not.toMatch(/<details>/);
    expect(html).toContain('&lt;details&gt;');
    expect(html).toContain('the turn after it');
  });

  it('keeps a dollar sequence in the reasoning intact, and never prints the sentinel', () => {
    // String.replace expands `$&`, "$`", `$'` and `$n` in a STRING replacement,
    // and marked turns `& < > " '` into entities — so reasoning containing bash
    // ANSI-C quoting spliced the matched sentinel back into the published page
    // and ate the next character. Trigger set: `$` followed by any of & < > " '.
    const thinking: SessionEvent = {
      type: 'thinking',
      agent: 'claude',
      timestamp: '2026-08-17T10:00:00.000Z',
      content: "Use $'\\n' with sed $& and make $< to see it.",
    };
    const folded = renderConversationMarkdown([thinking], { reasoning: 'fold' });
    const html = renderSessionHtmlDocument(meta(), folded);

    expect(html).not.toContain('aGeNtSfOlDbLoCk');
    expect(html).toContain('$&#39;');   // the apostrophe after $ survived
    expect(html).toContain('$&amp;');
    expect(html).toContain('$&lt;');
    // And the element is still well-formed around it.
    expect((html.match(/<details>/g) || []).length).toBe(1);
    expect((html.match(/<\/details>/g) || []).length).toBe(1);
  });

  it('cannot be tricked into forging a disclosure element with the sentinel', () => {
    const html = renderSessionHtmlDocument(meta(), 'aGeNtSfOlDbLoCk0aGeNtSfOlDbLoCk and more text\n');
    expect(html).not.toMatch(/<details>/);
    expect(html).toContain('and more text');
  });

  it('stays matched to what the real fold renderer emits', () => {
    // The allowlist is an exact-string gate, so it silently stops working if
    // session/render.ts ever changes its fold markup. Drive the real producer.
    const thinking: SessionEvent = {
      type: 'thinking',
      agent: 'claude',
      timestamp: '2026-08-17T10:00:00.000Z',
      content: 'weighing two options',
    };
    const folded = renderConversationMarkdown([thinking], { reasoning: 'fold' });
    const html = renderSessionHtmlDocument(meta(), folded);
    const body = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));

    expect(folded).toContain('<details>');
    expect(body).toContain('<details>');
    expect(body).not.toContain('&lt;details&gt;');
  });

  it('collapses reasoning through the WHOLE document path, from a real transcript', () => {
    // The unit above drives renderConversationMarkdown directly. This one goes
    // through renderSessionMarkdownDocument — what the command actually calls —
    // parsing a transcript that carries a real `thinking` block, because no
    // session on this fleet records one and the escaping bug hid there.
    const session = meta({
      shortId: 'think001',
      filePath: path.join(TESTDATA, 'claude-thinking.jsonl'),
    });
    const folded = renderSessionMarkdownDocument(session, { reasoning: 'fold' });
    const html = renderSessionHtmlDocument(session, folded);
    const body = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));

    expect(body).toContain('<details>');
    expect(body).toContain('<summary>Reasoning</summary>');
    expect(body).toContain('</details>');
    expect(body).not.toContain('&lt;details&gt;');
    expect(body).toContain('off by one');
  });

  it('omits reasoning entirely by default, so a share does not leak it unasked', () => {
    const session = meta({ filePath: path.join(TESTDATA, 'claude-thinking.jsonl') });
    const html = renderSessionHtmlDocument(session, renderSessionMarkdownDocument(session));
    expect(html).not.toContain('<details>');
    expect(html).not.toContain('whether the caller compensates');
  });

  it('escapes every near-miss variant of the fold wrapper', () => {
    // Only the exact block session/render.ts emits is lifted; anything else is
    // ordinary untrusted text.
    for (const variant of [
      '<details onclick="alert(1)">\n<summary>Reasoning</summary>\n\nx\n\n</details>',
      '<DETAILS>\n<summary>Reasoning</summary>\n\nx\n\n</details>',
      '<details id=a>\n<summary>Reasoning</summary>\n\nx\n\n</details>',
      '<details>\n<summary>Notes</summary>\n\nx\n\n</details>',
    ]) {
      const html = renderSessionHtmlDocument(meta(), variant);
      expect(html).not.toMatch(/<details[ >]/i);
      expect(html).not.toContain('onclick="alert(1)"');
    }
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

  it('collapses a multi-line first prompt to one readable line', () => {
    // A real session c016eaec titled itself with a pasted URL + a screenshot path +
    // the request, and rendered as a three-line wall above the transcript.
    const heading = 'https://github.com/phnx-labs/.agents-system -- [HOME]/Screenshots/CleanShot 2026-08-17 at [EMAIL] -- Hey Claude, can you please help me protect this';
    const title = sessionPageTitle(meta(), `# ${heading}\n\nbody\n`);
    expect(title.length).toBeLessThanOrEqual(91);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('\n');
    // Cut on a word boundary, not mid-word.
    expect(heading.startsWith(title.slice(0, -1))).toBe(true);
    expect(title.slice(0, -1).endsWith(' ')).toBe(false);
  });

  it('leaves a short title untouched', () => {
    expect(sessionPageTitle(meta(), '# Fix the retry bug\n')).toBe('Fix the retry bug');
  });

  it('hard-cuts a single unbroken token that has no word boundary', () => {
    const url = `https://example.com/${'a'.repeat(200)}`;
    const title = sessionPageTitle(meta(), `# ${url}\n`);
    expect(title).toBe(`${url.slice(0, 90)}…`);
  });
});

describe('escapeHtml', () => {
  it('escapes every character that could break out of text or an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`))
      .toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});
