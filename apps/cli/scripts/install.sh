#!/usr/bin/env bash
#
# Install this working tree as a dev build of agents-cli, side-by-side with
# the registry-installed `agents` command.
#
# The dev install lives at its own prefix (default: $HOME/.local/agents-cli-dev)
# and is exposed via $HOME/.local/bin/agents. Your registry-installed
# `agents` at $(npm root -g)/.bin/agents is NOT touched.
#
# To use the dev build, put $HOME/.local/bin on PATH ahead of the registry
# bin dir (e.g. before nvm's bin in your shell rc). To revert, drop the
# entry from PATH or `npm install -g @phnx-labs/agents-cli@latest` to overwrite.
#
# Version of the dev build is `0.0.0-dev.<sha>[-dirty]` so `agents --version`
# tells you immediately which one is on PATH.
#
# Usage: scripts/install.sh [--skip-build] [--skip-tests] [--prefix <dir>]
#
#   --skip-build      reuse existing dist/ instead of rebuilding
#   --skip-tests      skip the test suite (forwarded to build)
#   --prefix <dir>    install prefix (default: $HOME/.local/agents-cli-dev)

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

dim()    { printf '\033[2m%s\033[0m\n'  "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
bold()   { printf '\033[1m%s\033[0m'    "$*"; }

die() { red "  Error: $*"; exit 1; }

SKIP_BUILD=false
SKIP_TESTS=false
PREFIX="$HOME/.local/agents-cli-dev"
LINK_DIR="$HOME/.local/bin"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --skip-tests) SKIP_TESTS=true; shift ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    -h|--help)
      sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
done

command -v npm >/dev/null || die "npm not found"
command -v node >/dev/null || die "node not found"

# Dev version keyed to the current commit so two installs from different
# commits are distinguishable. Bin name stays stable (`agents`).
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "local")
DIRTY=""
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then DIRTY="-dirty"; fi
DEV_VERSION="0.0.0-dev.${SHA}${DIRTY}"

REGISTRY_VERSION=$(node -p "require('./package.json').version")
PKG_NAME=$(node -p "require('./package.json').name")

bold "Dev install"
echo "  $PKG_NAME ($REGISTRY_VERSION -> $DEV_VERSION)"
echo "  prefix: $PREFIX"
echo "  bin:    $LINK_DIR/agents"
echo

if ! $SKIP_BUILD; then
  BUILD_ARGS=()
  $SKIP_TESTS && BUILD_ARGS+=(--skip-tests)
  ./scripts/build.sh ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}
  echo
fi

[[ -f dist/index.js ]] || die "dist/index.js missing -- run scripts/build.sh first"

# Stage a copy of the package with the dev version. We don't mutate the
# working-tree package.json because that would dirty the tree mid-iteration
# and confuse later builds. Keep the original `bin` names (`agents`, `ag`,
# `browser`) so the dev install behaves identically to the registry release.
STAGE_DIR=$(mktemp -d)
trap 'rm -rf "$STAGE_DIR"' EXIT

dim "  Staging $STAGE_DIR"
mkdir -p "$STAGE_DIR/scripts"
cp -R dist "$STAGE_DIR/"
cp scripts/postinstall.js "$STAGE_DIR/scripts/"
[[ -f CHANGELOG.md ]] && cp CHANGELOG.md "$STAGE_DIR/"
[[ -f README.md ]] && cp README.md "$STAGE_DIR/"
[[ -f LICENSE ]] && cp LICENSE "$STAGE_DIR/"

# Rewrite package.json: dev version. Skip the postinstall hook — it's designed
# to nudge the user to add the registry-install shims dir to PATH, which the
# dev install doesn't need.
node -e "
  const fs = require('fs');
  const p = require('./package.json');
  p.version = '$DEV_VERSION';
  delete p.scripts?.postinstall;
  delete p.scripts?.prepack;
  delete p.scripts?.prepare;
  fs.writeFileSync(process.argv[1], JSON.stringify(p, null, 2));
" "$STAGE_DIR/package.json"

dim "  Packing tarball"
(
  cd "$STAGE_DIR"
  # --ignore-scripts: the package's prepack hook references files we don't
  # stage (it's a publish-time check, not relevant for the dev tarball).
  TARBALL_FILE=$(npm pack --silent --ignore-scripts 2>&1 | tail -1)
  echo "$STAGE_DIR/$TARBALL_FILE" > "$STAGE_DIR/.tarball-path"
)
TARBALL=$(cat "$STAGE_DIR/.tarball-path")
[[ -f "$TARBALL" ]] || die "npm pack failed to produce a tarball"

dim "  Installing to $PREFIX"
mkdir -p "$PREFIX"
npm install -g "$TARBALL" \
  --prefix "$PREFIX" \
  --silent --no-fund --no-audit --no-save \
  --ignore-scripts \
  >/dev/null

# Symlink the dev bins into a stable location ($HOME/.local/bin) without
# touching anything in the registry-install prefix. The dev binary is named
# `agents` -- to use it instead of the registry one, put $LINK_DIR ahead of
# the registry bin dir on PATH.
mkdir -p "$LINK_DIR"
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]]; then
  for bin in agents ag browser; do
    [[ -e "$PREFIX/$bin.cmd" ]] || continue
    printf '@"%%USERPROFILE%%\\.local\\agents-cli-dev\\%s.cmd" %%*\r\n' "$bin" > "$LINK_DIR/$bin.cmd"
    printf '& "$HOME\\.local\\agents-cli-dev\\%s.ps1" @args\r\n' "$bin" > "$LINK_DIR/$bin.ps1"
    printf '#!/usr/bin/env bash\nexec "$HOME/.local/agents-cli-dev/%s" "$@"\n' "$bin" > "$LINK_DIR/$bin"
    chmod +x "$LINK_DIR/$bin"
  done
