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
else
  # No xcrun (a Linux producer, RUSH-3026). `stapler staple` writes the ticket
  # as a plain file at Contents/CodeResources, so its ABSENCE is provable
  # anywhere -- and exactly what let 1.22.44 ship an un-stapled helper that
  # Gatekeeper rejected on every Mac ("not notarized/valid; skipping launch"),
  # killing the menu bar. Presence is weaker than `stapler validate` (it cannot
  # prove the ticket matches this binary), but it turns the observed failure --
  # a dev bundle with no ticket at all -- into a hard pack error instead of a
  # shipped regression.
  if [ ! -f "$APP/Contents/CodeResources" ]; then
    echo "menubar helper has NO stapled notarization ticket (Contents/CodeResources missing): $APP" >&2
    echo "This is what shipped broken in 1.22.44 -- Gatekeeper rejects the bundle on every Mac." >&2
    echo "Seed a notarized bundle (e.g. from the last good published tarball's dist/lib/menubar/)," >&2
    echo "or rebuild on a Mac: agents secrets exec apple.com -- menubar/scripts/build.sh release" >&2
    exit 1
  fi
fi

echo "menubar helper present, signed, and notarized: $APP"
