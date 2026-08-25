#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

REPO_ROOT="$PWD/../.."
MODE="${1:-debug}"

# Build an .icns from the master logo. Runs on macOS only (sips + iconutil).
generate_app_icon() {
    local src="$1"
    local dst="$2"
    local iconset="${dst%.icns}.iconset"
    rm -rf "$iconset" "$dst"
    mkdir -p "$iconset"
    sips -z 16 16     "$src" --out "$iconset/icon_16x16.png"     >/dev/null 2>&1
    sips -z 32 32     "$src" --out "$iconset/icon_16x16@2x.png"  >/dev/null 2>&1
    sips -z 32 32     "$src" --out "$iconset/icon_32x32.png"     >/dev/null 2>&1
    sips -z 64 64     "$src" --out "$iconset/icon_32x32@2x.png"  >/dev/null 2>&1
    sips -z 128 128   "$src" --out "$iconset/icon_128x128.png"   >/dev/null 2>&1
    sips -z 256 256   "$src" --out "$iconset/icon_128x128@2x.png" >/dev/null 2>&1
    sips -z 256 256   "$src" --out "$iconset/icon_256x256.png"   >/dev/null 2>&1
    sips -z 512 512   "$src" --out "$iconset/icon_256x256@2x.png" >/dev/null 2>&1
    sips -z 512 512   "$src" --out "$iconset/icon_512x512.png"   >/dev/null 2>&1
    sips -z 1024 1024 "$src" --out "$iconset/icon_512x512@2x.png" >/dev/null 2>&1
    iconutil -c icns "$iconset" -o "$dst"
    rm -rf "$iconset"
}

if [ "$MODE" = "release" ]; then
    # SwiftPM's `--arch arm64 --arch x86_64` routes through Xcode's xcbuild, which
    # is absent on Command-Line-Tools-only hosts. Build each slice separately via
    # --triple (works on CLT) and lipo them into one universal binary, so a
    # release cut on a machine without full Xcode still ships a TRUE universal
    # menu-bar helper (not a silent single-arch fallback that breaks Intel Macs).
    swift build -c release --triple arm64-apple-macosx14.0
    swift build -c release --triple x86_64-apple-macosx14.0
    SRC=".build/AGI Menu-universal"
    lipo -create -output "$SRC" \
        ".build/arm64-apple-macosx/release/AGI Menu" \
        ".build/x86_64-apple-macosx/release/AGI Menu"
else
    swift build
    SRC=".build/debug/AGI Menu"
fi

# Gate the artifact on the headless self-tests (single-instance flock, bounded
# children). Runs against the just-built binary, BEFORE signing/notarization, so
# a regression fails the build instead of shipping — and never wastes a notarize
# submit. These modes exit before AppKit, so they need no GUI/signing.
scripts/test-menubar.sh "$SRC"

DEST_DIR="dist"
mkdir -p "$DEST_DIR"

# Standalone binary (embedded inside a parent signed .app when shipped).
DEST="$DEST_DIR/menubar-helper-mac"
cp "$SRC" "$DEST"

