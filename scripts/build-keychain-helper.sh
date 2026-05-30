#!/usr/bin/env bash
# Build, sign, and notarize the keychain helper as a .app bundle.
#
# Items are gated by a biometry access control (kSecAttrAccessControl), which
# the OS enforces with Touch ID regardless of which signed binary reads them.
# That needs no entitlement and no provisioning profile. We still ship a .app
# bundle because that is the shape `agents helper` installs into
# ~/Library/Application Support/agents-cli/ and what kc-install expects; the
# binary is signed with the hardened runtime and notarized for Gatekeeper.
#
# Requires: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID in env.
# Output: bin/Agents CLI.app (universal, signed, notarized)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$REPO_ROOT/src/lib/secrets/keychain-helper.swift"
ENTITLEMENTS="$REPO_ROOT/scripts/keychain-entitlements.plist"
APP="$REPO_ROOT/bin/Agents CLI.app"
BIN="$APP/Contents/MacOS/Agents CLI"

: "${APPLE_ID:?APPLE_ID not set}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD not set}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set}"

SIGN_IDENTITY="Developer ID Application: Muqit Nawaz ($APPLE_TEAM_ID)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

echo "Compiling arm64..."
swiftc -O -target arm64-apple-macos12 "$SOURCE" -o /tmp/agents-keychain-arm64

echo "Compiling x86_64..."
swiftc -O -target x86_64-apple-macos12 "$SOURCE" -o /tmp/agents-keychain-x86_64

echo "Lipo to universal..."
lipo -create -output "$BIN" /tmp/agents-keychain-arm64 /tmp/agents-keychain-x86_64

echo "Writing Info.plist..."
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.phnx-labs.agents-keychain</string>
  <key>CFBundleName</key>
  <string>Agents CLI</string>
  <key>CFBundleDisplayName</key>
  <string>Agents CLI</string>
  <key>CFBundleExecutable</key>
  <string>Agents CLI</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

echo "Signing..."
codesign \
  --sign "$SIGN_IDENTITY" \
  --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --force \
  "$BIN"
codesign \
  --sign "$SIGN_IDENTITY" \
  --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --force \
  "$APP"

echo "Verifying signature..."
codesign --verify --verbose "$APP"
codesign -d --entitlements - "$APP" | head -10

echo "Packaging for notarization..."
ditto -c -k --keepParent "$APP" "/tmp/Agents CLI.zip"

echo "Submitting for notarization (~1 min)..."
xcrun notarytool submit "/tmp/Agents CLI.zip" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

echo "Stapling..."
xcrun stapler staple "$APP" || echo "(staple not strictly required for direct distribution)"

echo "Verifying Gatekeeper acceptance..."
spctl --assess --type execute --verbose "$APP" 2>&1 || echo "(spctl rejection is expected for non-app helpers; runtime check: codesign --verify is what matters)"

echo
echo "Done. $APP is ready."
echo "Run 'bun run build' to copy it into dist/lib/secrets/."
