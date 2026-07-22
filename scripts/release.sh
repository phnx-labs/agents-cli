#!/usr/bin/env bash
# Release agents-dbg: build, sign/notarize when credentials are present, upload
# GitHub release assets, and update the Homebrew tap.
#
# Usage: scripts/release.sh <version> [flags]
#
# Examples:
#   scripts/release.sh 0.1.0                         # dry run
#   scripts/release.sh 0.1.0 --confirm               # build + publish + tap
#   scripts/release.sh 0.1.0 --confirm --skip-build  # reuse release artifacts
#
# Flags:
#   --confirm              Actually publish. Without it, this is a dry run.
#   --skip-build           Reuse existing apps/factory/app/release artifacts.
#   --skip-tests           Pass through to the build script.
#   --arch <arch>          macOS arch: arm64, x64, universal (default: universal).
#   --tap-repo <path>      Existing homebrew tap checkout.
#   --skip-tap             Do not update the homebrew tap.
#   --no-push-tap          Write tap files but do not commit/push them.
#
# Distribution target: GitHub Releases on origin (tag agents-dbg-v<version>) and
# muqsitnawaz/tap via scripts/bottle.sh. Idempotent asset uploads use --clobber.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/apps/factory/app"

die() { echo "Error: $1" >&2; exit 1; }
info() { echo "$1"; }
warn() { echo "Warning: $1" >&2; }

VERSION=""
CONFIRM=0
SKIP_BUILD=0
SKIP_TESTS=0
SKIP_TAP=0
PUSH_TAP=1
ARCH="universal"
TAP_REPO="${HOMEBREW_TAP_REPO:-}"

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm) CONFIRM=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --skip-tap) SKIP_TAP=1; shift ;;
    --no-push-tap) PUSH_TAP=0; shift ;;
    --arch) ARCH="${2:-}"; [[ -n "$ARCH" ]] || die "--arch requires a value"; shift 2 ;;
    --tap-repo) TAP_REPO="${2:-}"; [[ -n "$TAP_REPO" ]] || die "--tap-repo requires a path"; shift 2 ;;
    -h|--help) usage 0 ;;
    --*) die "unknown flag: $1" ;;
    *)
      [[ -z "$VERSION" ]] || die "unexpected arg: $1"
      VERSION="$1"
      shift
      ;;
  esac
done

[[ -n "$VERSION" ]] || usage 1
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be X.Y.Z (got: $VERSION)"
case "$ARCH" in arm64|x64|universal) ;; *) die "invalid arch: $ARCH" ;; esac

TAG="agents-dbg-v${VERSION}"
REPO="${GITHUB_REPOSITORY:-phnx-labs/agents-cli}"
ZIP_NAME="agents-dbg-${VERSION}-${ARCH}.zip"
DMG_NAME="agents-dbg-${VERSION}-${ARCH}.dmg"
ZIP_PATH="$APP_DIR/release/$ZIP_NAME"
DMG_PATH="$APP_DIR/release/$DMG_NAME"
INSTALL_URL="https://raw.githubusercontent.com/${REPO}/main/scripts/install-agents-dbg.sh"

if [[ $CONFIRM -eq 1 ]]; then
  command -v gh >/dev/null 2>&1 || die "gh CLI required"
  gh auth status >/dev/null 2>&1 || die "gh is not authenticated"
  [[ "$(uname -s)" == "Darwin" ]] || die "--confirm must run on macOS so codesign/notarytool/spctl can verify the app"
fi

RELEASE_EXISTS=0
if command -v gh >/dev/null 2>&1 && gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  RELEASE_EXISTS=1
fi

echo "Release plan"
echo "  app:        agents-dbg"
echo "  version:    $VERSION"
echo "  tag:        $TAG"
echo "  repo:       $REPO"
echo "  arch:       $ARCH"
echo "  build:      $([[ $SKIP_BUILD -eq 1 ]] && echo "skip" || echo "run apps/factory/app/scripts/build.sh")"
echo "  release:    $([[ $RELEASE_EXISTS -eq 1 ]] && echo "exists, upload with --clobber" || echo "create")"
echo "  tap:        $([[ $SKIP_TAP -eq 1 ]] && echo "skip" || echo "update muqsitnawaz/tap")"
echo "  installer:  curl -fsSL $INSTALL_URL | sh"
echo

if [[ $CONFIRM -eq 0 ]]; then
  warn "DRY RUN: no build, GitHub release, or tap mutation. Re-run with --confirm to publish."
  exit 0
