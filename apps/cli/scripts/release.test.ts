import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RELEASE_SH = fs.readFileSync(path.resolve(__dirname, 'release.sh'), 'utf-8');

describe('release.sh PR-head synchronization', () => {
  it('pins CI to the exact release commit instead of GitHub\'s eventually consistent PR head', () => {
    const waitFunction = RELEASE_SH.match(
      /wait_for_ci_green\(\) \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;

    expect(waitFunction).toBeDefined();
    expect(waitFunction).toContain('local pr="$1" head_sha="${2:-}"');
    expect(waitFunction).not.toContain('gh pr view');
    expect(RELEASE_SH).toContain('RELEASE_CI_HEAD="$EXISTING_HEAD"');
    expect(RELEASE_SH.match(/RELEASE_CI_HEAD="\$RELEASE_COMMIT"/g)).toHaveLength(2);
    expect(RELEASE_SH).toContain('wait_for_ci_green "$PR_NUMBER" "$RELEASE_CI_HEAD"');
    expect(RELEASE_SH).not.toContain('wait_for_ci_green "$PR_NUMBER" "$RELEASE_COMMIT"');
    expect(RELEASE_SH).toContain(
      'wait_for_ci_green "$MERGED_RELEASE_PR" "$CI_TESTED_HEAD"',
    );
  });

  it('waits on the stable aggregate test context, not internal CLI job names', () => {
    const expectedChecks = RELEASE_SH.match(
      /EXPECTED_CHECKS=\((?<checks>[\s\S]*?)\)\n# The Windows/,
    )?.groups?.checks;

    expect(expectedChecks).toBeDefined();
    expect(expectedChecks).toContain('test gitleaks');
    expect(expectedChecks).not.toContain('test-shard');
    expect(expectedChecks).not.toContain('typecheck');
    expect(expectedChecks).not.toContain('compiled-smoke');
  });
});
