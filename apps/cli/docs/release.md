# Release

Ordinary `scripts/release.sh` publishes a version that CI already packed and
proved. It does not re-run the full suite, rebuild the package, or notarize
helpers.

Hard target: start → npm visibility **P99 ≤ 180 seconds** when helper inputs
are unchanged.

## What the script consumes

| Input | Bind | Failure |
| --- | --- | --- |
| Merge-candidate attestation | candidate tree + bun/node + lockfile digest + policy version + suite | Missing exact key. Parent or nearby commit evidence is rejected. |
| Pretested `.tgz` | `tarball.digest` + filename | Digest mismatch. The script never packs a replacement. |
| Release manifest | per-helper `inputDigest` + `assetDigest` | Missing helper or changed inputs. Rebuild/notarize is outside this path. |

Attestations live in `<repo>/.release-attestations` on the trigger box (or
`RELEASE_ATTESTATION_DIR`). After the tag is pushed, `release.sh` uploads
`release-attestation.json`, the `.tgz`, `release-manifest.json`, and the
reused `ComputerHelper.app.zip` to `v<version>`. The home-base worktree is
throwaway and has no store — it downloads those assets from the tag.
`require` matches the candidate tree plus lock/policy from that tree; it does
not re-key bun/node/`uname` from the releaser PATH, so a Linux-tested record
is valid on the Darwin home base.

```bash
apps/cli/scripts/release-attestation.sh identity --repo-root .
apps/cli/scripts/release-attestation.sh require --dir .release-attestations --tree <tree>
apps/cli/scripts/release-attestation.sh promote --file <attestation.json> --tarball <file.tgz>
apps/cli/scripts/release-manifest.sh require --file release-manifest.json --repo-root .
apps/cli/scripts/release-install-smoke.sh <file.tgz> <version>
```

## Ordinary flow

1. Typecheck the isolated release worktree.
2. Require an attestation for `origin/<default>`.
3. Open the version/changelog PR.
4. Require an attestation (and therefore a pretested tarball) for the release
   commit tree. Wait at most 90 seconds.
5. Squash-merge only when the final default-branch tree equals that candidate.
6. Tag `v<version>`.
7. On the home base: install-smoke the exact `.tgz`, reuse helpers, `npm publish`
   those bytes. GitHub Actions OIDC sets provenance when
   `ACTIONS_ID_TOKEN_REQUEST_URL` is present.

`--skip-tests` does not skip the attestation bind.

## Outside this path

Sign, notarize, and helper rebuilds run only when a helper's input digest
changes, in a separate builder. Ordinary `release.sh` will not call
`sign-cli-binary.sh`, `publish-computer-helper-mac.sh`, or a crabbox full suite.
