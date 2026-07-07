#!/usr/bin/env bash
#
# Cross-publish the Windows computer-use daemon (native/computer-win)
# into a single self-contained win-x64 exe — from a macOS or Linux build host.
#
# The csproj already sets EnableWindowsTargeting=true, so `dotnet publish` for a
# win-x64 target works off Windows. The result is a runtime-free single file the
# box needs no .NET install to run; `agents computer setup --host <device>`
# pushes it over ssh.
#
# Usage: scripts/build-win.sh [--clean]
#
#   --clean   wipe the publish output dir first

set -euo pipefail

cd "$(dirname "$0")/.."

dim()   { printf '\033[2m%s\033[0m\n'  "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
bold()  { printf '\033[1m%s\033[0m'    "$*"; }
die()   { red "  Error: $*"; exit 1; }

CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=true ;;
    -h|--help) sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown flag: $arg" ;;
  esac
done

# Resolve dotnet: PATH first, then a user-local SDK at ~/.dotnet (what the
# dot.net install script drops in). CI installs the SDK on PATH.
DOTNET="$(command -v dotnet || true)"
if [[ -z "$DOTNET" && -x "$HOME/.dotnet/dotnet" ]]; then
  DOTNET="$HOME/.dotnet/dotnet"
fi
[[ -n "$DOTNET" ]] || die "dotnet not found. Install the .NET 10 SDK: curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0"

# native/ lives at the repo root (siblings of apps/), not under apps/cli.
PROJECT="../../native/computer-win"
OUT="$PROJECT/dist"

bold "Build (win-x64)"; echo "  $("$DOTNET" --version) — $PROJECT"
echo

if $CLEAN; then
  dim "  Cleaning $OUT/"
  rm -rf "$OUT"
fi

dim "  Publishing self-contained single-file exe"
"$DOTNET" publish "$PROJECT" \
  -c Release \
  -r win-x64 \
  --self-contained true \
  -p:PublishSingleFile=true \
  -o "$OUT"

EXE="$OUT/computer-helper-win.exe"
[[ -f "$EXE" ]] || die "publish finished but $EXE is missing"

# Byte size, portable across GNU/BSD stat.
BYTES=$(stat -c %s "$EXE" 2>/dev/null || stat -f %z "$EXE")
MB=$(( BYTES / 1024 / 1024 ))

echo
green "  Ready"
dim   "  $EXE"
dim   "  ${BYTES} bytes (~${MB} MB)"
