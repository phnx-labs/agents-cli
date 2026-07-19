#!/usr/bin/env bash
#
# Build + sign + notarize the macOS `agents computer` helper and publish it as a
# GitHub release asset for a tagged CLI version.
#
# WHY a script and not a GitHub Actions job (unlike the Windows helper): the mac
# helper must be Developer-ID signed AND notarized, and GitHub-hosted macOS
# runners have neither our signing identity nor the notary creds. So the asset is
# produced on a Mac that holds the identity + the `apple.com` secrets bundle
# (a dev box, or the release sign host), the same machines that already sign the
# keychain/menubar helpers and the standalone binary.
#
# The client half is apps/cli/src/lib/computer/download.ts: an npm-installed CLI
# with no local build downloads `ComputerHelper.app.zip` from
# `releases/download/v<version>/`, verifies it against the `.sha256` asset, and
# re-checks the code signature + notarization before install.
#
# Requirements (macOS): a "Developer ID Application" identity in the keychain and
# the notary creds in env — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
# APPLE_TEAM_ID. Run under the bundle so they are injected:
#
#   agents secrets exec apple.com -- apps/cli/scripts/publish-computer-helper-mac.sh [version]
#
# `version` defaults to apps/cli/package.json's version; the asset is uploaded to
# the matching `v<version>` release (created if it does not exist yet).
set -euo pipefail

CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"        # apps/cli
REPO_ROOT="$(cd "$CLI_DIR/../.." && pwd)"           # repo root
HELPER_DIR="$REPO_ROOT/native/computer-mac"
REPO_SLUG="phnx-labs/agents-cli"

log()  { printf '\033[36m[publish-mac-helper]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[publish-mac-helper] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "macOS only — the helper must be Developer-ID signed + notarized on a Mac with the identity."

VERSION="${1:-$(jq -r .version "$CLI_DIR/package.json")}"
[ -n "$VERSION" ] && [ "$VERSION" != "null" ] || die "could not resolve version (pass it as arg 1)"
TAG="v$VERSION"

command -v gh >/dev/null 2>&1 || die "gh CLI not found"
[ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] \
  || die "notary creds missing. Run under: agents secrets exec apple.com -- $0 $VERSION"

log "Building signed + notarized helper $TAG..."
( cd "$HELPER_DIR" && HELPER_VERSION="$VERSION" bash scripts/build.sh release )

ASSET_ZIP="$HELPER_DIR/dist/ComputerHelper.app.zip"
ASSET_SHA="$ASSET_ZIP.sha256"
[ -f "$ASSET_ZIP" ] || die "expected asset not produced: $ASSET_ZIP (was the build notarized?)"
[ -f "$ASSET_SHA" ] || die "expected checksum not produced: $ASSET_SHA"

# Create the release for the tag on first touch (release.sh pushes only the tag),
# then attach the assets. --clobber keeps a re-run idempotent.
if ! gh release view "$TAG" --repo "$REPO_SLUG" >/dev/null 2>&1; then
  log "Creating release $TAG..."
  gh release create "$TAG" --repo "$REPO_SLUG" --verify-tag --title "$TAG" \
    --notes "agents-cli $TAG. Assets include the macOS computer-helper .app (downloaded on demand by 'agents computer setup' / 'agents setup computer')." \
    || die "gh release create failed"
fi

log "Uploading assets to $TAG..."
gh release upload "$TAG" "$ASSET_ZIP" "$ASSET_SHA" --clobber --repo "$REPO_SLUG" \
  || die "gh release upload failed"

log "Published $(basename "$ASSET_ZIP") + .sha256 to $TAG"
