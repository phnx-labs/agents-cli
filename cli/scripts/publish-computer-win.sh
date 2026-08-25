#!/usr/bin/env bash
#
# Cut a Windows computer-helper release by pushing its own tag.
#
# WHY A SCRIPT AND NOT JUST `git tag`: the tag IS the publish action. The
# `release-exe` job in .github/workflows/computer-helper-win.yml fires on
# `computer-win/v*`, builds the self-contained single-file exe, smoke-tests it on
# a real windows-latest runner, and uploads it + its .sha256 as release assets.
# Nothing else publishes that exe, so a mistyped or mis-shaped tag is a silent
# no-op rather than an error -- exactly the failure this script exists to stop.
#
# It is deliberately the SYMMETRIC counterpart of publish-computer-helper-mac.sh:
# one script per helper, each cutting that helper's own tag. Before the tag split
# both helpers rode the CLI's `v*` tag, which meant every CLI release rebuilt a
# ~165MB exe nobody had changed AND published it to an address no client
# requests (`ssh-tunnel.ts` resolves `computer-win/v<x.y.z>` from the pinned
# floor in cli/src/lib/helper-versions.ts).
#
# Usage:
#   scripts/publish-computer-win.sh <x.y.z> [--apply]
#
# Default is DRY-RUN: it validates and prints what it would push. --apply pushes.
#
# After pushing, bump `computer-win`'s floor in cli/src/lib/helper-versions.ts in
# a normal PR -- the tag makes the build downloadable, the floor is what makes a
# CLI ask for it.
set -euo pipefail

cd "$(dirname "$0")/.."
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
gray()  { printf '\033[2m%s\033[0m\n'  "$*"; }
die()   { red "error: $*"; exit 1; }

VERSION=""
APPLY=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    -h|--help) sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) die "unknown flag: $arg" ;;
    *) [[ -z "$VERSION" ]] || die "unexpected argument: $arg"; VERSION="$arg" ;;
  esac
done

[[ -n "$VERSION" ]] || die "usage: scripts/publish-computer-win.sh <x.y.z> [--apply]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "version must be bare X.Y.Z (the tag prefix is added for you), got: $VERSION"

TAG="computer-win/v$VERSION"

# Fail loud on an existing tag rather than letting --force cross anyone's mind:
# the asset upload uses --clobber, so re-tagging would silently replace a
# published binary that some installed CLI already pinned.
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1 \
  || git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  die "$TAG already exists. Helper releases are immutable -- cut the next patch instead."
fi

# The tag must point at a commit whose native/computer-win/ is what you mean to
# ship: the workflow checks out the TAG and builds from it.
SHA="$(git rev-parse HEAD)"
gray "  tag:    $TAG"
gray "  commit: ${SHA:0:12} ($(git log -1 --format=%s | cut -c1-60))"
gray "  builds: native/computer-win/ at that commit, on windows-latest"

if [[ "$APPLY" != true ]]; then
  green "DRY-RUN. Re-run with --apply to push $TAG and trigger the release build."
  exit 0
fi

git tag -a "$TAG" -m "Windows computer-helper $VERSION" "$SHA"
git push origin "$TAG"
green "Pushed $TAG."
gray  "  Watch: gh run list --workflow computer-helper-win.yml"
gray  "  Then bump computer-win's floor in cli/src/lib/helper-versions.ts."
