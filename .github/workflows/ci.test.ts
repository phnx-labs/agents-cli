/**
 * Trigger policy for the expensive six-job cross-platform matrix in ci.yml.
 *
 * release/** push (and PR) + workflow_dispatch only. v* tags must not re-trigger
 * it — the tag points at the exact release commit already gated on the release
 * branch.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ciYml = readFileSync(join(import.meta.dir, 'ci.yml'), 'utf8');

/** Slice the top-level `on:` block (lines between `on:` and `jobs:`). */
function onBlock(source: string): string {
  const start = source.search(/^on:\s*$/m);
  const jobs = source.search(/^jobs:\s*$/m);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(jobs).toBeGreaterThan(start);
  return source.slice(start, jobs);
}

describe('ci.yml release-matrix trigger policy', () => {
  const on = onBlock(ciYml);

  test('push still triggers on release/** branches', () => {
    expect(on).toMatch(/push:\s*\n\s+branches:\s*\['release\/\*\*'\]/);
  });

  test('v* tags do not trigger the matrix', () => {
    expect(on).not.toMatch(/tags:\s*\[/);
    expect(on).not.toContain("tags: ['v*']");
    expect(on).not.toContain('tags: ["v*"]');
  });

  test('workflow_dispatch remains for manual runs', () => {
    expect(on).toMatch(/^\s*workflow_dispatch:\s*$/m);
  });
});
