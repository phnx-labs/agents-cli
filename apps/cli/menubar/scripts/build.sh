#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="${1:-debug}"

if [ "$MODE" = "release" ]; then
    # Universal build needs Xcode's xcbuild. Fall back to a native single-arch
    # release build when only the Command Line Tools are installed, so a release
    # can still be cut on a machine without full Xcode.
    if swift build -c release --arch arm64 --arch x86_64 2>/dev/null; then
        SRC=".build/apple/Products/Release/MenubarHelper"
    else
        echo "  universal build unavailable (no Xcode/xcbuild); building native single-arch release"
        swift build -c release
        SRC="$(swift build -c release --show-bin-path)/MenubarHelper"
    fi
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
# switcher — it lives only in the menu bar. Unlike the computer helper, the
# status item needs no TCC grant, so ad-hoc signing is fine and we skip
# notarization entirely.
APP="$DEST_DIR/MenubarHelper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$SRC" "$APP/Contents/MacOS/MenubarHelper"
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
[ -z "$SIGN_ID" ] && SIGN_ID="-"
echo "  signing with: $SIGN_ID"
codesign --force --options runtime --sign "$SIGN_ID" --identifier com.phnx-labs.agents-menubar "$APP" 2>&1 | sed 's/^/  /'
codesign --force --options runtime --sign "$SIGN_ID" --identifier com.phnx-labs.agents-menubar "$DEST" 2>&1 | sed 's/^/  /'

echo "built: $DEST"
echo "built: $APP"
