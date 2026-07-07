#!/bin/bash
# Build the Factory app for distribution.
#
# Usage: ./scripts/build.sh [version] [flags]
#
# Examples:
#   ./scripts/build.sh              # build at package.json version, host platform
#   ./scripts/build.sh 0.1.0        # build v0.1.0
#   ./scripts/build.sh 0.1.0 --platform mac
#   ./scripts/build.sh --skip-tests
#
# Flags:
#   --platform <mac|linux|win>  Target platform (default: host)
#   --skip-tests                Skip the typecheck gate
#
# Steps: 1) typecheck  2) build UI + host  3) package (electron-builder)  4) verify.
# Signs + notarizes when Apple creds are available (agents secrets `apple.com` or
# CSC_NAME/APPLE_* env); otherwise builds UNSIGNED with a warning. This script
# NEVER publishes — use release.sh for that.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
error() { echo -e "${RED}Error: $1${NC}" >&2; exit 1; }
info()  { echo -e "${GREEN}$1${NC}"; }
warn()  { echo -e "${YELLOW}$1${NC}"; }

cd "$APP_DIR"

# --- args ---
VERSION=""
PLATFORM=""
SKIP_TESTS="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)   PLATFORM="$2"; shift 2 ;;
    --skip-tests) SKIP_TESTS="true"; shift ;;
    --*)          error "Unknown flag: $1" ;;
    *)            VERSION="$1"; shift ;;
  esac
done

# Default platform from host.
if [[ -z "$PLATFORM" ]]; then
  case "$(uname -s)" in
    Darwin) PLATFORM="mac" ;;
    Linux)  PLATFORM="linux" ;;
    *)      PLATFORM="win" ;;
  esac
fi
case "$PLATFORM" in mac|linux|win) ;; *) error "Invalid platform: $PLATFORM" ;; esac

# Default version from package.json.
if [[ -z "$VERSION" ]]; then
  VERSION="$(cd "$APP_DIR" && node -p "require('./package.json').version" 2>/dev/null || echo "")"
  [[ -n "$VERSION" ]] || error "Could not read version from package.json; pass one explicitly."
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?$ ]]; then
  error "Invalid version: $VERSION (expected x.y.z)"
fi

info "Building Factory v${VERSION} (platform: ${PLATFORM})"
echo ""

# --- deps (app + the bundled UI) ---
[[ -d node_modules && -d ../ui/node_modules ]] || { info "Installing deps..."; bash "$SCRIPT_DIR/install.sh"; }

# --- Step 1: typecheck ---
if [[ "$SKIP_TESTS" != "true" ]]; then
  info "Step 1: typecheck..."
  bun run typecheck || error "Typecheck failed."
  echo ""
else
  warn "Step 1: typecheck SKIPPED (--skip-tests)"
fi

# --- pin version into package.json (restored on exit) ---
ORIGINAL_PKG="$(mktemp)"; cp package.json "$ORIGINAL_PKG"
trap 'mv "$ORIGINAL_PKG" package.json 2>/dev/null || true' EXIT
node -e "const p=require('./package.json'); p.version='${VERSION}'; require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n')"

# --- macOS signing: load creds if available; else UNSIGNED (warn) ---
if [[ "$PLATFORM" == "mac" ]]; then
  if [[ -z "${CSC_NAME:-}${CSC_LINK:-}" ]] && command -v agents >/dev/null 2>&1; then
    CREDS="$(agents secrets exec apple.com -- env 2>/dev/null | grep -E '^(APPLE_|CSC_)' || true)"
    if [[ -n "$CREDS" ]]; then
      while IFS='=' read -r k v; do export "$k=$v"; done <<< "$CREDS"
      info "  Loaded Apple signing creds from agents secrets (apple.com)"
    fi
  fi
  if [[ -n "${CSC_NAME:-}${CSC_LINK:-}" ]]; then
    echo "  Code signing: ${CSC_NAME:-CSC_LINK}"
    if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
      node -e "const p=require('./package.json'); p.build.mac.notarize=true; require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n')"
      echo "  Notarization: enabled (Team ID ${APPLE_TEAM_ID})"
    else
      warn "  Notarization creds incomplete — building signed but NOT notarized"
    fi
  else
    warn "  No Apple signing identity — building UNSIGNED (Gatekeeper will warn). Set CSC_NAME or add an agents secrets 'apple.com' bundle to sign."
  fi
fi

# --- Step 2: build UI + host ---
info "Step 2: build UI + host..."
bun run build || error "UI/host build failed."
echo ""

# --- Step 3: package ---
info "Step 3: package (electron-builder, ${PLATFORM})..."
case "$PLATFORM" in
  mac)   bun run dist -- --mac --publish never ;;
  linux) bun run dist -- --linux --publish never ;;
  win)   bun run dist -- --win --publish never ;;
esac
echo ""

# --- Step 4: verify ---
info "Step 4: verify output..."
[[ -f "$APP_DIR/../out/app-ui/index.html" ]] || error "UI bundle missing (../out/app-ui/index.html)."
echo "  OK: UI bundle present"

REL="$APP_DIR/release"
if [[ "$PLATFORM" == "mac" ]]; then
  APP_BUNDLE="$(find "$REL" -maxdepth 2 -name 'Factory.app' -type d 2>/dev/null | head -1)"
  [[ -n "$APP_BUNDLE" ]] || error "Factory.app not found in $REL"
  BUILT="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || echo UNKNOWN)"
  [[ "$BUILT" == "$VERSION" ]] || error "Factory.app version '$BUILT' != requested '$VERSION'"
  echo "  OK: Factory.app version = $BUILT"
  SIGN="$(codesign -dvv "$APP_BUNDLE" 2>&1 || true)"
  if echo "$SIGN" | grep -q "Developer ID Application"; then
    echo "  SIGNED: $(echo "$SIGN" | grep -m1 'Authority=')"
  else
    warn "  UNSIGNED (Gatekeeper will warn)"
  fi
  DMG="$(find "$REL" -maxdepth 1 -name "*${VERSION}*.dmg" -type f 2>/dev/null | head -1)"
  [[ -n "$DMG" ]] && echo "  OK: dmg = $(basename "$DMG")"
else
  ART="$(find "$REL" -maxdepth 1 -type f \( -name "*.AppImage" -o -name "*.exe" \) 2>/dev/null | head -1)"
  [[ -n "$ART" ]] || error "No installable artifact found in $REL"
  echo "  OK: artifact = $(basename "$ART")"
fi
echo ""

info "Build complete: Factory v${VERSION}"
ls -lh "$REL"/*.dmg "$REL"/*.zip "$REL"/*.AppImage "$REL"/*.exe 2>/dev/null || true
