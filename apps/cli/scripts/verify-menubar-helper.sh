#!/usr/bin/env bash
#
# prepack gate for the macOS menu-bar helper.
#
# The npm `build` script copies bin/MenubarHelper.app into dist only when the
# bundle is present:  [ -d 'bin/MenubarHelper.app' ] && cp -R ... || true
# That `|| true` means a release run WITHOUT the staged app silently ships the
# menubar CODE but no .app — and on every user machine `agents menubar enable`
# then reports "no bundle ships" and the auto-enable no-ops. 1.20.22 shipped
# exactly this way. This gate fails the pack so it can't happen again.
#
# Unlike the keychain helper we don't pin a sha: the app is rebuilt freely, so a
# pinned sha would false-positive on every rebuild. Presence + a valid signature
# + a stapled notarization ticket catches the real failure modes (a missing or
# corrupt bundle, or an un-notarized cut Gatekeeper rejects as "damaged") without
# blocking routine rebuilds.
#
# prepack only runs at `npm pack` / `npm publish` time, which is macOS-only
# (releases are cut locally on macOS — see CLAUDE.md), so requiring the bundle
# here does not affect Linux CI, which never packs.

set -euo pipefail

cd "$(dirname "$0")/.."

APP="bin/MenubarHelper.app"

if [ ! -d "$APP" ]; then
  echo "menubar helper missing: $APP not found" >&2
  echo "Build and stage it before releasing:" >&2
  echo "  menubar/scripts/build.sh release" >&2
  echo "  cp -R menubar/dist/MenubarHelper.app bin/MenubarHelper.app" >&2
  exit 1
fi

if command -v codesign >/dev/null 2>&1; then
  if ! codesign --verify --deep --strict "$APP" 2>/dev/null; then
    echo "menubar helper failed codesign --verify --deep --strict: $APP" >&2
    echo "Rebuild it: menubar/scripts/build.sh release" >&2
    exit 1
  fi
fi

# Require a stapled notarization ticket. build.sh notarizes + staples every
# Developer-ID build; the ticket is a file inside the bundle, so it survives npm.
# Refuse to pack an un-notarized helper — Gatekeeper rejects it as "damaged" on
# macOS 26+, and the install path has no re-sign fallback to paper over it.
if command -v xcrun >/dev/null 2>&1; then
  if ! xcrun stapler validate "$APP" >/dev/null 2>&1; then
    echo "menubar helper is not notarized/stapled: $APP" >&2
    echo "Rebuild it with Developer ID + apple.com creds so it notarizes:" >&2
    echo "  agents secrets exec apple.com -- menubar/scripts/build.sh release" >&2
    exit 1
  fi
fi

echo "menubar helper present, signed, and notarized: $APP"