else
  for bin in agents ag browser; do
    src="$PREFIX/bin/$bin"
    [[ -e "$src" ]] || continue
    ln -sf "$src" "$LINK_DIR/$bin"
  done
fi

# Prefer the standalone Mach-O when the staged dist carries one (macOS): the
# node-shebang shim is what EDR flags (#315). Runnable-probe first - an
# unsigned or wrong-arch artifact must not brick the dev install.
NATIVE_BIN="$PREFIX/lib/node_modules/$PKG_NAME/dist/bin/agents"
if [[ "$(uname)" == "Darwin" && -x "$NATIVE_BIN" ]] && "$NATIVE_BIN" --version >/dev/null 2>&1; then
  ln -sf "$NATIVE_BIN" "$LINK_DIR/agents"
  ln -sf "$NATIVE_BIN" "$LINK_DIR/ag"
  dim "  Linked agents/ag to the standalone binary (dist/bin/agents)"
fi

# Confirm the dev binary is runnable.
LINKED_PATH="$LINK_DIR/agents"
[[ -e "$LINKED_PATH" ]] || die "agents not installed at $LINKED_PATH"
LINKED_VER=$("$LINKED_PATH" --version 2>/dev/null | head -1 || echo "?")

# Install the signed macOS Keychain helper to its stable user path. The dev
# install skips postinstall (see the package.json staging above), so this
# needs to run explicitly. No-op on non-darwin and if the source .app is
# missing (e.g. raw working tree without the bin/ asset).
if [[ -f "$ROOT/scripts/install-helper.js" ]]; then
  dim "  Installing Keychain helper"
  node "$ROOT/scripts/install-helper.js" --force || true
fi

# Bounce a running routines daemon onto this build (RUSH-2442).
#
# The npm postinstall hook is the registry-install path that restarts the
# daemon so the secrets broker (and every other subsystem the daemon hosts)
# reloads the just-installed code. We strip that hook above so the PATH-nudge
# and alias-shim flow don't fire for a side-by-side dev prefix — which also
# skipped the restart, leaving a broker built from the PREVIOUS install
# still holding sockets. A version skew between broker and on-disk CLI wipes
# held bundles and re-arms Touch ID prompts on the next secrets read.
#
# Match postinstall.js healLongRunningProcesses: only when a daemon is
# already running (never start one the user didn't want), best-effort and
# non-fatal, skipped in CI and when AGENTS_NO_HEAL=1. Pin the restart to
# the just-linked binary so the service manifest records this install, not
# a registry path that happens to be earlier on PATH.
if [[ -z "${CI:-}" && "${AGENTS_NO_HEAL:-}" != "1" ]]; then
  INSTALLED_PKG="$PREFIX/lib/node_modules/$PKG_NAME"
  if [[ -f "$INSTALLED_PKG/dist/lib/daemon.js" ]]; then
    dim "  Reloading daemon onto this build (if running)"
    # Export paths for the node one-shot so shell metacharacters in PREFIX
    # can't break the import. Use the installed module (not PATH) so we
    # don't accidentally restart with a different agents binary.
    AGENTS_INSTALL_DAEMON_MOD="$INSTALLED_PKG/dist/lib/daemon.js" \
    AGENTS_INSTALL_BIN="$LINKED_PATH" \
    node --input-type=module -e '
      import { pathToFileURL } from "node:url";
      const modPath = process.env.AGENTS_INSTALL_DAEMON_MOD;
      const bin = process.env.AGENTS_INSTALL_BIN;
      try {
        const d = await import(pathToFileURL(modPath).href);
        if (!d.isDaemonRunning?.()) process.exit(0);
        d.stopDaemon?.();
        d.startDaemon?.(bin);
        console.log("  Restarted the routines daemon onto this version.");
      } catch (err) {
        console.error("  Could not restart the daemon (non-fatal):", err && err.message ? err.message : err);
        console.error("  Run: agents daemon restart");
        process.exit(0);
      }
    ' || true
  fi
fi

green "  Ready"
dim   "  $LINKED_PATH ($LINKED_VER)"

# Remind the user about PATH precedence if the dev bin dir isn't first.
case ":$PATH:" in
  *":$LINK_DIR:"*)
    # Detect if the registry bin dir comes earlier than $LINK_DIR.
    REGISTRY_BIN=$(dirname "$(npm root -g 2>/dev/null)/../bin/agents" 2>/dev/null || echo "")
    if [[ -n "$REGISTRY_BIN" ]] && [[ -e "$REGISTRY_BIN/agents" ]]; then
      LINK_POS=$(echo ":$PATH:" | awk -v t=":$LINK_DIR:" '{print index($0, t)}')
      REG_POS=$(echo ":$PATH:" | awk -v t=":$REGISTRY_BIN:" '{print index($0, t)}')
      if [[ $REG_POS -gt 0 ]] && [[ $REG_POS -lt $LINK_POS ]]; then
        yellow "  Note: registry bin dir ($REGISTRY_BIN) precedes $LINK_DIR on PATH."
        yellow "  Reorder your shell rc so $LINK_DIR comes first to invoke the dev build."
      fi
    fi
    ;;
  *)
    echo
    yellow "  $LINK_DIR is not on PATH. Add this to your shell rc:"
    echo "      export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac
