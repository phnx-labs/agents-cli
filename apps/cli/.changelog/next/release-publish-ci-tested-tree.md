- **Releases publish the CI-tested tree, not a drifted merge.** On a busy default
  branch, unrelated PRs merging during a release PR's CI window made the
  squash-merge tree diverge from what CI actually tested, so `release.sh` refused
  to publish (`merged tree != built tree`) and the release stalled — every attempt
  merged a version bump it could never tag. The publish now tags the exact release
  commit the full matrix went green on (the PR head), letting the intervening
  commits ride the next release; the merge commit is still tagged when its tree
  matches (no drift). The `wait_for_ci_green` gate is unchanged, so the published
  tarball is always a tree the full matrix validated. The tree-comparison decision
  is extracted into `scripts/select-publish-commit.sh` and unit-tested against a
  real git repo. Source: `apps/cli/scripts/release.sh`,
  `apps/cli/scripts/select-publish-commit.sh`.
