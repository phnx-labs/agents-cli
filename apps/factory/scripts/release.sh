#!/bin/bash
#
# Ship swarmify.swarm-ext to the VS Code Marketplace and Open VSX.
#
# Defaults to dry-run. Pass --confirm to actually publish.
#
# Usage:
#   scripts/release.sh <x.y.z> [--pre <tag>] [--confirm] [--skip-build] [--skip-tests]
#
# Examples:
#   scripts/release.sh 0.9.206                            # dry-run
#   scripts/release.sh 0.9.206 --confirm                  # real release
#   scripts/release.sh 0.9.206 --pre rc.1 --confirm       # 0.9.206-rc.1
#   scripts/release.sh 0.9.206 --confirm --skip-tests     # hotfix
#
# Pre-flight order: marketplace version-collision -> token presence -> tests
# -> build -> publish. Cheap failures fail fast.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# --- Args ----------------------------------------------------------------

BASE_VERSION=""
PRE_TAG=""
CONFIRM=0
SKIP_BUILD=0
SKIP_TESTS=0

usage() {
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --pre)
            PRE_TAG="${2:-}"
            if [ -z "$PRE_TAG" ]; then echo "Error: --pre requires a tag" >&2; exit 1; fi
            shift 2
            ;;
        --confirm)     CONFIRM=1; shift ;;
        --skip-build)  SKIP_BUILD=1; shift ;;
        --skip-tests)  SKIP_TESTS=1; shift ;;
        -h|--help)     usage 0 ;;
        --*)           echo "Error: unknown flag $1" >&2; usage 1 ;;
        *)
            if [ -n "$BASE_VERSION" ]; then
                echo "Error: unexpected arg $1 (version already set to $BASE_VERSION)" >&2
                exit 1
            fi
            BASE_VERSION="$1"
            shift
            ;;
    esac
done

if [ -z "$BASE_VERSION" ]; then usage 1; fi

