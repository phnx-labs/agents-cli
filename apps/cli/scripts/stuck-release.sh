#!/usr/bin/env bash
#
# stuck-release.sh -- find the release that died between `git tag` and `npm publish`.
#
# A release that dies after the tag is pushed but before the registry sees it
# leaves a v* tag npm never received. The next run then validates its bump
# against npm (which is behind), cuts the NEXT version, and the gap widens by one
# every time. That is how @phnx-labs/agents-cli ended up with npm at 1.20.78,
# main at 1.20.81, and v1.20.80 + v1.20.81 tagged but unpublished.
#
# The arithmetic lives here rather than inline in release.sh so it can be tested
# directly (scripts/stuck-release.test.ts) -- reaching it inside release.sh
# requires live npm and GitHub access first. Same split as validate-bump.sh.
#
# Usage:
#   stuck-release.sh <registry-latest> [<bump-kind> <main-version>] < tags.txt
#
# stdin: one `<version> <yes|no>` pair per line -- the tagged version, and
#        whether the registry has it. release.sh builds this from
#        `git ls-remote --tags` + `npm view`.
#
# Prints the OLDEST stuck version (the one to finish first) and exits 0.
# Prints nothing and exits 1 when nothing is stuck.
#
# The optional <bump-kind> <main-version> pair carves out the ONE case where a
# stuck tag must not block: `patch-from-main` stepping over main's own version.
# Without it the two guards deadlock, each naming the other as the way out --
# observed on 2026-08-10 with npm at 1.22.35 and v1.22.36 tagged:
#
#   release.sh 1.22.37  -> "refusing to bump past an unpublished release"   (here)
#   release.sh 1.22.36  -> "no complete merged release PR ... cut the next patch"
#
# 1.22.36 could not be finished at all: its CI-tested tree predates the prepack
# version-gate fix (1dffc78bc), so its own `npm publish` fails on a correct
# binary. That is exactly what validate-bump.sh's patch-from-main exists for --
# "main's own version can no longer be published" -- so this guard must let that
# one bump through rather than insisting on a release nothing can complete.

set -euo pipefail

LATEST="${1:-}"
BUMP_KIND="${2:-}"
MAIN_VERSION="${3:-}"
[[ -n "$LATEST" ]] || { echo "usage: stuck-release.sh <registry-latest> [<bump-kind> <main-version>] < tags" >&2; exit 2; }

# Strictly newer than the registry's latest? `sort -V` is the semver order.
newer_than_latest() { # $1 = version
  [[ "$1" != "$LATEST" ]] || return 1
  [[ "$(printf '%s\n%s\n' "$LATEST" "$1" | sort -V | tail -1)" == "$1" ]]
}

STUCK=""
while read -r version published _rest; do
  [[ -n "${version:-}" ]] || continue
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  [[ "${published:-}" == "no" ]] || continue
  newer_than_latest "$version" || continue
  # Oldest stuck version wins: that is the one blocking the queue, and finishing
  # it is what lets every later version publish in order.
  if [[ -z "$STUCK" ]] \
     || [[ "$(printf '%s\n%s\n' "$STUCK" "$version" | sort -V | head -1)" == "$version" ]]; then
    STUCK="$version"
  fi
done

[[ -n "$STUCK" ]] || exit 1

# The sanctioned step over an unpublishable stuck release (see the header). Kept
# deliberately narrow -- it fires ONLY when the caller already resolved the bump
# as patch-from-main AND the blocking tag is main's own version. Any other stuck
# version still blocks, and every other bump kind still blocks on this one, so a
# genuine died-between-tag-and-publish jam is reported exactly as before.
if [[ "$BUMP_KIND" == "patch-from-main" && -n "$MAIN_VERSION" && "$STUCK" == "$MAIN_VERSION" ]]; then
  exit 1
fi

printf '%s\n' "$STUCK"
