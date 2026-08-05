#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

REPO_ROOT="$PWD/../../.."
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
    SRC=".build/MenubarHelper-universal"
    lipo -create -output "$SRC" \
        ".build/arm64-apple-macosx/release/MenubarHelper" \
        ".build/x86_64-apple-macosx/release/MenubarHelper"
else
    swift build
    SRC=".build/debug/MenubarHelper"
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
cp "$SRC" "$APP/Contents/MacOS/MenubarHelper"
# Icon source is the current agents-cli mark (assets/app-icon.svg -> app-icon.png):
# the lime-tile lowercase `a` shared with the agi-cli web favicon and the menu-bar
# glyph (Icon.swift), NOT the legacy assets/logo.png gradient `A`. This drives the
# notification's app icon — both the left-hand bundle icon (CFBundleIconFile) and
# the right-hand contentImage (appIconImage in PromptPanel.swift loads AppIcon.icns).
generate_app_icon "$REPO_ROOT/assets/app-icon.png" "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>MenubarHelper</string>
    <key>CFBundleIdentifier</key>
    <string>com.phnx-labs.agents-menubar</string>
    <key>CFBundleName</key>
    <string>AGI Menu</string>
    <key>CFBundleDisplayName</key>
    <string>AGI Menu</string>
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

SIGN_ID="${MENUBAR_HELPER_SIGN_ID:-}"
if [ -z "$SIGN_ID" ]; then
    SIGN_ID=$(security find-identity -v -p codesigning 2>/dev/null | grep -oE '"Developer ID Application: [^"]+"' | head -1 | tr -d '"')
fi
if [ -z "$SIGN_ID" ]; then
    SIGN_ID="-"
    echo "  WARNING: no Developer ID identity found — signing ad-hoc (DEV ONLY)." >&2
    echo "  An ad-hoc build cannot be notarized, so prepack (verify-menubar-helper.sh)" >&2
    echo "  refuses to pack it. Sign on a host with the Developer ID cert + the" >&2
    echo "  apple.com secrets bundle to produce a shippable, notarized helper." >&2
fi
echo "  signing with: $SIGN_ID"
codesign --force --options runtime --sign "$SIGN_ID" --identifier com.phnx-labs.agents-menubar "$APP" 2>&1 | sed 's/^/  /'
codesign --force --options runtime --sign "$SIGN_ID" --identifier com.phnx-labs.agents-menubar "$DEST" 2>&1 | sed 's/^/  /'

# Notarize + staple — MANDATORY for a RELEASE build. Gatekeeper on macOS 26+
# rejects an un-notarized app as "damaged", so a signed-but-not-notarized helper
# is not shippable. Creds come from the `apple.com` secrets bundle — both release
# callers (release.sh, remote-sign-mac.sh) run this build under `agents secrets
# exec apple.com`, the same vars the keychain helper + CLI binary notarize with,
# so a release build fails loud here if they're missing. A debug build (local
# Swift dev) skips notarization and never ships; an ad-hoc release (SIGN_ID="-",
# no Developer ID) skips too and is caught by the prepack gate
# (verify-menubar-helper.sh) so it can't ship un-notarized.
if [ "$MODE" = "release" ] && [ "$SIGN_ID" != "-" ]; then
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