if ! [[ $BASE_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: version must be X.Y.Z (got: $BASE_VERSION)" >&2
    exit 1
fi

if [ -n "$PRE_TAG" ] && ! [[ $PRE_TAG =~ ^[0-9A-Za-z.-]+$ ]]; then
    echo "Error: --pre tag must match [0-9A-Za-z.-]+ (got: $PRE_TAG)" >&2
    exit 1
fi

VERSION="$BASE_VERSION"
if [ -n "$PRE_TAG" ]; then VERSION="${BASE_VERSION}-${PRE_TAG}"; fi

# --- Pre-flight: the changelog must document this version ----------------
#
# A release must document itself. Require a `## [<X.Y.Z>]` section in
# CHANGELOG.md (the base version, ignoring any --pre tag) so we can never
# publish a version whose changes are undocumented. Cheapest check -> runs first.
if ! grep -qE "^## \[${BASE_VERSION//./\\.}\]" CHANGELOG.md; then
    echo "Error: no CHANGELOG.md entry for ${BASE_VERSION}." >&2
    echo "       Add a '## [${BASE_VERSION}] - <date>' section before releasing." >&2
    exit 1
fi
echo "Changelog entry for ${BASE_VERSION}: found."
echo

PUBLISHER_ID="swarmify"
EXT_NAME="swarm-ext"
EXT_FQN="${PUBLISHER_ID}.${EXT_NAME}"
VSIX="dist/${EXT_NAME}-${VERSION}.vsix"

DRY=""
if [ $CONFIRM -eq 0 ]; then
    DRY="[DRY-RUN] "
    echo "${DRY}No mutations will happen. Pass --confirm to actually release."
    echo
fi

echo "Release plan"
echo "  publisher:  $PUBLISHER_ID"
echo "  extension:  $EXT_NAME"
echo "  version:    $VERSION"
[ -n "$PRE_TAG" ] && echo "  pre-tag:    $PRE_TAG (passed to vsce as --pre-release)"
echo "  vsix:       $VSIX"
echo "  skip-build: $SKIP_BUILD"
echo "  skip-tests: $SKIP_TESTS"
echo

# --- Pre-flight: marketplace version collision ---------------------------

# Source of truth = marketplace, not git. If the version is already published
# we abort — re-running with the same version would 409 on the publish step
# anyway, but failing here is faster.
if ! command -v vsce >/dev/null 2>&1; then
    echo "Error: vsce not installed. Run: bun add -g @vscode/vsce" >&2
    exit 1
fi

echo "Checking marketplace for existing $EXT_FQN@$VERSION..."
PUBLISHED_VSCE="$(vsce show "$EXT_FQN" --json 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print('\n'.join(v['version'] for v in d.get('versions',[])))" \
    2>/dev/null || true)"
if printf '%s\n' "$PUBLISHED_VSCE" | grep -qx "$VERSION"; then
    echo "Error: $VERSION already published on VS Code Marketplace." >&2
    echo "       Bump the version and try again." >&2
    exit 1
fi

PUBLISHED_OVSX=""
if command -v ovsx >/dev/null 2>&1; then
    echo "Checking Open VSX for existing $EXT_FQN@$VERSION..."
    # `ovsx get <ext> <version> --metadata` ignores the version arg and
    # returns latest; we have to read the JSON and string-match.
    OVSX_META="$(ovsx get "$EXT_FQN" "$VERSION" --metadata 2>/dev/null || true)"
    OVSX_HIT="$(VER="$VERSION" printf '%s' "$OVSX_META" \
        | VER="$VERSION" python3 -c "import json,sys,os; d=json.loads(sys.stdin.read() or '{}'); v=os.environ['VER']; files=d.get('files',{}); url=files.get('download',''); print('hit' if d.get('version')==v or '/'+v+'/' in url else '')" \
        2>/dev/null || true)"
    if [ "$OVSX_HIT" = "hit" ]; then
        echo "Error: $VERSION already published on Open VSX." >&2
        exit 1
    fi
    PUBLISHED_OVSX="ok"
else
    echo "Warning: ovsx not installed; skipping Open VSX publish." >&2
fi

# --- Pre-flight: tokens --------------------------------------------------

# Resolve from the keychain bundle if env not already set. Both paths leave
# VSCE_PAT and OVSX_PAT exported in the script's process — never logged.
if [ -z "${VSCE_PAT:-}" ] || { [ -n "$PUBLISHED_OVSX" ] && [ -z "${OVSX_PAT:-}" ]; }; then
    if ! command -v agents >/dev/null 2>&1; then
        echo "Error: VSCE_PAT/OVSX_PAT not in env and agents-cli not installed." >&2
        echo "       Either export them or install agents-cli to read keychain bundle 'vs-marketplace'." >&2
        exit 1
    fi
    # `agents secrets export` requires --plaintext to emit values (TTY or pipe).
    eval "$(agents secrets export vs-marketplace --plaintext 2>/dev/null)" || {
        echo "Error: failed to export 'vs-marketplace' bundle." >&2
        echo "       Create with: agents secrets create vs-marketplace" >&2
        echo "       Then add VSCE_PAT and OVSX_PAT keys." >&2
        exit 1
    }
fi

if [ -z "${VSCE_PAT:-}" ]; then
    echo "Error: VSCE_PAT not set after exporting vs-marketplace bundle." >&2
    exit 1
fi
if [ -n "$PUBLISHED_OVSX" ] && [ -z "${OVSX_PAT:-}" ]; then
    echo "Error: OVSX_PAT not set after exporting vs-marketplace bundle." >&2
    exit 1
fi

echo "Verifying VSCE PAT against publisher '$PUBLISHER_ID'..."
if ! vsce verify-pat "$PUBLISHER_ID" >/dev/null 2>&1; then
    echo "Error: vsce verify-pat failed for $PUBLISHER_ID. Token expired or wrong scope." >&2
    exit 1
fi
echo "VSCE PAT verified."

# --- Tests + Build -------------------------------------------------------

if [ $SKIP_TESTS -eq 0 ]; then
    echo "${DRY}Running tests..."
    if [ $CONFIRM -eq 1 ]; then
        bun run test
    fi
else
    echo "Skipping tests (--skip-tests)."
fi

if [ $SKIP_BUILD -eq 0 ]; then
    echo "${DRY}Building $VSIX..."
    if [ $CONFIRM -eq 1 ]; then
        bash scripts/build.sh "$VERSION"
    fi
else
    echo "Skipping build (--skip-build)."
    if [ ! -f "$VSIX" ]; then
        echo "Error: $VSIX does not exist and --skip-build was passed." >&2
        exit 1
    fi
fi

# --- Publish -------------------------------------------------------------

VSCE_FLAGS=()
if [ -n "$PRE_TAG" ]; then VSCE_FLAGS+=("--pre-release"); fi

if [ $CONFIRM -eq 0 ]; then
    echo
    echo "Would publish $VSIX to:"
    echo "  - VS Code Marketplace via: vsce publish --packagePath $VSIX ${VSCE_FLAGS[*]:-}"
    if [ -n "$PUBLISHED_OVSX" ]; then
        echo "  - Open VSX via: ovsx publish $VSIX"
    fi
    echo
    echo "Re-run with --confirm to actually publish."
    exit 0
fi

if [ ! -f "$VSIX" ]; then
    echo "Error: $VSIX missing after build step." >&2
    exit 1
fi

echo "Publishing $VSIX to VS Code Marketplace..."
vsce publish --packagePath "$VSIX" ${VSCE_FLAGS[@]+"${VSCE_FLAGS[@]}"}

if [ -n "$PUBLISHED_OVSX" ]; then
    echo "Publishing $VSIX to Open VSX..."
    ovsx publish "$VSIX"
fi

echo
echo "Released $EXT_FQN@$VERSION"
echo "  VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=$EXT_FQN"
[ -n "$PUBLISHED_OVSX" ] && echo "  Open VSX:            https://open-vsx.org/extension/$PUBLISHER_ID/$EXT_NAME"

# --- Confirm live on the public channel ----------------------------------
# `vsce publish` exiting 0 means the upload was accepted, not that the registry
# serves it. Poll both public APIs until they report $VERSION (propagation lag
# is normal — up to a couple minutes). Source of truth = users can fetch it.

marketplace_live_version() {
    curl -s -X POST "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json;api-version=3.0-preview.1" \
        -d "{\"filters\":[{\"criteria\":[{\"filterType\":7,\"value\":\"$EXT_FQN\"}]}],\"flags\":914}" 2>/dev/null \
        | python3 -c "import json,sys; d=json.load(sys.stdin); e=d.get('results',[{}])[0].get('extensions',[]); print(e[0]['versions'][0]['version'] if e else '')" 2>/dev/null || true
}
ovsx_live_version() {
    curl -s "https://open-vsx.org/api/$PUBLISHER_ID/$EXT_NAME" 2>/dev/null \
        | python3 -c "import json,sys; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || true
}

echo
echo "Confirming $VERSION is live on the registries (propagation can lag ~2 min)..."
VSCE_LIVE=0
OVSX_LIVE=0
for _ in $(seq 1 18); do   # ~3 min at 10s
    [ "$VSCE_LIVE" -eq 0 ] && [ "$(marketplace_live_version)" = "$VERSION" ] && { VSCE_LIVE=1; echo "  VS Code Marketplace: live ($VERSION)"; }
    if [ -n "$PUBLISHED_OVSX" ]; then
        [ "$OVSX_LIVE" -eq 0 ] && [ "$(ovsx_live_version)" = "$VERSION" ] && { OVSX_LIVE=1; echo "  Open VSX: live ($VERSION)"; }
    else
        OVSX_LIVE=1
    fi
    [ "$VSCE_LIVE" -eq 1 ] && [ "$OVSX_LIVE" -eq 1 ] && break
    sleep 10
done
[ "$VSCE_LIVE" -eq 0 ] && echo "  Warning: VS Code Marketplace not yet serving $VERSION after ~3 min — check the listing." >&2
[ -n "$PUBLISHED_OVSX" ] && [ "$OVSX_LIVE" -eq 0 ] && echo "  Warning: Open VSX not yet serving $VERSION after ~3 min — check the listing." >&2

# Install the just-published vsix into any local editor CLIs (code, codium,
# cursor). Marketplace propagation can take minutes; we install from the local
# artifact directly so the active IDE picks up the new version immediately.
# Build is already done — re-using $VSIX.
echo
echo "Installing $VSIX locally..."
INSTALLED=0
for CLI in cursor code codium; do
    if command -v "$CLI" >/dev/null 2>&1; then
        echo "  -> $CLI"
        "$CLI" --install-extension "$VSIX" --force
        INSTALLED=$((INSTALLED + 1))
    fi
done
if [ "$INSTALLED" -eq 0 ]; then
    echo "Warning: no editor CLI found (tried cursor, code, codium). Skipping local install." >&2
else
    echo "Installed to $INSTALLED editor(s)."
    # Installed to disk != active in a running editor. Reload running windows
    # and verify activation from exthost.log.
    bash "$(dirname "${BASH_SOURCE[0]}")/activate.sh" "$EXT_FQN"
fi
