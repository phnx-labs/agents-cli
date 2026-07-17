import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExpire, slugify, detectProject, defaultSlug } from './publish.js';
import { renderWorkerScript } from './worker-template.js';

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
    expect(src).toContain('Date.parse(expiresAt)');
  });
  it('is a module Worker (default export fetch)', () => {
    expect(src).toContain('export default');
    expect(src).toContain('async fetch(request, env)');
  });
});
