#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="${1:-debug}"

# Stamp the shipping CLI version into the bundle so `agents computer setup` can
# tell an installed helper apart by version (the release job sets this to match
# the tag). Defaults to a dev placeholder.
HELPER_VERSION="${HELPER_VERSION:-0.1.0}"

if [ "$MODE" = "release" ]; then
    # Universal build WITHOUT full Xcode. SwiftPM's `--arch arm64 --arch x86_64`
    # routes through Xcode's xcbuild, which is absent on Command-Line-Tools-only
    # hosts (`swift build --arch ...` → "xcbuild ... does not exist"). Build each
    # slice separately via --triple (works on CLT) and lipo them into one binary,
    # so the signed/notarized release asset can be produced on any Mac with the
    # toolchain + signing identity, not only ones with Xcode installed.
    swift build -c release --triple arm64-apple-macosx14.0
    swift build -c release --triple x86_64-apple-macosx14.0
    SRC=".build/ComputerHelper-universal"
    lipo -create -output "$SRC" \
        ".build/arm64-apple-macosx/release/ComputerHelper" \
        ".build/x86_64-apple-macosx/release/ComputerHelper"
else
    swift build
    SRC=".build/debug/ComputerHelper"
fi

DEST_DIR="dist"
mkdir -p "$DEST_DIR"

# Standalone binary (used when embedded inside a parent signed .app bundle
# that provides TCC identity).
DEST="$DEST_DIR/computer-helper-mac"
cp "$SRC" "$DEST"

# For standalone / dev invocation, also produce a .app bundle. Running the
# helper as `ComputerHelper.app/Contents/MacOS/ComputerHelper` gives it
# first-class TCC identity (bundle id + Info.plist) instead of inheriting
# from whichever shell launched it. Without this, Accessibility grants on
# the bare binary are overridden by the launching process's context.
APP="$DEST_DIR/ComputerHelper.app"
# Always start from scratch. In-place rebuilds leave stale _CodeSignature/
# and provenance xattrs that produce half-signed bundles; if Gatekeeper
# then rejects a `open -a` against this, lsd queues failed assessments
# until the whole system can't launch new apps (Activity Monitor, Messages).
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$SRC" "$APP/Contents/MacOS/ComputerHelper"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>ComputerHelper</string>
    <key>CFBundleIdentifier</key>
    <string>com.phnx-labs.computer-helper</string>
    <key>CFBundleName</key>
    <string>Computer Helper</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${HELPER_VERSION}</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
PLIST
# Pick a code signing identity. TCC on macOS 15+ silently refuses
# Accessibility/Screen Recording grants on ad-hoc signed binaries — even
# when the System Settings toggle appears on. Developer ID signing keys
# the TCC grant by Team ID, which is stable across rebuilds.
SIGN_ID="${COMPUTER_HELPER_SIGN_ID:-}"
if [ -z "$SIGN_ID" ]; then
    SIGN_ID=$(security find-identity -v -p codesigning 2>/dev/null | grep -oE '"Developer ID Application: [^"]+"' | head -1 | tr -d '"')
fi
if [ -z "$SIGN_ID" ]; then
    echo "  WARNING: no Developer ID cert — falling back to ad-hoc (TCC grants will not apply)"
    SIGN_ID="-"
fi
echo "  signing with: $SIGN_ID"
codesign --force --deep --options runtime --sign "$SIGN_ID" --identifier com.phnx-labs.computer-helper "$APP" 2>&1 | sed 's/^/  /'
codesign --force --options runtime --sign "$SIGN_ID" --identifier com.phnx-labs.computer-helper "$DEST" 2>&1 | sed 's/^/  /'

echo "built: $DEST"
echo "built: $APP"

# Notarize the .app bundle. Without this, Gatekeeper on macOS 15 refuses
# Launch Services launches of the helper (`open -a`), which is the TCC path
# agents need to use when the launching app's responsibility chain is non-granted.
# Direct exec bypasses Gatekeeper but inherits parent-shell TCC (denied when
# the parent isn't granted). Notarization = one source of truth.
#
# Skips if APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID are unset —
# local dev builds from a TCC-granted shell still work via direct exec.
if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
    echo "  skipping notarization (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set)"
    echo "  to enable: export APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID and rerun"
    exit 0
fi

# Skip notarization for ad-hoc signed builds (Apple requires Developer ID).
if [ "$SIGN_ID" = "-" ]; then
    echo "  skipping notarization (ad-hoc signed — Apple requires Developer ID)"
    exit 0
fi

echo "=== notarize ==="
SUBMIT_ZIP="$(mktemp -t ch-notarize).zip"
trap 'rm -f "$SUBMIT_ZIP"' EXIT

# notarytool requires a flat container — ditto preserves the signed .app.
ditto -c -k --keepParent "$APP" "$SUBMIT_ZIP"

echo "  submitting $APP to Apple (this takes 30s-2min)..."
NOTARIZE_OUTPUT=$(xcrun notarytool submit "$SUBMIT_ZIP" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait 2>&1)
echo "$NOTARIZE_OUTPUT" | sed 's/^/  /'

if ! echo "$NOTARIZE_OUTPUT" | grep -q "status: Accepted"; then
    echo "  ERROR: notarization did not return Accepted"
    SUBMISSION_ID=$(echo "$NOTARIZE_OUTPUT" | awk '/id:/ {print $2; exit}')
    if [ -n "$SUBMISSION_ID" ]; then
        echo "  fetching log for submission $SUBMISSION_ID..."
        xcrun notarytool log "$SUBMISSION_ID" \
            --apple-id "$APPLE_ID" \
            --password "$APPLE_APP_SPECIFIC_PASSWORD" \
            --team-id "$APPLE_TEAM_ID" 2>&1 | sed 's/^/    /'
    fi
    exit 1
fi

echo "  stapling ticket to $APP..."
xcrun stapler staple "$APP" 2>&1 | sed 's/^/  /'

echo "  verifying Gatekeeper assessment..."
spctl --assess --verbose "$APP" 2>&1 | sed 's/^/  /'

echo "notarized: $APP"

# Emit the release artifact: a zip of the STAPLED .app plus its sha256, ready to
# publish as a GitHub release asset. `agents computer setup` downloads this,
# verifies the sha256, extracts it, and re-verifies the signature/notarization
# before install (apps/cli/src/lib/computer/download.ts).
ASSET_ZIP="$DEST_DIR/ComputerHelper.app.zip"
rm -f "$ASSET_ZIP" "$ASSET_ZIP.sha256"
ditto -c -k --keepParent "$APP" "$ASSET_ZIP"
# sha256sum-format line: "<hex>  ComputerHelper.app.zip" (parsed in download.ts).
( cd "$DEST_DIR" && shasum -a 256 "ComputerHelper.app.zip" > "ComputerHelper.app.zip.sha256" )
echo "asset:     $ASSET_ZIP"
echo "asset sha: $ASSET_ZIP.sha256"
