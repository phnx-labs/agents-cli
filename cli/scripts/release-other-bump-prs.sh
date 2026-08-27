#!/usr/bin/env bash
#
# release-other-bump-prs.sh -- detect an EARLIER release's still-open version-bump
# PR before folding .changelog/next/* for a new target (PHNX-3084).
#
# The decoupled release (RUSH-2395) merges the version-bump PR asynchronously,
# best-effort, AFTER publish. If that async merge fails -- a real CHANGELOG
# conflict a human has to resolve -- the bump PR for v1.2.3 stays open and its
# .changelog/next/* fragments remain queued on origin/<default>: the fold that
# would have drained them only ever landed inside that unmerged release-branch
# commit. If a DIFFERENT later version (v1.2.4) is then released before someone
# merges the v1.2.3 PR, release-changelog.ts re-reads the SAME .changelog/next/*
# fragments and folds v1.2.3's notes under v1.2.4 -- misattributing (or losing)
# an earlier version's release notes.
#
# release.sh's same-target STUCK_BUMP_PR retry lands THIS target's own open bump
# PR on a re-run; it queries only --head release/v<current-target>, so it never
# sees an OTHER version's stuck PR. This helper closes that cross-version gap.
#
# The detection is split out here rather than inlined in release.sh so it can be
# tested directly (scripts/release-other-bump-prs.test.ts) -- reaching it inside
# release.sh needs live GitHub. Same split as stuck-release.sh / validate-bump.sh.
#
# Usage:
#   release-other-bump-prs.sh <current-release-branch> < prs.txt
#
# stdin: one `<pr-number> <head-branch>` pair per line -- release.sh builds this
#        from `gh pr list --state open --json number,headRefName`.
#
# Prints each OTHER open `release/v*` bump PR as `#<number> <branch>`, one per
# line, in input order, and exits 0. Prints nothing (still exit 0) when the only
# open release branch is the current target's, or none is. A caller treats any
# output as "refuse to fold -- an earlier bump is stuck".

set -euo pipefail

CURRENT="${1:-}"
[[ -n "$CURRENT" ]] || { echo "usage: release-other-bump-prs.sh <current-release-branch> < prs" >&2; exit 2; }

while read -r number branch _rest; do
  [[ -n "${number:-}" && -n "${branch:-}" ]] || continue
  # Only version-bump release branches -- release/v<semver>. A feature branch that
  # merely starts with "release" (release-notes-doc, releasing-guide) is not a
  # stuck bump and must not wedge every future release.
  [[ "$branch" =~ ^release/v[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  # The current target's own branch is handled by release.sh's same-target path,
  # not a cross-version conflict.
  [[ "$branch" != "$CURRENT" ]] || continue
  printf '#%s %s\n' "$number" "$branch"
done