fi

if [[ $SKIP_BUILD -eq 0 ]]; then
  BUILD_ARGS=("$VERSION" --platform mac --arch "$ARCH")
  [[ $SKIP_TESTS -eq 1 ]] && BUILD_ARGS+=(--skip-tests)
  bash "$APP_DIR/scripts/build.sh" "${BUILD_ARGS[@]}"
fi

[[ -f "$ZIP_PATH" ]] || die "missing zip artifact: $ZIP_PATH"
[[ -f "$DMG_PATH" ]] || die "missing dmg artifact: $DMG_PATH"

APP_BUNDLE=""
shopt -s nullglob
APP_CANDIDATES=("$APP_DIR"/release/mac*/agents-dbg.app "$APP_DIR"/release/agents-dbg.app)
shopt -u nullglob
APP_BUNDLE="${APP_CANDIDATES[0]:-}"
[[ -n "$APP_BUNDLE" ]] || die "agents-dbg.app not found under $APP_DIR/release"

BUILT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP_BUNDLE/Contents/Info.plist")"
[[ "$BUILT_VERSION" == "$VERSION" ]] || die "bundle version $BUILT_VERSION != $VERSION"

SIGNING_AVAILABLE=0
if [[ -n "${CSC_NAME:-}${CSC_LINK:-}" ]]; then
  SIGNING_AVAILABLE=1
fi

NOTARIZE_AVAILABLE=0
if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  NOTARIZE_AVAILABLE=1
fi

if [[ $SIGNING_AVAILABLE -eq 0 ]]; then
  warn "Apple signing credentials (CSC_NAME/CSC_LINK) not present; skipping codesign/spctl verification. The published app will be unsigned."
else
  SIGNATURE="$(codesign -dvv "$APP_BUNDLE" 2>&1 || true)"
  if echo "$SIGNATURE" | grep -q "Developer ID Application"; then
    echo "$SIGNATURE" | grep -m1 "Authority=" | sed 's/^/signed: /'
    if [[ $NOTARIZE_AVAILABLE -eq 1 ]]; then
      SPCTL_OUT="$(spctl --assess --type execute -vv "$APP_BUNDLE" 2>&1)"
      echo "$SPCTL_OUT" | sed 's/^/spctl: /'
      echo "$SPCTL_OUT" | grep -Eq "accepted|source=Notarized Developer ID" || die "spctl did not accept the notarized app"
    else
      warn "Notarization credentials (APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID) not present; skipping spctl verification."
    fi
  else
    die "agents-dbg.app is not signed with Developer ID Application"
  fi
fi

ZIP_SHA="$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')"
DMG_SHA="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
printf '%s  %s\n' "$ZIP_SHA" "$ZIP_NAME" > "$ZIP_PATH.sha256"
printf '%s  %s\n' "$DMG_SHA" "$DMG_NAME" > "$DMG_PATH.sha256"
ZIP_SHA="$(awk '{print $1}' "$ZIP_PATH.sha256")"

if [[ $RELEASE_EXISTS -eq 1 ]]; then
  gh release upload "$TAG" "$ZIP_PATH" "$ZIP_PATH.sha256" "$DMG_PATH" "$DMG_PATH.sha256" --clobber --repo "$REPO"
else
  gh release create "$TAG" "$ZIP_PATH" "$ZIP_PATH.sha256" "$DMG_PATH" "$DMG_PATH.sha256" \
    --repo "$REPO" \
    --title "agents-dbg v${VERSION}" \
    --notes "Private install-only agents-dbg Mac app, v${VERSION}. Install: curl -fsSL ${INSTALL_URL} | sh"
fi

if [[ $SKIP_TAP -eq 0 ]]; then
  TAP_ARGS=("$VERSION" --sha256 "$ZIP_SHA" --asset "$ZIP_NAME" --repo "$REPO" --confirm)
  [[ -n "$TAP_REPO" ]] && TAP_ARGS+=(--tap-repo "$TAP_REPO")
  [[ $PUSH_TAP -eq 1 ]] && TAP_ARGS+=(--push)
  bash "$ROOT/scripts/bottle.sh" "${TAP_ARGS[@]}"
fi

echo
echo "Released agents-dbg v${VERSION}"
echo "  release: https://github.com/${REPO}/releases/tag/${TAG}"
echo "  install: curl -fsSL ${INSTALL_URL} | sh"
