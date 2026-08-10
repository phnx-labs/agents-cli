/**
 * Pin the `.agents/` durable-output layout.
 *
 * Every agent-produced artifact worth keeping — plans, reports, rendered
 * visuals — lives under `.agents/artifacts/<yyyy-mm-dd>/`, filed by the day it
 * was authored. `.agents/reports/`, `.agents/plans/` and `.agents/viz/` were
 * folded into it by 0e0da8e21 and must not come back: three homes for one kind
 * of file is how the same artifact landed in a different place depending on
 * which skill wrote it.
 *
 * This is a test rather than prose because the prose did not hold. Within a day
 * of the consolidation two separate branches re-created `.agents/reports/` —
 * one merged (23b1db6b1), one still open (#2558) — both cut before the
 * convention reached AGENTS.md and neither able to read it. A branch that
 * predates a convention cannot follow it; CI can.
 *
 * Assertions run against git-tracked paths, not the working tree, so a
 * developer's untracked scratch under `.agents/artifacts/` never reds the gate.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const RETIRED = ['reports', 'plans', 'viz'];

/** Git-tracked paths under `.agents/`, repo-relative and POSIX-separated. */
function trackedAgentsPaths(): string[] {
  return execFileSync('git', ['ls-files', '--', '.agents/'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

describe('.agents/ durable-output layout', () => {
  const tracked = trackedAgentsPaths();

  for (const dir of RETIRED) {
    test(`.agents/${dir}/ stays retired — file it under .agents/artifacts/<yyyy-mm-dd>/`, () => {
      expect(tracked.filter((p) => p.startsWith(`.agents/${dir}/`))).toEqual([]);
    });
  }

  test('every committed artifact sits in a yyyy-mm-dd directory', () => {
    const stray = tracked
      .filter((p) => p.startsWith('.agents/artifacts/'))
      .filter((p) => !/^\.agents\/artifacts\/\d{4}-\d{2}-\d{2}\//.test(p));
    expect(stray).toEqual([]);
  });
});
