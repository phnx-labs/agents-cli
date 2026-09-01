/**
 * Pin the required Tests workflow to one affected Linux check (RUSH-2666).
 *
 * Branch protection and release.sh wait on the stable `Tests / test` context.
 * Shards, preflight, and Windows must not sit on that path.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TESTS_YML = readFileSync(join(import.meta.dir, 'tests.yml'), 'utf8');

describe('tests.yml required Linux gate', () => {
  test('keeps a single job named test as the required check', () => {
    expect(TESTS_YML).toMatch(/^  test:\s*$/m);
    expect(TESTS_YML).not.toMatch(/^  cli-test-shard:\s*$/m);
    expect(TESTS_YML).not.toMatch(/^  cli-preflight:\s*$/m);
    expect(TESTS_YML).not.toMatch(/^  cli-docs:\s*$/m);
    expect(TESTS_YML).not.toMatch(/^  scope:\s*$/m);
    expect(TESTS_YML).not.toMatch(/shard: \[1, 2, 3\]/);
  });

  test('Windows is not on the required path', () => {
    expect(TESTS_YML).not.toMatch(/needs: \[.*windows/);
    expect(TESTS_YML).toMatch(/if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
    expect(TESTS_YML).toMatch(/continue-on-error: true/);
  });

  test('the Linux job plans with ci-scope and enforces the selected budget', () => {
    expect(TESTS_YML).toContain('bun scripts/ci-scope.ts');
    expect(TESTS_YML).toContain('--fail-unmapped');
    expect(TESTS_YML).toContain('--validate-manifest');
    expect(TESTS_YML).toContain('impact-proof-');
    // RUSH-2666 (wave 6): the workflow must NOT pass --deadline-sec here.
    // ci-scope.ts's own --run path already picks 1200s for a cli-full plan
    // and IMPACT_BUDGET_SEC (85s) for a selected plan; a hardcoded
    // `--deadline-sec 1200` in the workflow overrides that and silently
    // disables the 85s selected-run budget check on every PR.
    expect(TESTS_YML).not.toContain('--deadline-sec');
  });

  test('fork code stays on GitHub-hosted runners', () => {
    expect(TESTS_YML).toMatch(/runs-on: ubuntu-latest/);
    expect(TESTS_YML).not.toMatch(/runs-on: \[self-hosted/);
    expect(TESTS_YML).not.toMatch(/phnx-trusted/);
  });
});

describe('dependency cache on the required check (R1)', () => {
  // The required check spends 14-22s installing and 0.27s testing on a release
  // PR, so the install is the budget. These pin the cache's CORRECTNESS, not its
  // presence: a cache that restores the wrong tree would silently test something
  // other than the committed lockfile, and the attestation binds tested tree to
  // published bytes.
  const cacheBlock = TESTS_YML.slice(
    TESTS_YML.indexOf('- name: Restore dependencies'),
    TESTS_YML.indexOf('- name: Guard public artifacts'),
  );

  test('the required job restores dependencies from cache', () => {
    expect(TESTS_YML).toContain('- name: Restore dependencies');
    expect(cacheBlock).toContain('uses: actions/cache@');
  });

  test('keys on EVERY lockfile whose node_modules it caches', () => {
    // packages/session-tracker has its own bun.lock. Keying on cli/bun.lock alone
    // would serve a stale session-tracker tree under a key claiming freshness
    // whenever that package's deps moved independently -- cache poisoning.
    expect(cacheBlock).toContain("hashFiles('cli/bun.lock', 'packages/session-tracker/bun.lock')");
    expect(cacheBlock).toContain('runner.os');
  });

  test('has NO restore-keys, so a partial restore cannot layer onto another lockfile', () => {
    // The tempting optimization is a prefix fallback. It is wrong here: bun would
    // install on top of a different lockfile's node_modules, and
    // --frozen-lockfile only guarantees the tree matches the lock from a clean or
    // exact-match state. Correct beats warm.
    expect(cacheBlock).not.toContain('restore-keys');
  });

  test('covers every directory installCommandsForPlan installs into', () => {
    expect(cacheBlock).toContain('cli/node_modules');
    expect(cacheBlock).toContain('packages/session-tracker/node_modules');
    expect(cacheBlock).toContain('~/.bun/install/cache');
  });

  test('restores BEFORE the step that installs, or it saves nothing', () => {
    expect(TESTS_YML.indexOf('- name: Restore dependencies'))
      .toBeLessThan(TESTS_YML.indexOf('- name: Selected proof'));
  });
});
