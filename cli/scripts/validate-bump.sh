#!/usr/bin/env bash
#
# Decide whether a target version is an acceptable next release, and say which
# KIND of bump it is.
#
# Extracted from release.sh so the arithmetic can be tested directly: it is pure
# (four version strings in, one word out) while release.sh needs a clean main, a
# logged-in npm, and gh auth before it reaches this point. See
# scripts/validate-bump.test.ts.
#
# usage: validate-bump.sh <published-latest> <package-json-version> <shim-latest> <target>
#
# On success prints the bump kind to stdout and exits 0:
#   patch | minor | major        a single step from the PUBLISHED latest
#   shim-catchup                 target == published latest, republishing the
#                                frozen @companion shim which is still behind
#   phnx-catchup                 target == the version main already carries,
#                                when main is ahead of the registry
#   patch-from-main              the next patch AFTER an unpublishable main (see
#                                below)
#
# On failure prints the accepted versions to stderr and exits 1.
#
# Why patch-from-main exists: release.sh refuses to publish a merged release PR
# whose squash pulled in concurrent main commits, because the tree that would
# ship is no longer the tree CI tested. Its refusal advises cutting the next
# patch through the normal release PR flow — but patch+1 is measured from the
# REGISTRY, so with main at 1.20.75 and npm at 1.20.74 both 1.20.75 (blocked by
# that guard) and 1.20.76 (a skipped version) were rejected, leaving no
# patch-level path forward. This opens exactly that one step, and only while
# package.json is strictly ahead of the registry. It is not a bypass: the
# resulting release still earns its own release PR, full cross-platform matrix,
# merge, tag and publish against the exact tree being shipped.

set -euo pipefail

[[ $# -eq 4 ]] || { echo "usage: validate-bump.sh <published> <pkg-json> <shim> <target>" >&2; exit 2; }

PHNX_LATEST="$1"
PKG_JSON_VERSION="$2"
SWARMIFY_LATEST="$3"
TARGET="$4"

parse_v() { echo "$1" | tr '.' ' '; }
read -r CMAJ CMIN CPAT <<< "$(parse_v "$PHNX_LATEST")"
read -r PMAJ PMIN PPAT <<< "$(parse_v "$PKG_JSON_VERSION")"
read -r SMAJ SMIN SPAT <<< "$(parse_v "$SWARMIFY_LATEST")"
read -r TMAJ TMIN TPAT <<< "$(parse_v "$TARGET")"

# Strictly-newer semver-triple compare: is $1.$2.$3 above $4.$5.$6?
newer_than() {
  [[ $1 -gt $4 ]] && return 0
  [[ $1 -eq $4 && $2 -gt $5 ]] && return 0
  [[ $1 -eq $4 && $2 -eq $5 && $3 -gt $6 ]] && return 0
  return 1
}

BUMP=""
if [[ $TMAJ -eq $CMAJ && $TMIN -eq $CMIN && $TPAT -eq $((CPAT + 1)) ]]; then
  BUMP="patch"
elif [[ $TMAJ -eq $CMAJ && $TMIN -eq $((CMIN + 1)) && $TPAT -eq 0 ]]; then
  BUMP="minor"
elif [[ $TMAJ -eq $((CMAJ + 1)) && $TMIN -eq 0 && $TPAT -eq 0 ]]; then
  BUMP="major"
elif [[ "$TARGET" == "$PHNX_LATEST" ]] && newer_than "$TMAJ" "$TMIN" "$TPAT" "$SMAJ" "$SMIN" "$SPAT"; then
  # Shim catch-up rerun after a partial publish: @phnx is already at target and
  # only the frozen @companion shim is behind.
  BUMP="shim-catchup"
elif [[ "$TARGET" == "$PKG_JSON_VERSION" ]] && newer_than "$PMAJ" "$PMIN" "$PPAT" "$CMAJ" "$CMIN" "$CPAT"; then
  # Main accumulated unpublished chore(release) bumps. Publish what main says.
  BUMP="phnx-catchup"
elif [[ $TMAJ -eq $PMAJ && $TMIN -eq $PMIN && $TPAT -eq $((PPAT + 1)) ]] \
     && newer_than "$PMAJ" "$PMIN" "$PPAT" "$CMAJ" "$CMIN" "$CPAT"; then
  BUMP="patch-from-main"
fi

if [[ -n "$BUMP" ]]; then
  echo "$BUMP"
  exit 0
fi

{
  echo "invalid bump: $PHNX_LATEST -> $TARGET"
  echo "expected one of:"
  echo "  $CMAJ.$CMIN.$((CPAT + 1))   (patch)"
  echo "  $CMAJ.$((CMIN + 1)).0   (minor)"
  echo "  $((CMAJ + 1)).0.0   (major)"
  # Only advertise the main-ahead options when main actually IS ahead, so the
  # script never tells an operator to run a version it would then reject.
  if newer_than "$PMAJ" "$PMIN" "$PPAT" "$CMAJ" "$CMIN" "$CPAT"; then
    echo "  $PKG_JSON_VERSION   (phnx-catchup: package.json is ahead of registry)"
    echo "  $PMAJ.$PMIN.$((PPAT + 1))   (patch-from-main: the next patch after an unpublishable main)"
  fi
} >&2
exit 1
