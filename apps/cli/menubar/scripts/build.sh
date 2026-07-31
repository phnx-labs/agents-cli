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

DEST_DIR="dist"
mkdir -p "$DEST_DIR"

# Standalone binary (embedded inside a parent signed .app when shipped).
DEST="$DEST_DIR/menubar-helper-mac"
cp "$SRC" "$DEST"

# .app bundle. LSUIElement=true keeps it out of the Dock and the ⌘-Tab
# switcher — it lives only in the menu bar. We skip notarization (a status item
# has no Keychain ACL), but the helper DOES need a stable code identity: its
# clip→paste feature (Clip.swift) synthesizes a ⌘-V keystroke, which requires an
# Accessibility (TCC) grant, and macOS 26+ SIGKILLs an unsigned/invalid binary
# at launch. Prefer a Developer ID identity — it survives npm's tarball
# round-trip (an ad-hoc/linker signature gets stripped to "not signed at all",
# which the install-time re-sign in install-menubar.ts then heals per machine).
APP="$DEST_DIR/MenubarHelper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"
cp "$SRC" "$APP/Contents/MacOS/MenubarHelper"
generate_app_icon "$REPO_ROOT/assets/logo.png" "$APP/Contents/Resources/AppIcon.icns"
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
    <string>Agents Menu Bar</string>
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
    echo "  WARNING: no Developer ID identity found — signing ad-hoc." >&2
    echo "  npm will strip this signature; machines self-heal via install-menubar.ts" >&2
    echo "  but the Accessibility grant re-prompts each upgrade. Sign on a host with" >&2
    echo "  the Developer ID cert (see remote-sign-mac.sh) for a stable identity." >&2
fi
echo "  signing with: $SIGN_ID"
codesign --force --options runtime --sign "$SIGN_ID" --identifier com.phnx-labs.agents-menubar "$APP" 2>&1 | sed 's/^/  /'
codesign --force --options runtime --sign "$SIGN_ID" --identifier com.phnx-labs.agents-menubar "$DEST" 2>&1 | sed 's/^/  /'

echo "built: $DEST"
echo "built: $APP"
