#!/usr/bin/env bash
#
# Build + sign + notarize the macOS `agents computer` helper and publish it as a
# GitHub release asset on the helper's OWN tag, `computer-mac/v<x.y.z>`.
#
# It used to publish to the CLI's `v<version>` tag, which broke the moment the
# client was repointed at per-helper tags (RUSH-3100): `download.ts` resolves
# `computer-mac/v<x.y.z>` from the floor in cli/src/lib/helper-versions.ts, so a
# helper uploaded to `v1.22.49` sat at an address nothing ever requests. That
# left NO path to cut a new computer-mac release at all (PHNX-3228). This is now
# the symmetric counterpart of publish-computer-win.sh: one script per helper,
# each cutting that helper's own tag, versioned independently of the CLI.
#
# WHY a script and not a GitHub Actions job (unlike the Windows helper): the mac
# helper must be Developer-ID signed AND notarized, and GitHub-hosted macOS
# runners have neither our signing identity nor the notary creds. So the asset is
# produced on a Mac that holds the identity + the `apple.com` secrets bundle
# (a dev box, or the release sign host), the same machines that already sign the
# keychain/menubar helpers and the standalone binary.
#
# The client half is cli/src/lib/computer/download.ts: an npm-installed CLI
# with no local build downloads `ComputerHelper.app.zip` from
# `releases/download/v<version>/`, verifies it against the `.sha256` asset, and
# re-checks the code signature + notarization before install.
#
# Requirements (macOS): a "Developer ID Application" identity in the keychain and
# the notary creds in env — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
# APPLE_TEAM_ID. Run under the bundle so they are injected:
#
#   agents secrets exec apple.com -- cli/scripts/publish-computer-helper-mac.sh <x.y.z>
#
# That invocation injects the NOTARY creds but does not unlock the Developer ID
# SIGNING keychain, so on a headless run codesign used to die with
# errSecInternalComponent (RUSH-2970 trap 3) — the operator had to know to source
# headless-sign-context.sh first, which nothing said. This script now sources it
# itself, so the documented invocation above is sufficient. On a Mac that is not
# the release home base the context is a no-op (it is guarded on its pass files),
# and an interactive run signs with the usual Touch ID prompt as before.
#
# `version` is the HELPER's version and is required — it is deliberately NOT
# defaulted from cli/package.json, because the helper no longer shares the CLI's
# version line. After publishing, bump `computer-mac`'s floor in
# cli/src/lib/helper-versions.ts: the tag makes the build downloadable, the floor
# is what makes a CLI ask for it.
set -euo pipefail

CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"        # cli
REPO_ROOT="$(cd "$CLI_DIR/.." && pwd)"              # repo root
HELPER_DIR="$REPO_ROOT/native/computer-mac"
REPO_SLUG="phnx-labs/agents-cli"

log()  { printf '\033[36m[publish-mac-helper]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[publish-mac-helper] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "macOS only — the helper must be Developer-ID signed + notarized on a Mac with the identity."

VERSION="${1:-}"
[ -n "$VERSION" ] || die "usage: $(basename "$0") <x.y.z>   (the helper's own version, not the CLI's)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "version must be bare X.Y.Z (the tag prefix is added for you), got: $VERSION"
TAG="computer-mac/v$VERSION"

command -v gh >/dev/null 2>&1 || die "gh CLI not found"

# Helper releases are immutable: the upload below uses --clobber, so re-cutting an
# existing tag would silently replace a binary an installed CLI already pins to
# that exact version.
#
# ORIGIN is the source of truth for "published", not the local ref. A local-only
# tag means an earlier run of THIS script tagged and then failed before or during
# the push -- nothing was published, so refusing it would tell the operator to
# burn a version number over a transient network error, and (because this guard
# runs before the build) would make that version permanently uncuttable from this
# checkout without a manual `git tag -d`. Resume instead; the push below retries.
# What makes a version un-recuttable is a PUBLISHED RELEASE, not a tag. The asset
# is what an installed CLI downloads, so the GitHub release is the thing that
# must never be replaced -- the upload below uses --clobber and would overwrite a
# binary someone already pins.
#
# A tag without a release is an INTERRUPTED run, in either of two ways, and both
# must resume rather than burn the version:
#   - tagged locally, push failed        -> push retries below
#   - tag pushed, release/upload failed  -> tag push is a no-op, release created
# Treating the tag as the signal made both permanently uncuttable from that
# checkout, over a transient network error, with nothing ever published.
if gh release view "$TAG" --repo "$REPO_SLUG" >/dev/null 2>&1; then
  die "$TAG is already published. Helper releases are immutable -- cut the next patch instead."
fi
if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1 \
  || git -C "$REPO_ROOT" ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  log "$TAG is tagged but has no release -- resuming an interrupted publish."
fi
[ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] \
  || die "notary creds missing. Run under: agents secrets exec apple.com -- $0 $VERSION"

# Unlock the Developer ID signing keychain and authorize codesign to use the key
# non-interactively. Idempotent, and a no-op on a Mac without the pass files.
# shellcheck source=scripts/headless-sign-context.sh
. "$CLI_DIR/scripts/headless-sign-context.sh"

log "Building signed + notarized helper $TAG..."
( cd "$HELPER_DIR" && HELPER_VERSION="$VERSION" bash scripts/build.sh release )

ASSET_ZIP="$HELPER_DIR/dist/ComputerHelper.app.zip"
ASSET_SHA="$ASSET_ZIP.sha256"
[ -f "$ASSET_ZIP" ] || die "expected asset not produced: $ASSET_ZIP (was the build notarized?)"
[ -f "$ASSET_SHA" ] || die "expected checksum not produced: $ASSET_SHA"

# Cut the tag, THEN the release. `gh release create --verify-tag` refuses to
# invent a tag that does not exist on the remote, and nothing else pushes
# `computer-mac/v<x.y.z>`: release.sh delegates helper tagging to "where the
# helper is released", which is here. Without this the whole script ran green
# through build + notarize and then died at the release step, so the practical
# effect was that no new computer-mac version could be cut at all.
#
# Deliberately AFTER the build: a tag pushed before a failed notarization is a
# published address with nothing behind it, and helper tags are immutable so it
# could not be reused. The tag is annotated and pinned to the exact commit whose
# native/computer-mac/ produced the asset above.
SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if ! git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  log "Tagging $TAG at ${SHA:0:12}..."
  git -C "$REPO_ROOT" tag -a "$TAG" -m "macOS computer-helper $VERSION" "$SHA" \
    || die "git tag failed"
fi
git -C "$REPO_ROOT" push origin "$TAG" || die "git push of $TAG failed"

# Create the release for the tag on first touch, then attach the assets.
# --clobber keeps a re-run idempotent.
if ! gh release view "$TAG" --repo "$REPO_SLUG" >/dev/null 2>&1; then
  log "Creating release $TAG..."
  gh release create "$TAG" --repo "$REPO_SLUG" --verify-tag --title "$TAG" \
    --notes "macOS computer-helper $VERSION. Downloaded on demand by 'agents computer setup' / 'agents setup computer'; resolved from the computer-mac floor in cli/src/lib/helper-versions.ts." \
    || die "gh release create failed"
fi

log "Uploading assets to $TAG..."
gh release upload "$TAG" "$ASSET_ZIP" "$ASSET_SHA" --clobber --repo "$REPO_SLUG" \
  || die "gh release upload failed"

log "Published $(basename "$ASSET_ZIP") + .sha256 to $TAG"
