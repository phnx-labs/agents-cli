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
# requires a clean main, npm auth and gh auth first. Same split as
# validate-bump.sh.
#
# Usage:
#   stuck-release.sh <registry-latest> < tags.txt
#
# stdin: one `<version> <yes|no>` pair per line -- the tagged version, and
#        whether the registry has it. release.sh builds this from
#        `git ls-remote --tags` + `npm view`.
#
# Prints the OLDEST stuck version (the one to finish first) and exits 0.
# Prints nothing and exits 1 when nothing is stuck.

set -euo pipefail

LATEST="${1:-}"
[[ -n "$LATEST" ]] || { echo "usage: stuck-release.sh <registry-latest> < tags" >&2; exit 2; }

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
printf '%s\n' "$STUCK"
