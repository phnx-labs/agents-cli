/**
 * Pin the Windows helper's release trigger to its OWN tag.
 *
 * `release-exe` used to fire on the CLI's `v*` tags, which had two costs:
 *
 *   - every ordinary CLI release rebuilt and re-uploaded a ~165MB self-contained
 *     exe that nobody had changed — the macOS helpers avoid this via
 *     `release-manifest.sh`'s input digest, the Windows one had no gate at all;
 *   - and it uploaded onto the CLI tag, which since the helper-tag split is an
 *     address no client requests: `ssh-tunnel.ts` resolves
 *     `computer-win/v<x.y.z>` from the CLI's pinned floor.
 *
 * Cutting `computer-win/v<x.y.z>` is a deliberate act, so the trigger itself is
 * the rebuild gate. This is a test rather than a comment because GitHub does not
 * evaluate the `paths:` filter for tag pushes — the tag pattern is the ONLY
 * thing standing between a CLI release and a pointless 165MB rebuild, and a
 * one-word edit silently restores the old behaviour.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const YML = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'computer-helper-win.yml'),
  'utf-8',
);

describe('computer-helper-win: the helper tag is the rebuild gate', () => {
  it('releases on its own tag, never on the CLI version tag', () => {
    expect(YML).toContain("tags: ['computer-win/v*']");
    // The regression: `tags: ['v*']` matches every CLI release.
    expect(YML).not.toContain("tags: ['v*']");
    expect(YML).not.toContain('tags: ["v*"]');
  });

  it('still gates the release job on a tag push, not a branch push', () => {
    // Without this the exe would be rebuilt on every push to main too.
    expect(YML).toContain("if: github.ref_type == 'tag'");
  });

  it('uploads to the tag that triggered it', () => {
    // GITHUB_REF_NAME is the helper tag now; hardcoding a `v$VERSION` anywhere
    // here would publish to the CLI's tag again.
    expect(YML).toContain('gh release upload $env:GITHUB_REF_NAME');
    expect(YML).not.toMatch(/gh release upload\s+"?v\$/);
  });
});
