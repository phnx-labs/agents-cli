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
# Unlike the keychain helper we don't pin a sha: the status-bar app is ad-hoc
# signed and rebuilt freely, so a pinned sha would false-positive on every
# rebuild. Presence + a valid signature catches the real failure mode (missing
# or corrupt bundle) without blocking routine rebuilds.
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

echo "menubar helper present and signed: $APP"
