#!/bin/bash
#
# Ship swarmify.swarm-ext to the VS Code Marketplace and Open VSX.
#
# Defaults to dry-run. Pass --confirm to actually publish.
#
# Runnable from any box on the fleet. Publishing needs the marketplace PATs,
# which live in the `vs-marketplace` secrets bundle on ONE machine; credentials
# are never copied between hosts, so the publish has to run where the bundle
# is. If this box doesn't hold it, the script finds a box that does and
# re-invokes itself there over ssh, against a clean clone of this exact commit.
#
# Usage:
#   scripts/release.sh <x.y.z> [--pre <tag>] [--confirm] [--skip-build]
#                              [--skip-tests] [--host <name>] [--here]
#
# Examples:
#   scripts/release.sh 0.9.206                            # dry-run
#   scripts/release.sh 0.9.206 --confirm                  # real release
#   scripts/release.sh 0.9.206 --pre rc.1 --confirm       # 0.9.206-rc.1
#   scripts/release.sh 0.9.206 --confirm --skip-tests     # hotfix
#   scripts/release.sh 0.9.206 --confirm --host zion      # pin the publish box
#   scripts/release.sh 0.9.206 --confirm --here           # never route off-box
#
# Pre-flight order: changelog -> publish-host routing -> marketplace
# version-collision -> token presence -> tests -> build -> publish. Cheap
# failures fail fast.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# --- Args ----------------------------------------------------------------

BASE_VERSION=""
PRE_TAG=""
CONFIRM=0
SKIP_BUILD=0
SKIP_TESTS=0
PUBLISH_HOST=""
STAY_HERE=0
# Internal. Set on the re-invocation that runs ON the publish host, so it does
# the work instead of routing again.
PUBLISH_PHASE=0

usage() {
    sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
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
        --host)
            PUBLISH_HOST="${2:-}"
            if [ -z "$PUBLISH_HOST" ]; then echo "Error: --host requires a device name" >&2; exit 1; fi
            shift 2
            ;;
        --here)          STAY_HERE=1; shift ;;
        --publish-phase) PUBLISH_PHASE=1; shift ;;
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

# --- Publish host routing ------------------------------------------------
#
# The marketplace PATs live in the `vs-marketplace` secrets bundle, which sits
# on exactly one machine. Tokens are never copied between hosts, so the publish
# must RUN where the bundle is. Decide that here, before any expensive step.
#
# `agents secrets list` is the probe: the bundle either resolves on a box or it
# does not, and asking the live store beats maintaining a hardcoded list of
# which machine is "the release box".

readonly PUBLISH_BUNDLE="vs-marketplace"
# Tried in order when this box cannot publish and --host was not given. These
# are the long-lived personal machines; a worker box is never a publish target.
PUBLISH_HOST_CANDIDATES=(zion mac-mini)

# Short hostname, matching the ssh/Tailscale name on both platforms.
if [ "$(uname -s)" = "Darwin" ]; then
    THIS_HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
else
    THIS_HOST="$(hostname -s 2>/dev/null || hostname)"
fi

# Echo "yes" when the given host holds the publish bundle. Empty arg = this box.
host_has_publish_bundle() {
    local host="${1:-}" out
    if [ -z "$host" ]; then
        out="$(agents secrets list 2>/dev/null || true)"
    else
        out="$(agents ssh "$host" 'agents secrets list 2>/dev/null' 2>/dev/null || true)"
    fi
    printf '%s\n' "$out" | grep -qE "^${PUBLISH_BUNDLE}[[:space:]]" && echo yes
}

