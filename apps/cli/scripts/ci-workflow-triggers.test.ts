/**
 * Pin the release cross-platform matrix trigger policy in `.github/workflows/ci.yml`.
 *
 * The six-job OS × Node matrix is expensive (macOS 10×, Windows 2×). It must run
 * on `release/**` branch pushes/PRs and manual `workflow_dispatch` only — never on
 * `v*` tag pushes, because the tag points at the exact release commit already
 * gated by the release-branch matrix.
 *
 * Same style as `release.test.ts`: read the real file, assert policy with string
 * structure — no mocks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CI_YML = fs.readFileSync(
  path.resolve(__dirname, '../../../.github/workflows/ci.yml'),
  'utf-8',
);

/** Extract the top-level `on:` block (everything before `jobs:`). */
function onBlock(src: string): string {
  const match = src.match(/^on:\n([\s\S]*?)\n(?=jobs:)/m);
  expect(match, 'ci.yml must have a top-level on: block before jobs:').toBeTruthy();
  return match![1];
}

describe('ci.yml release matrix trigger policy', () => {
  const on = onBlock(CI_YML);

  it('keeps release/** push as a trigger', () => {
    expect(on).toMatch(/push:\n\s+branches:\s*\['release\/\*\*'\]/);
  });

  it('does not trigger the matrix on v* tag pushes', () => {
    expect(on).not.toMatch(/^\s*tags:\s*/m);
    expect(on).not.toContain("tags: ['v*']");
    expect(on).not.toContain('tags: ["v*"]');
    expect(on).not.toContain('tags: [v*]');
  });

  it('keeps workflow_dispatch as a trigger', () => {
    expect(on).toMatch(/^\s*workflow_dispatch:\s*$/m);
  });

  it('documents why the tag does not re-run the matrix', () => {
    expect(CI_YML).toMatch(/does NOT re-run on v\* tags/i);
    expect(CI_YML).toMatch(/tag points at the exact release commit/i);
  });
});