# .app bundle. LSUIElement=true keeps it out of the Dock and the ⌘-Tab
# switcher — it lives only in the menu bar. The helper needs a code identity
# macOS accepts end-to-end: its clip→paste feature (Clip.swift) synthesizes a
# ⌘-V keystroke, which requires an Accessibility (TCC) grant, and macOS 26+
# SIGKILLs an unsigned/invalid binary at launch while Gatekeeper rejects an
# un-notarized one as "damaged" (which crashes AppKit during launch).
#
# So a release build is Developer-ID signed AND notarized + stapled — the same
# treatment the keychain helper gets (build-keychain-helper.sh). A Developer ID
# signature and the stapled ticket both survive npm's tarball round-trip (the
# ticket is a plain file inside the bundle), so the installed helper launches
# with NO per-machine re-signing. Notarization is MANDATORY whenever we sign
# with a real Developer ID (below); an ad-hoc dev build skips it and is caught
# by prepack (verify-menubar-helper.sh), so an un-notarized helper can't ship.
APP="$DEST_DIR/MenubarHelper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"
# The bundle FOLDER keeps its historical name (MenubarHelper.app) — release
# asset names, download URLs, and the tarball path are unaffected. Only the
# executable INSIDE it (CFBundleExecutable below) is "AGI Menu": that is the
# literal launchd execs directly and what TCC shows (RUSH-3101).
cp "$SRC" "$APP/Contents/MacOS/AGI Menu"
# Icon source is the current agents-cli mark (assets/app-icon.svg -> app-icon.png):
# the lime-tile lowercase `a` shared with the agi-cli web favicon and the menu-bar
# glyph (Icon.swift), NOT the legacy assets/logo.png gradient `A`. This drives the
# notification's app icon — both the left-hand bundle icon (CFBundleIconFile) and
# the right-hand contentImage (appIconImage in PromptPanel.swift loads AppIcon.icns).
generate_app_icon "$REPO_ROOT/assets/app-icon.png" "$APP/Contents/Resources/AppIcon.icns"
# Resolve the signing identity FIRST — it decides the bundle IDENTITY. A real
# Developer ID build carries the production id `com.phnx-labs.agents-menubar`; an
# ad-hoc dev build (no Developer ID cert) MUST NOT, because the Accessibility
# (TCC) grant is keyed to the bundle id AND validated against the Developer-ID
# code requirement stored with it. A dev build sharing the production id runs
# under that same grant with an ad-hoc signature that FAILS the stored
# requirement, so macOS revokes the shipped app's grant and re-prompts on the
# next paste — the "re-approve Accessibility on every dev build" bug. A distinct
# `.dev` id gives the dev build its own TCC entry it can never poison the real
# one from. (The production id is also the designated-requirement identity the
# release gate pins — scripts/verify-menubar-helper.sh.)
SIGN_ID="${MENUBAR_HELPER_SIGN_ID:-}"
if [ -z "$SIGN_ID" ]; then
    SIGN_ID=$(security find-identity -v -p codesigning 2>/dev/null | grep -oE '"Developer ID Application: [^"]+"' | head -1 | tr -d '"')
fi
# The invariant is: NEVER EMIT a Developer-ID-signed bundle that is not notarized.
# Two honest ways to satisfy it -- notarize it, or don't Developer-ID sign it --
# and which applies depends on whether the notary creds are present.
#
# This matters because SIGN_ID is AUTO-DETECTED from the keychain just above, so
# a plain `build.sh` on any Mac holding the cert would otherwise be obliged to
# notarize. Demanding creds unconditionally turns every local debug build on a
# signing-capable Mac into a hard failure; demanding them only in `release` mode
# is what let an un-notarized Developer-ID bundle out the door to begin with.
#
# Escape hatch for a signing box that wants a fast local build: set
# `MENUBAR_HELPER_SIGN_ID=-` to skip Developer-ID signing entirely, which takes
# the ad-hoc path below and never reaches notarization.
#
# Resolved HERE, before BUNDLE_ID is chosen and before Info.plist is written: a
# late downgrade would emit an ad-hoc bundle still carrying the PRODUCTION bundle
# id, which is precisely the Accessibility-grant poisoning the `.dev` id exists
# to prevent. A release build never reaches this branch -- it fails loud on the
# `:?` credential guards at the notarize step instead.
if [ -n "$SIGN_ID" ] && [ "$SIGN_ID" != "-" ] && [ -z "${APPLE_ID:-}" ] && [ "$MODE" != "release" ]; then
    echo "  NOTE: Developer ID identity found, but no apple.com notary creds in env." >&2
    echo "  Gatekeeper rejects a Developer-ID-signed bundle that is not notarized as" >&2
    echo "  \"damaged\", so this debug build signs AD-HOC instead (dev bundle id below)." >&2
    echo "  For a shippable bundle:  agents secrets exec apple.com -- $0 release" >&2
    SIGN_ID="-"
    _SIGN_ID_DECLINED=1
fi

