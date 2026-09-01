#!/usr/bin/env bash
#
# Print the newest commit at or below `origin/<branch>` whose TREE already has a
# published attestation on the rolling `main-attestations` release (PHNX-3705).
#
# Why this exists. release.sh used to require an attestation for the tree of
# origin/<branch> AS OF THE INSTANT IT RAN. attest-main.yml produces that by
# running the full suite — minutes of work — so on a repo where agents merge
# continuously, main advances faster than attestation completes and the release
# loses the race every time:
#
#     [2/6] Require origin/main attestation
#     error: missing exact attestation key: tree=2aa4ed447... suite=selected
#
# Measured 2026-09-01: six merges to main in ~30 minutes while attest-main runs
# were still pending; the tip was never attested long enough to release from, so
# the release starved indefinitely. That also makes owner requirement R2 (release
# < 60s) unreachable by construction.
#
# The release does not need THE TIP attested. It needs a green base to cut the
# release commit from and to derive the release-tree attestation against
# (PHNX-3696). Any attested ANCESTOR serves: the published tarball is still bound
# to a tree whose suite passed, and `derive`'s allowlist still fails closed on any
# code file. The only cost is shipping from a slightly older tree than the tip —
# which was always true (an attested tree is by definition not the newest one).
#
# Prints the resolved SHA on stdout, exits 1 when no attested ancestor is found
# within the lookback so the caller can fail loud rather than release unproven
# bytes.
#
# Testable without network: set RELEASE_ATTEST_ASSETS to a newline-separated
# asset list and no `gh` call is made.
set -euo pipefail

REPO_ROOT="${1:?usage: release-attested-base.sh <repo-root> <branch> [lookback]}"
BRANCH="${2:?usage: release-attested-base.sh <repo-root> <branch> [lookback]}"
LOOKBACK="${3:-40}"
ATTEST_TAG="${RELEASE_ATTEST_TAG:-main-attestations}"

assets="${RELEASE_ATTEST_ASSETS-}"
if [[ -z "$assets" ]]; then
  command -v gh >/dev/null 2>&1 || exit 1
  assets="$(gh release view "$ATTEST_TAG" --json assets -q '.assets[].name' 2>/dev/null || true)"
fi
[[ -n "$assets" ]] || exit 1

while read -r sha; do
  [[ -n "$sha" ]] || continue
  tree="$(git -C "$REPO_ROOT" rev-parse "$sha^{tree}" 2>/dev/null)" || continue
  if grep -qxF "attest-$tree.json" <<<"$assets"; then
    printf '%s\n' "$sha"
    exit 0
  fi
done < <(git -C "$REPO_ROOT" rev-list -n "$LOOKBACK" "origin/$BRANCH" 2>/dev/null)

exit 1
