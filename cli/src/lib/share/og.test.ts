import { describe, expect, it } from 'vitest';
import { deriveMeta, injectOgMeta } from './og.js';

describe('deriveMeta', () => {
  it('prefers <title>, falls back to <h1>', () => {
    expect(deriveMeta('<title>My Plan</title><h1>Other</h1>').title).toBe('My Plan');
    expect(deriveMeta('<h1>Just an H1</h1>').title).toBe('Just an H1');
    expect(deriveMeta('<p>no title here at all</p>', 'fallback').title).toBe('fallback');
  });

  it('takes description from meta[name=description] when present', () => {
    const html = '<meta name="description" content="the canonical summary"><p>ignored paragraph text here</p>';
    expect(deriveMeta(html).description).toBe('the canonical summary');
  });

  it('falls back to the first substantial paragraph, skipping tiny ones', () => {
    const html = '<p>short</p><p>This is a much longer paragraph that should become the description text.</p>';
    expect(deriveMeta(html).description).toBe(
      'This is a much longer paragraph that should become the description text.',
    );
  });

  it('truncates long descriptions with an ellipsis', () => {
    const long = 'x'.repeat(400);
    const d = deriveMeta(`<p>${long}</p>`).description;
    expect(d.length).toBeLessThanOrEqual(198);
    expect(d.endsWith('…')).toBe(true);
  });
});

describe('injectOgMeta', () => {
  const fields = {
    title: 'agents share',
    description: 'one command → a shareable link',
    imageUrl: 'https://share.agents-cli.sh/x.png',
    pageUrl: 'https://share.agents-cli.sh/x',
  };

  it('inserts og:image + twitter:card before </head>', () => {
    const out = injectOgMeta('<html><head><title>t</title></head><body>b</body></html>', fields);
    expect(out).toContain('<meta property="og:image" content="https://share.agents-cli.sh/x.png">');
    expect(out).toContain('<meta name="twitter:card" content="summary_large_image">');
    // ordering: our block lands inside <head>
    expect(out.indexOf('og:image')).toBeLessThan(out.indexOf('</head>'));
  });

  it('escapes attribute-breaking characters in title/description', () => {
    const out = injectOgMeta('<head></head>', { ...fields, title: 'a "quote" & <tag>' });
    expect(out).toContain('a &quot;quote&quot; &amp; &lt;tag&gt;');
    expect(out).not.toContain('content="a "quote"');
  });

  it('is idempotent — re-injecting does not stack duplicate blocks', () => {
    const once = injectOgMeta('<head></head>', fields);
    const twice = injectOgMeta(once, { ...fields, imageUrl: 'https://share.agents-cli.sh/y.png' });
    // exactly one og:image tag, and it reflects the latest value
    expect(twice.match(/og:image"/g)?.length).toBe(1);
    expect(twice).toContain('y.png');
    expect(twice).not.toContain('x.png');
  });

  it('still injects when there is no <head> (prepends the block)', () => {
    const out = injectOgMeta('<body>only body</body>', fields);
    expect(out).toContain('og:image');
  });

  it('defaults image dimensions to the 1200×630 card', () => {
    const out = injectOgMeta('<head></head>', fields);
    expect(out).toContain('<meta property="og:image:width" content="1200">');
    expect(out).toContain('<meta property="og:image:height" content="630">');
  });

  it('reports the real image dimensions when given (matches the served asset)', () => {
    const out = injectOgMeta('<head></head>', { ...fields, imageWidth: 2400, imageHeight: 1260 });
    expect(out).toContain('<meta property="og:image:width" content="2400">');
    expect(out).toContain('<meta property="og:image:height" content="1260">');
  });
});