BUNDLE_ID="com.phnx-labs.agents-menubar"
APP_DISPLAY_NAME="AGI Menu"
if [ -z "$SIGN_ID" ] || [ "$SIGN_ID" = "-" ]; then
    SIGN_ID="-"
    BUNDLE_ID="com.phnx-labs.agents-menubar.dev"
    APP_DISPLAY_NAME="AGI Menu (Dev)"
    # Two ways to land here: no identity in the keychain at all, or the branch
    # above deliberately dropped one for want of notary creds. Say which, rather
    # than claiming "none found" when one was found and declined.
    if [ -n "${MENUBAR_HELPER_SIGN_ID:-}" ] || [ "$SIGN_ID" = "-" ] && [ -n "${_SIGN_ID_DECLINED:-}" ]; then
        echo "  WARNING: signing ad-hoc (DEV ONLY) — see the note above." >&2
    else
        echo "  WARNING: no Developer ID identity found — signing ad-hoc (DEV ONLY)." >&2
    fi
    echo "  Using the dev bundle id ${BUNDLE_ID} so this build can never touch the" >&2
    echo "  shipped helper's Accessibility grant. An ad-hoc build cannot be notarized," >&2
    echo "  so prepack (verify-menubar-helper.sh) refuses to pack it. Sign on a host" >&2
    echo "  with the Developer ID cert + the apple.com secrets bundle to ship." >&2
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>AGI Menu</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleName</key>
    <string>${APP_DISPLAY_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${APP_DISPLAY_NAME}</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
PLIST

echo "  signing with: $SIGN_ID  (bundle id: $BUNDLE_ID)"
codesign --force --options runtime --sign "$SIGN_ID" --identifier "$BUNDLE_ID" "$APP" 2>&1 | sed 's/^/  /'
codesign --force --options runtime --sign "$SIGN_ID" --identifier "$BUNDLE_ID" "$DEST" 2>&1 | sed 's/^/  /'

# Notarize + staple — MANDATORY for a RELEASE build. Gatekeeper on macOS 26+
# rejects an un-notarized app as "damaged", so a signed-but-not-notarized helper
# is not shippable. Creds come from the `apple.com` secrets bundle — both release
# callers (release.sh, remote-sign-mac.sh) run this build under `agents secrets
# exec apple.com`, the same vars the keychain helper + CLI binary notarize with,
# so a release build fails loud here if they're missing. A debug build (local
# Swift dev) is ad-hoc signed and skips notarization; it is caught by the prepack
# gate (verify-menubar-helper.sh) so it can't ship un-notarized. Anything signed
# with a real Developer ID is notarized regardless of mode -- see the gate below.
# The gate is the SIGNATURE, not the mode. It used to be
# `[ "$MODE" = "release" ] && [ "$SIGN_ID" != "-" ]`, which meant a non-release
# invocation on a box that HAS a Developer ID produced a real Developer-ID-signed
# bundle and silently skipped notarization -- exit 0, self-tests green, and
# `spctl` reporting `rejected / source=Unnotarized Developer ID`. Gatekeeper on
# macOS 26+ rejects such a bundle as "damaged" and crashes AppKit at launch
# (RUSH-2134), so that is a shippable-looking artifact that cannot run. The three
# credential guards below also lived inside that branch, so the very check meant
# to fail loud on missing creds was itself unreachable.
#
# Now: a Developer-ID signature ALWAYS implies notarization, whatever the mode.
# An ad-hoc build (SIGN_ID="-") is the only exemption -- it cannot be notarized
# by construction, and the prepack gate (verify-menubar-helper.sh) stops it from
# shipping.
if [ "$SIGN_ID" != "-" ]; then
  : "${APPLE_ID:?notarization requires APPLE_ID (from the apple.com secrets bundle)}"
  : "${APPLE_APP_SPECIFIC_PASSWORD:?notarization requires APPLE_APP_SPECIFIC_PASSWORD (apple.com bundle)}"
  : "${APPLE_TEAM_ID:?notarization requires APPLE_TEAM_ID (apple.com bundle)}"
  NOTARIZE_ZIP="$DEST_DIR/MenubarHelper-notarize.zip"
  NOTARY_LOG="$DEST_DIR/menubar-notary.log"
  echo "  packaging $APP for notarization..."
  ditto -c -k --keepParent "$APP" "$NOTARIZE_ZIP"
  echo "  submitting for notarization (~1 min)..."
  xcrun notarytool submit "$NOTARIZE_ZIP" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait | tee "$NOTARY_LOG"
  grep -q "status: Accepted" "$NOTARY_LOG" \
    || { echo "  ERROR: menubar notarization did not report 'status: Accepted'" >&2; exit 1; }
  rm -f "$NOTARIZE_ZIP"
  echo "  stapling ticket to $APP..."
  xcrun stapler staple "$APP" 2>&1 | sed 's/^/  /'
  echo "  verifying Gatekeeper acceptance (spctl)..."
  spctl --assess --type execute "$APP" 2>&1 | sed 's/^/  /' \
    || { echo "  ERROR: spctl rejected the stapled helper — notarization incomplete" >&2; exit 1; }
fi

echo "built: $DEST"
echo "built: $APP"
