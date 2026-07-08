#!/usr/bin/env bash
#
# Build agents-cli into ./dist.
#
# Usage: scripts/build.sh [<version>] [--clean] [--skip-tests]
#
#   <version>      optional, e.g. 1.15.0 or 1.15.0-alpha.9 -- writes to package.json
#   --clean        wipe ./dist first
#   --skip-tests   skip the test suite

set -euo pipefail

cd "$(dirname "$0")/.."

dim()    { printf '\033[2m%s\033[0m\n'  "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
bold()   { printf '\033[1m%s\033[0m'    "$*"; }

die() { red "  Error: $*"; exit 1; }

CLEAN=false
SKIP_TESTS=false
VERSION=""
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta)\.[0-9]+)?$'
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=true ;;
    --skip-tests) SKIP_TESTS=true ;;
    -h|--help)
      sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    --*) die "unknown flag: $arg" ;;
    *)
      [[ -z "$VERSION" ]] || die "unexpected argument: $arg"
      [[ "$arg" =~ $SEMVER_RE ]] || die "invalid version '$arg' (expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-(alpha|beta).N)"
      VERSION="$arg"
      ;;
  esac
done

command -v bun >/dev/null || die "bun not found (curl -fsSL https://bun.sh/install | bash)"

if [[ -n "$VERSION" ]]; then
  node -e "const fs=require('fs'),p='./package.json',j=JSON.parse(fs.readFileSync(p));j.version='$VERSION';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
fi

bold "Build"; echo "  $(node -p "require('./package.json').name")@$(node -p "require('./package.json').version")"
echo

if $CLEAN; then
  dim "  Cleaning dist/"
  rm -rf dist
fi

dim "  Installing dependencies"
bun install --silent

dim "  Compiling TypeScript"
bun run build >/dev/null 2>&1

# TypeScript emits CLI entrypoints with mode 644. npm pack preserves the mode,
# and npm install in newer versions does NOT auto-chmod the bin target, so
# users see `zsh: permission denied: agents` when invoking through the global
# shim. Set executable bits on every file declared in `package.json#bin`.
node -e "
  const fs = require('fs');
  const bin = require('./package.json').bin || {};
  for (const target of Object.values(bin)) {
    if (!target) continue;
    try { fs.chmodSync(target, 0o755); }
    catch (err) { console.error('  warn: chmod failed for ' + target + ': ' + err.message); }
  }
"

if $SKIP_TESTS; then
  dim "  Skipping tests (--skip-tests)"
else
  dim "  Running tests"
  TEST_LOG=$(mktemp)
  if ! bun run test >"$TEST_LOG" 2>&1; then
    echo
    red "  Tests failed"
    cat "$TEST_LOG" >&2
    rm -f "$TEST_LOG"
    exit 1
  fi
  TEST_SUMMARY=$(grep -E '^\s*[0-9]+ (pass|fail|skip)' "$TEST_LOG" | tail -3 | tr '\n' ' ' | sed 's/  */ /g')
  rm -f "$TEST_LOG"
  [[ -n "$TEST_SUMMARY" ]] && dim "    $TEST_SUMMARY"
fi

OUT_BYTES=$(find dist -type f \( -name '*.js' -o -name '*.d.ts' \) -exec wc -c {} + | tail -1 | awk '{print $1}')
OUT_KB=$(( OUT_BYTES / 1024 ))
OUT_FILES=$(find dist -type f \( -name '*.js' -o -name '*.d.ts' \) | wc -l | tr -d ' ')

echo
green "  Ready"
dim   "  $OUT_FILES files, ${OUT_KB} KB in dist/"
