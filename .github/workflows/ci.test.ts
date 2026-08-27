/**
 * Pin the cross-platform matrix trigger policy in ./ci.yml.
 *
 * The six-job OS × Node matrix is expensive (macOS 10×, Windows 2×) and gates
 * nothing (main requires only `test` + `gitleaks`; release.sh gates on an
 * exact-tree attestation, never this matrix). It must therefore stay OFF the
 * release path: a nightly schedule plus manual workflow_dispatch only. It must
 * NOT fire on release/** branches (16-53 min of billed, non-gating, often-red
 * work on every release) nor on v* tags.
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

describe('ci.yml cross-platform matrix trigger policy', () => {
  const on = onBlock(CI_YML);

  test('runs on a nightly schedule', () => {
    expect(on).toMatch(/schedule:\s*\n\s+- cron:\s*'[^']+'/);
  });

  test('is OFF the release path — no release/** push or pull_request trigger', () => {
    expect(on).not.toContain("branches: ['release/**']");
    expect(on).not.toMatch(/^\s*push:\s*$/m);
    expect(on).not.toMatch(/^\s*pull_request:\s*$/m);
  });

  test('v* tags do not trigger the matrix', () => {
    expect(on).not.toMatch(/^\s*tags:\s*/m);
    expect(on).not.toContain("tags: ['v*']");
    expect(on).not.toContain('tags: ["v*"]');
    expect(on).not.toContain('tags: [v*]');
  });

  test('workflow_dispatch remains for on-demand pre-release runs', () => {
    expect(on).toMatch(/^\s*workflow_dispatch:\s*$/m);
  });
});
