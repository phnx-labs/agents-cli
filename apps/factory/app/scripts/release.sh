#!/bin/bash
# Release the Factory app: build, then publish artifacts to a GitHub Release.
#
# Usage: ./scripts/release.sh <version> [prerelease] [flags]
#
# Examples:
#   ./scripts/release.sh 0.1.0                 # DRY RUN — prints the plan, publishes nothing
#   ./scripts/release.sh 0.1.0 --confirm       # actually build + publish v0.1.0
#   ./scripts/release.sh 0.1.0 alpha --confirm  # publish v0.1.0-alpha (prerelease)
#   ./scripts/release.sh 0.1.0 --confirm --skip-build   # re-publish an already-built artifact
#
# Flags:
#   --confirm       Actually publish. WITHOUT it, this is a dry run (nothing mutates).
#   --skip-build    Reuse artifacts already in release/ (skip build.sh).
#   --skip-tests    Pass through to build.sh (skip the typecheck gate).
#   --platform <p>  Target platform for the build (default: host).
#
# Distribution target: GitHub Releases on the repo's origin (tag factory-v<version>).
# Idempotent: re-running uploads assets with --clobber; it never double-tags.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
error() { echo -e "${RED}Error: $1${NC}" >&2; exit 1; }
info()  { echo -e "${GREEN}$1${NC}"; }
warn()  { echo -e "${YELLOW}$1${NC}"; }

cd "$APP_DIR"

# --- args ---
VERSION="${1:-}"
PRE_TAG=""
CONFIRM="false"; SKIP_BUILD="false"; SKIP_TESTS="false"; PLATFORM=""
if [[ -n "${2:-}" && "$2" != --* ]]; then PRE_TAG="$2"; shift 2; else shift 1 || true; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm)    CONFIRM="true"; shift ;;
    --skip-build) SKIP_BUILD="true"; shift ;;
    --skip-tests) SKIP_TESTS="true"; shift ;;
    --platform)   PLATFORM="$2"; shift 2 ;;
    *) error "Unknown flag: $1" ;;
  esac
done

[[ -n "$VERSION" ]] || error "Version required. Usage: $0 <version> [alpha|beta] [--confirm]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || error "Invalid version: $VERSION (expected x.y.z)"
if [[ -n "$PRE_TAG" ]]; then
  [[ "$PRE_TAG" =~ ^(alpha|beta)(\.[0-9]+)?$ ]] || error "Invalid prerelease tag: $PRE_TAG"
  FULL_VERSION="${VERSION}-${PRE_TAG}"
else
  FULL_VERSION="$VERSION"
fi
TAG="factory-v${FULL_VERSION}"

# --- Pre-flight (cheap checks first, before the slow build) ---
command -v gh >/dev/null 2>&1 || error "gh CLI required to publish (https://cli.github.com)."
gh auth status >/dev/null 2>&1 || error "gh is not authenticated. Run: gh auth login"

# Source of truth = GitHub, not git log. Does the release already exist?
RELEASE_EXISTS="false"
if gh release view "$TAG" >/dev/null 2>&1; then RELEASE_EXISTS="true"; fi

PRERELEASE_FLAG=""
[[ -n "$PRE_TAG" ]] && PRERELEASE_FLAG="--prerelease"

echo ""
info "Release plan: Factory v${FULL_VERSION}"
echo "  tag:        ${TAG}"
echo "  target:     GitHub Release on origin${PRE_TAG:+ (prerelease)}"
BUILD_DESC="run build.sh"; [[ "$SKIP_TESTS" == "true" ]] && BUILD_DESC="run build.sh --skip-tests"
echo "  build:      $([[ "$SKIP_BUILD" == "true" ]] && echo "SKIP (reuse release/)" || echo "$BUILD_DESC")"
echo "  existing:   $([[ "$RELEASE_EXISTS" == "true" ]] && echo "release ${TAG} exists -> assets will be uploaded with --clobber" || echo "new release")"
echo ""

if [[ "$CONFIRM" != "true" ]]; then
  warn "DRY RUN — nothing published. Re-run with --confirm to build + publish."
  exit 0
fi

# --- Build ---
if [[ "$SKIP_BUILD" != "true" ]]; then
  BUILD_ARGS=("$FULL_VERSION")
  [[ -n "$PLATFORM" ]] && BUILD_ARGS+=("--platform" "$PLATFORM")
  [[ "$SKIP_TESTS" == "true" ]] && BUILD_ARGS+=("--skip-tests")
  "$SCRIPT_DIR/build.sh" "${BUILD_ARGS[@]}"
  echo ""
fi

# --- Collect artifacts ---
REL="$APP_DIR/release"
ASSETS=()
while IFS= read -r f; do ASSETS+=("$f"); done < <(find "$REL" -maxdepth 1 -type f \
  \( -name "*${FULL_VERSION}*.dmg" -o -name "*${FULL_VERSION}*.zip" -o -name "*.AppImage" -o -name "*.exe" \) 2>/dev/null)
[[ ${#ASSETS[@]} -gt 0 ]] || error "No release artifacts found in $REL for v${FULL_VERSION}. Run without --skip-build."

# Warn (do not block) on an unsigned mac artifact — GitHub Release downloads are
# manual, so Gatekeeper will warn the user rather than silently updating them.
APP_BUNDLE="$(find "$REL" -maxdepth 2 -name 'Factory.app' -type d 2>/dev/null | head -1)"
if [[ -n "$APP_BUNDLE" ]] && ! codesign -dvv "$APP_BUNDLE" 2>&1 | grep -q "Developer ID Application"; then
  warn "Publishing an UNSIGNED macOS build — users will see a Gatekeeper warning on first launch."
fi

# --- Publish (idempotent) ---
info "Publishing ${#ASSETS[@]} artifact(s) to GitHub Release ${TAG}..."
if [[ "$RELEASE_EXISTS" == "true" ]]; then
  gh release upload "$TAG" "${ASSETS[@]}" --clobber
else
  gh release create "$TAG" "${ASSETS[@]}" \
    --title "Factory v${FULL_VERSION}" \
    --notes "Standalone Factory work-stream app, v${FULL_VERSION}." \
    $PRERELEASE_FLAG
fi

echo ""
info "Released Factory v${FULL_VERSION}: $(gh release view "$TAG" --json url -q .url 2>/dev/null || echo "$TAG")"
