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

## Producing an attestation (interim path, RUSH-2749)

RUSH-2666 shipped the consumer above but not a CI lane that writes
`ATTEST.json` on every push to `origin/<default>` — the near-instant-CI plan's
producer lane (`.agents/artifacts/2026-08-15/plan-ci-release-near-instant.md`)
is not built yet. Until it lands, an operator runs the producer by hand before
`release.sh --apply` can find anything:

```bash
export RELEASE_ATTESTATION_DIR=~/.agents-cli-release-attestations   # any stable dir, same for both commands
apps/cli/scripts/release-attestation-produce.sh origin/main
```

Run it once for `origin/<default>` before the first `release.sh --apply`. If
`release.sh`'s 90-second wait for the release-PR-tree attestation expires (the
release commit's tree — package.json bump + folded CHANGELOG + regenerated
command index — differs from `origin/<default>`'s), the script has already
pushed the release branch and opened the PR; produce the second attestation for
that PR's exact head commit and re-run `release.sh` with the same version and
`RELEASE_ATTESTATION_DIR` — it reuses the open PR when the branch's tree is
unchanged.

`RELEASE_ATTESTATION_DIR` MUST be set to the same path for both commands and
MUST NOT be a path release.sh's own release-owned worktree will delete —
`release.sh` re-execs into a fresh detached `origin/<default>` worktree on
every invocation (`scripts/release-worktree.sh`), so its default
`<repo>/.release-attestations` resolves inside that throwaway checkout and is
never seen twice. `release-attestation-produce.sh` runs the full suite (fail
closed on red), and, on a macOS box with `agents` + the `apple.com` secrets
bundle, signs and notarizes the CLI binary and the two helper `.app`s before
`npm pack` — the same steps `release.sh`'s privileged phase ran before
RUSH-2666 moved build/sign to attestation time. Off a macOS signing box, `npm
pack`'s own prepack gates fail closed instead of attesting an unsigned
tarball, so the producer must run on a provisioned home base (`mac-mini`) to
produce a real, publishable attestation.
