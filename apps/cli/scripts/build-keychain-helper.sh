#!/usr/bin/env bash
# Build, sign, and notarize the keychain helper as a .app bundle.
#
# macOS 26 (Tahoe) tightened the data-protection keychain daemon (secd):
# writes from a signed binary now require keychain-access-groups entitlement
# + matching embedded provisioning profile. Without them, SecItemAdd fails
# with OSStatus -34018 (errSecMissingEntitlement). The biometry ACL alone
# does NOT satisfy this — it's an additive policy on top of the access-group
# check, not a replacement. Strip either piece and writes break.
#
# Requires: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID in env;
#           bin/embedded.provisionprofile checked into the repo.
# Output: bin/Agents CLI.app (universal, signed, notarized)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$REPO_ROOT/src/lib/secrets/keychain-helper.swift"
PROFILE="$REPO_ROOT/bin/embedded.provisionprofile"
ENTITLEMENTS="$REPO_ROOT/scripts/keychain-entitlements.plist"
APP="$REPO_ROOT/bin/Agents CLI.app"
BIN="$APP/Contents/MacOS/Agents CLI"

: "${APPLE_ID:?APPLE_ID not set}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD not set}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set}"

[ -f "$PROFILE" ] || { echo "Missing $PROFILE. Generate at developer.apple.com and check it in." >&2; exit 1; }

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

echo "Embedding provisioning profile..."
cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"

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
