#!/usr/bin/env bash
#
# Pick the commit a release should tag + publish, given the commit that landed on
# the default branch (the squash-merge) and the commit CI actually tested (the
# release PR head).
#
# The published tarball MUST be a tree the full CI matrix went green on. Normally
# that is the merge commit on the default branch, so we tag that (keeps the tag on
# the branch's first-parent history). But the default branch is busy: if unrelated
# PRs merge during a release PR's CI window, the squash-merge lands on a newer base
# and its tree diverges from what CI tested. In that case the merge tree was never
# validated as a unit, so we tag + publish the exact CI-tested release commit
# instead; the commits that merged during the window ride the next release.
#
# The decision is a single tree comparison, extracted here so release.sh's core
# integrity rule ("published tree == a CI-green tree") is unit-testable without
# npm/gh/CI — the same reason validate-bump.sh exists.
#
# Usage: select-publish-commit.sh <merged-sha> <ci-tested-sha>
# Echoes the chosen commit SHA. Runs in the current git repository.
set -euo pipefail

[[ $# -eq 2 ]] || { echo "usage: select-publish-commit.sh <merged-sha> <ci-tested-sha>" >&2; exit 2; }
merged_sha="$1"
ci_commit="$2"

if [[ "$(git rev-parse "$merged_sha^{tree}")" == "$(git rev-parse "$ci_commit^{tree}")" ]]; then
  # No drift: the merge tree still equals the CI-tested tree. Tag the merge commit.
  printf '%s\n' "$merged_sha"
else
  # Concurrent-merge drift: publish the exact commit the matrix went green on.
  printf '%s\n' "$ci_commit"
fi
