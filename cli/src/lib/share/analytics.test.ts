import { describe, expect, it } from 'vitest';
import { injectAnalyticsBeacon, analyticsEnabled, renderBeacon } from './analytics.js';

describe('renderBeacon', () => {
  it('emits a Cloudflare Web Analytics snippet with the zone token', () => {
    const html = renderBeacon('abc-123');
    expect(html).toContain('https://static.cloudflareinsights.com/beacon.min.js');
    expect(html).toContain('data-cf-beacon=');
    expect(html).toContain('"token":"abc-123"');
  });
});

describe('injectAnalyticsBeacon', () => {
  it('appends the beacon before </body>', () => {
    const out = injectAnalyticsBeacon('<html><head></head><body>hi</body></html>', 'tok');
    expect(out).toContain('beacon.min.js');
    expect(out.indexOf('beacon.min.js')).toBeLessThan(out.indexOf('</body>'));
    expect(out).toContain('</body>');
  });

  it('falls back to </head> when there is no body close tag', () => {
    const out = injectAnalyticsBeacon('<html><head></head>content', 'tok');
    expect(out).toContain('beacon.min.js');
    expect(out.indexOf('beacon.min.js')).toBeLessThan(out.indexOf('</head>'));
  });

  it('prepends to a bare document when no head/body exists', () => {
    const out = injectAnalyticsBeacon('<h1>hi</h1>', 'tok');
    expect(out).toContain('beacon.min.js');
    expect(out.indexOf('<h1>hi</h1>')).toBeGreaterThan(0);
  });

  it('is idempotent and removes a previous agents-share analytics block', () => {
    const first = injectAnalyticsBeacon('<html><body>hi</body></html>', 'tok1');
    const second = injectAnalyticsBeacon(first, 'tok2');
    expect(second.match(/beacon\.min\.js/g) ?? []).toHaveLength(1);
    expect(second).toContain('tok2');
    expect(second).not.toContain('tok1');
  });

  it('returns the original HTML when the token is empty', () => {
    const html = '<html><body>hi</body></html>';
    expect(injectAnalyticsBeacon(html, '')).toBe(html);
  });
});

describe('analyticsEnabled', () => {
  it('is true when a non-empty token is present', () => {
    expect(analyticsEnabled({ analyticsToken: 'tok' })).toBe(true);
  });

  it('is false when the token is missing or whitespace', () => {
    expect(analyticsEnabled(undefined)).toBe(false);
    expect(analyticsEnabled({ analyticsToken: '' })).toBe(false);
    expect(analyticsEnabled({ analyticsToken: '   ' })).toBe(false);
  });
});