# Re-invoke this script on $1, against a clean clone of the commit we are on.
# A clone rather than the host's own checkout, so the publish box's working
# trees are never touched and the vsix can never pick up someone's local edits.
route_to_publish_host() {
    local host="$1" sha origin flags payload
    sha="$(git rev-parse HEAD)"
    origin="$(git remote get-url origin)"

    # The publish box fetches the commit from origin, so it has to be pushed.
    if ! git ls-remote --exit-code origin >/dev/null 2>&1; then
        echo "Error: cannot reach origin to hand the release commit to $host." >&2
        exit 1
    fi

    flags=""
    [ $CONFIRM -eq 1 ] && flags="--confirm"
    [ -n "$PRE_TAG" ] && flags="$flags --pre $PRE_TAG"
    [ $SKIP_TESTS -eq 1 ] && flags="$flags --skip-tests"
    [ $SKIP_BUILD -eq 1 ] && flags="$flags --skip-build"

    echo "Routing the publish to $host (holds the '$PUBLISH_BUNDLE' bundle)."
    echo "  commit:  $sha"
    echo "  flags:  $flags --publish-phase"
    echo

    # base64 so the remote payload survives shell quoting intact.
    payload="$(cat <<REMOTE_EOF | base64 | tr -d '\n'
set -euo pipefail
VERSION="$VERSION"
SHA="$sha"
ORIGIN="$origin"
export PATH="\$HOME/.bun/bin:\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH"

command -v bun >/dev/null 2>&1 || { echo "Error: bun not found on \$(hostname)." >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Error: git not found on \$(hostname)." >&2; exit 1; }

# The publishing CLIs are tools, not credentials - install them rather than failing.
command -v vsce >/dev/null 2>&1 || { echo "Installing @vscode/vsce..."; bun add -g @vscode/vsce >/dev/null; }
command -v ovsx >/dev/null 2>&1 || { echo "Installing ovsx..."; bun add -g ovsx >/dev/null; }

CACHE="\$HOME/.cache/factory-release/agents-cli"
mkdir -p "\$(dirname "\$CACHE")"
[ -d "\$CACHE/.git" ] || git clone --quiet "\$ORIGIN" "\$CACHE"
git -C "\$CACHE" fetch --quiet origin
git -C "\$CACHE" cat-file -e "\$SHA^{commit}" 2>/dev/null || {
    echo "Error: commit \$SHA is not on origin - push the release commit first." >&2
    exit 1
}
git -C "\$CACHE" checkout --quiet --detach "\$SHA"

cd "\$CACHE/apps/factory"
bun install --silent
bash scripts/release.sh "\$VERSION" $flags --publish-phase
REMOTE_EOF
)"

    agents ssh "$host" "echo $payload | base64 -d | bash"
}

if [ $PUBLISH_PHASE -eq 1 ]; then
    echo "Publish phase on $THIS_HOST."
    if [ -z "$(host_has_publish_bundle '')" ]; then
        echo "Error: --publish-phase on $THIS_HOST, which has no '$PUBLISH_BUNDLE' bundle." >&2
        exit 1
    fi
    echo
elif [ -n "$(host_has_publish_bundle '')" ]; then
    echo "Publish host: $THIS_HOST (holds the '$PUBLISH_BUNDLE' bundle)."
    echo
elif [ $STAY_HERE -eq 1 ]; then
    echo "Error: --here was passed, but $THIS_HOST has no '$PUBLISH_BUNDLE' bundle." >&2
    echo "       Create it here (agents secrets create $PUBLISH_BUNDLE) or drop --here to route." >&2
    exit 1
else
    if ! command -v agents >/dev/null 2>&1; then
        echo "Error: $THIS_HOST has no '$PUBLISH_BUNDLE' bundle and agents-cli is not installed to route with." >&2
        exit 1
    fi
    TARGET_HOST=""
    if [ -n "$PUBLISH_HOST" ]; then
        if [ -z "$(host_has_publish_bundle "$PUBLISH_HOST")" ]; then
            echo "Error: --host $PUBLISH_HOST does not hold the '$PUBLISH_BUNDLE' bundle." >&2
            exit 1
        fi
        TARGET_HOST="$PUBLISH_HOST"
    else
        echo "$THIS_HOST has no '$PUBLISH_BUNDLE' bundle - looking for a publish host..."
        for CANDIDATE in "${PUBLISH_HOST_CANDIDATES[@]}"; do
            [ "$CANDIDATE" = "$THIS_HOST" ] && continue
            echo "  probing $CANDIDATE..."
            if [ -n "$(host_has_publish_bundle "$CANDIDATE")" ]; then
                TARGET_HOST="$CANDIDATE"
                break
            fi
        done
    fi
    if [ -z "$TARGET_HOST" ]; then
        echo "Error: no reachable host holds the '$PUBLISH_BUNDLE' bundle." >&2
        echo "       Tried: ${PUBLISH_HOST_CANDIDATES[*]}" >&2
        echo "       Create it on the box that should publish:" >&2
        echo "         agents secrets create $PUBLISH_BUNDLE && agents secrets add $PUBLISH_BUNDLE VSCE_PAT" >&2
        exit 1
    fi
    route_to_publish_host "$TARGET_HOST"
    exit $?
fi

# --- Pre-flight: marketplace version collision ---------------------------

# Source of truth = marketplace, not git. If the version is already published
# we abort — re-running with the same version would 409 on the publish step
# anyway, but failing here is faster.
if ! command -v vsce >/dev/null 2>&1 && command -v bun >/dev/null 2>&1; then
    echo "vsce not installed - installing @vscode/vsce..."
    bun add -g @vscode/vsce >/dev/null 2>&1 || true
    export PATH="$HOME/.bun/bin:$PATH"
fi
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
