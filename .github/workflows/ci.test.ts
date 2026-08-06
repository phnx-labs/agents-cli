/**
 * Pin the release cross-platform matrix trigger policy in ./ci.yml.
 *
 * The six-job OS × Node matrix is expensive (macOS 10×, Windows 2×). It must
 * run on release/** branch pushes/PRs and manual workflow_dispatch only — never
 * on v* tag pushes, because the tag points at the exact release commit already
 * gated by the release-branch matrix.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CI_YML = readFileSync(join(import.meta.dir, 'ci.yml'), 'utf8');

/** Extract the top-level `on:` block (everything before `jobs:`). */
function onBlock(source: string): string {
  const start = source.search(/^on:\s*$/m);
  const jobs = source.search(/^jobs:\s*$/m);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(jobs).toBeGreaterThan(start);
  return source.slice(start, jobs);
}

describe('ci.yml release-matrix trigger policy', () => {
  const on = onBlock(CI_YML);

  test('push still triggers on release/** branches', () => {
    expect(on).toMatch(/push:\s*\n\s+branches:\s*\['release\/\*\*'\]/);
  });

  test('v* tags do not trigger the matrix', () => {
    expect(on).not.toMatch(/^\s*tags:\s*/m);
    expect(on).not.toContain("tags: ['v*']");
    expect(on).not.toContain('tags: ["v*"]');
    expect(on).not.toContain('tags: [v*]');
  });

  test('workflow_dispatch remains for manual runs', () => {
    expect(on).toMatch(/^\s*workflow_dispatch:\s*$/m);
  });
});
