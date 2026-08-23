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
# prepack runs at `npm pack` / `npm publish` time. That used to be macOS-only,
# but RUSH-3026 lets release-attestation-produce.sh pack the pretested tarball
# on a Linux crabbox too (seeding an already-signed bundle from the caller
# checkout when it isn't building helpers itself) — so this gate MUST hold on
# both platforms with no soft-skip, which is exactly what let 1.22.44 ship
# broken (RUSH-3031, see below).

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

  # The Accessibility (TCC) grant survives upgrades ONLY because macOS re-validates
  # each new version against the DESIGNATED REQUIREMENT stored with the grant, not
  # the exact CDHash — and this helper's requirement is identity+team based
  # (`identifier "com.phnx-labs.agents-menubar" … certificate leaf[subject.OU] =
  # "2HTP252L87"`), which every re-signed, re-notarized release still satisfies. If
  # a signing change ever produced a requirement that DIDN'T (a wrong/absent Team
  # ID, an ad-hoc signature, a CDHash-pinned DR), macOS would revoke every user's
  # grant and re-prompt them for Accessibility on the next paste. That is a
  # fleet-wide, silent, per-user regression — so pin it here and fail the release
  # rather than ship it. (macOS-only: reading the requirement needs codesign; the
  # helper is always Developer-ID signed on a Mac, which is where this must hold.)
  REQ="$(codesign -d --requirements - "$APP" 2>/dev/null || true)"
  MENUBAR_BUNDLE_ID="com.phnx-labs.agents-menubar"
  MENUBAR_TEAM_ID="2HTP252L87"
  if ! printf '%s' "$REQ" | grep -qF "identifier \"$MENUBAR_BUNDLE_ID\""; then
    echo "menubar helper designated requirement is missing the pinned bundle identifier ($MENUBAR_BUNDLE_ID): $APP" >&2
    echo "TCC keys the Accessibility grant to this requirement — a change re-prompts every user on the next paste." >&2
    echo "Requirement read: ${REQ:-<none>}" >&2
    exit 1
  fi
  if ! printf '%s' "$REQ" | grep -qF "$MENUBAR_TEAM_ID"; then
    echo "menubar helper designated requirement is missing the Developer ID team ($MENUBAR_TEAM_ID): $APP" >&2
    echo "That team is what makes the requirement stable across re-signed releases; without it every" >&2
    echo "existing Accessibility grant is invalidated and users are re-prompted. Sign with the real" >&2
    echo "Developer ID Application: … ($MENUBAR_TEAM_ID) identity: menubar/scripts/build.sh release" >&2
    echo "Requirement read: ${REQ:-<none>}" >&2
    exit 1
  fi
fi

# Require the packed executable to be a universal (fat) Mach-O binary.
# menubar/scripts/build.sh's `release` mode always lipo's arm64+x86_64
# together (a THIN single-arch build is a debug/dev artifact — see its
# comment "so a release cut on a machine without full Xcode still ships a
# TRUE universal menu-bar helper"). RUSH-3031's shipped 1.22.44 binary was
# Dev-ID signed but thin (CodeDirectory hashes=47 vs the correct universal
# build's hashes=390) — a dev slice packed in place of a real release build.
# The Mach-O fat header's magic bytes (0xCAFEBABE / 0xCAFEBABF, `lipo -create`
# always writes them big-endian) are plain bytes on disk — checkable with
# `od` on any OS, so this hard-fails on a Linux packing box too.
BIN="$APP/Contents/MacOS/MenubarHelper"
if [ ! -f "$BIN" ]; then
  echo "menubar helper executable missing inside bundle: $BIN" >&2
  exit 1
fi
if ! command -v od >/dev/null 2>&1; then
  echo "menubar helper gate cannot verify architecture: 'od' not found on PATH" >&2
  exit 1
fi
MAGIC="$(od -An -tx1 -N4 "$BIN" | tr -d ' \t\n')"
case "$MAGIC" in
  cafebabe|cafebabf)
    ;;
  *)
    echo "menubar helper is a THIN (single-arch) binary, not the universal build a release requires: $BIN (magic: 0x$MAGIC)" >&2
    echo "This is the other half of the RUSH-3031 incident (1.22.44 shipped a thin, dev-signed helper)." >&2
    echo "Rebuild it: menubar/scripts/build.sh release" >&2
    exit 1
    ;;
esac

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

echo "menubar helper present, signed, notarized, and universal: $APP"
