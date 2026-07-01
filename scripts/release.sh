#!/usr/bin/env bash
#
# Release script for agents-cli.
#
# Publishes a single version to TWO npm packages:
#   1. @phnx-labs/agents-cli  -- the canonical package (real code)
#   2. @companion/agents-cli   -- legacy shim that re-exports @phnx-labs
#
# The shim keeps existing @companion installs auto-updating into the new code.
#
# Usage: scripts/release.sh <version> [--apply]
#
# Default mode is DRY-RUN: every check runs (type-check, build, tests, tarball
# preview) but no publish, commit, tag, or push happens. Add --apply to
# actually release.
#
# Validates that <version> is a single-step bump from the current published
# @phnx-labs latest -- patch+1, or minor+1 with patch=0, or major+1 with
# minor=patch=0. No skips.

set -euo pipefail

PHNX_PKG="@phnx-labs/agents-cli"
SWARMIFY_PKG="${SHIM_PACKAGE:-@swarmify/agents-cli}"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
gray()   { printf '\033[2m%s\033[0m\n'  "$*"; }
bold()   { printf '\033[1m%s\033[0m\n'  "$*"; }

die() { red "error: $*"; exit 1; }

# ----- Parse args -----
APPLY=false
SKIP_TESTS=false
YES=false
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --skip-tests) SKIP_TESTS=true ;;
    --yes|-y) YES=true ;;
    -h|--help) printf '%s\n' "usage: scripts/release.sh <version> [--apply] [--skip-tests] [--yes]"; exit 0 ;;
    --*) die "unknown flag: $arg" ;;
    *)
      [[ -z "$TARGET" ]] || die "unexpected argument: $arg"
      TARGET="$arg"
      ;;
  esac
done
[[ -n "$TARGET" ]] || die "usage: scripts/release.sh <version> [--apply]  (e.g. 1.14.2 --apply)"
[[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be MAJOR.MINOR.PATCH (no pre-release tags)"

if $APPLY; then
  bold "Mode: APPLY (real publish)"
else
  yellow "Mode: DRY-RUN (no publish, no commit, no tag, no push -- pass --apply to actually release)"
fi
echo

# ----- Pre-flight -----
command -v npm >/dev/null    || die "npm not found"
command -v node >/dev/null   || die "node not found"
command -v git >/dev/null    || die "git not found"
command -v jq >/dev/null     || die "jq not found (brew install jq)"

# Working tree must be clean
if [[ -n "$(git status --porcelain)" ]]; then
  die "working tree is dirty -- commit or stash first"
fi

# Must be on main, up to date with origin
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin main
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
[[ "$LOCAL" == "$REMOTE" ]] || die "main is not in sync with origin/main (run 'git push' first)"

# ----- npm auth via token (skips 2FA OTP prompts) -----
# Resolve NPM_TOKEN. Honor an env-supplied token first (lets CI and machines
# whose keychain helper is broken publish without the bundle); otherwise read
# from the keychain-backed `npmjs.com` secrets bundle. The token must have
# publish access to both @phnx-labs and @companion; create automation tokens
# at https://www.npmjs.com/settings/<user>/tokens with the "Automation" type
# so 2FA is bypassed for publishes.
if [[ -z "${NPM_TOKEN:-}" ]]; then
  # Use local build if available (has latest keychain fixes), fallback to global
  if [[ -f "$ROOT/dist/index.js" ]]; then
    AGENTS_CMD="node $ROOT/dist/index.js"
  else
    command -v agents >/dev/null || die "'agents' CLI not on PATH (needed to read npmjs.com secrets bundle)"
    AGENTS_CMD="agents"
  fi
  NPM_BUNDLE_OUT="$($AGENTS_CMD secrets export npmjs.com --plaintext 2>/dev/null || true)"
  [[ -n "$NPM_BUNDLE_OUT" ]] || die "could not read 'npmjs.com' secrets bundle -- create it with: agents secrets create npmjs.com && agents secrets add npmjs.com NPM_TOKEN  (or export NPM_TOKEN=<token> before running this script)"
  NPM_TOKEN_LINE="$(printf '%s\n' "$NPM_BUNDLE_OUT" | grep -E '^export NPM_TOKEN=' | head -1)"
  [[ -n "$NPM_TOKEN_LINE" ]] || die "secrets bundle 'npmjs.com' is missing key NPM_TOKEN"
  # Strip 'export NPM_TOKEN=' prefix and surrounding quotes if any.
  NPM_TOKEN="${NPM_TOKEN_LINE#export NPM_TOKEN=}"
  NPM_TOKEN="${NPM_TOKEN%\"}"
  NPM_TOKEN="${NPM_TOKEN#\"}"
  NPM_TOKEN="${NPM_TOKEN%\'}"
  NPM_TOKEN="${NPM_TOKEN#\'}"
fi
[[ -n "$NPM_TOKEN" ]] || die "NPM_TOKEN resolved to empty string"

NPMRC_TMP="$(mktemp "${TMPDIR:-/tmp}/agents-cli-npmrc.XXXXXX")"
chmod 600 "$NPMRC_TMP"
# Use ${NPM_TOKEN} env var reference - npm expands it at runtime.
# Writing the token directly causes 404 errors for scoped packages.
printf '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nalways-auth=true\n' > "$NPMRC_TMP"
export NPM_TOKEN
export NPM_CONFIG_USERCONFIG="$NPMRC_TMP"

# Verify the token works.
NPM_USER="$(npm whoami 2>/dev/null || true)"
[[ -n "$NPM_USER" ]] || die "npm whoami failed with the resolved NPM_TOKEN -- token may be expired or lack publish scope"
green "npm authenticated as $NPM_USER (via npmjs.com bundle)"

# ----- Validate version bump -----
# Compare against current published latest of the canonical package.
PHNX_LATEST="$(npm view "$PHNX_PKG" version 2>/dev/null || true)"
[[ -n "$PHNX_LATEST" ]] || die "could not read latest version of $PHNX_PKG from npm"

SWARMIFY_LATEST="$(npm view "$SWARMIFY_PKG" version 2>/dev/null || echo "0.0.0")"

bold "Current published versions"
gray "  $PHNX_PKG       $PHNX_LATEST"
gray "  $SWARMIFY_PKG   $SWARMIFY_LATEST"
gray "  target           $TARGET"
echo

# Parse versions into M.m.p triples
parse_v() { echo "$1" | tr '.' ' '; }
read -r CMAJ CMIN CPAT <<< "$(parse_v "$PHNX_LATEST")"
read -r TMAJ TMIN TPAT <<< "$(parse_v "$TARGET")"

# Strict single-step bump from $PHNX_LATEST, OR equal to $PHNX_LATEST when the
# shim is still behind (shim catch-up rerun after a partial publish), OR equal
# to package.json on main when several patch commits accumulated without ever
# being published (phnx catch-up — main is ahead of registry).
is_valid_bump=false
read -r SMAJ SMIN SPAT <<< "$(parse_v "$SWARMIFY_LATEST")"
PKG_JSON_VERSION="$(jq -r .version package.json)"
if [[ $TMAJ -eq $CMAJ && $TMIN -eq $CMIN && $TPAT -eq $((CPAT + 1)) ]]; then
  BUMP="patch"
  is_valid_bump=true
elif [[ $TMAJ -eq $CMAJ && $TMIN -eq $((CMIN + 1)) && $TPAT -eq 0 ]]; then
  BUMP="minor"
  is_valid_bump=true
elif [[ $TMAJ -eq $((CMAJ + 1)) && $TMIN -eq 0 && $TPAT -eq 0 ]]; then
  BUMP="major"
  is_valid_bump=true
elif [[ "$TARGET" == "$PHNX_LATEST" ]] && \
     { [[ $TMAJ -gt $SMAJ ]] || \
       { [[ $TMAJ -eq $SMAJ ]] && [[ $TMIN -gt $SMIN ]]; } || \
       { [[ $TMAJ -eq $SMAJ ]] && [[ $TMIN -eq $SMIN ]] && [[ $TPAT -gt $SPAT ]]; }; }; then
  BUMP="shim-catchup"
  is_valid_bump=true
elif [[ "$TARGET" == "$PKG_JSON_VERSION" ]] && \
     { [[ $TMAJ -gt $CMAJ ]] || \
       { [[ $TMAJ -eq $CMAJ ]] && [[ $TMIN -gt $CMIN ]]; } || \
       { [[ $TMAJ -eq $CMAJ ]] && [[ $TMIN -eq $CMIN ]] && [[ $TPAT -gt $CPAT ]]; }; }; then
  # Catch-up: main has accumulated unpublished patch commits (chore(release):
  # N bumps that never reached the registry). Publish what main says.
  BUMP="phnx-catchup"
  is_valid_bump=true
fi

if ! $is_valid_bump; then
  red "invalid bump: $PHNX_LATEST -> $TARGET"
  red "expected one of:"
  red "  $((CMAJ)).$((CMIN)).$((CPAT + 1))   (patch)"
  red "  $((CMAJ)).$((CMIN + 1)).0   (minor)"
  red "  $((CMAJ + 1)).0.0   (major)"
  red "  $PKG_JSON_VERSION              (phnx-catchup: package.json is ahead of registry)"
  exit 1
fi

# Target must also be strictly newer than @companion latest (rare edge case),
# unless this is a shim-catchup where target == phnx_latest and shim is behind.
if [[ "$BUMP" != "shim-catchup" ]]; then
  if [[ "$TMAJ$TMIN$TPAT" == "$SMAJ$SMIN$SPAT" ]] || \
     { [[ $TMAJ -lt $SMAJ ]] || \
       { [[ $TMAJ -eq $SMAJ ]] && [[ $TMIN -lt $SMIN ]]; } || \
       { [[ $TMAJ -eq $SMAJ ]] && [[ $TMIN -eq $SMIN ]] && [[ $TPAT -le $SPAT ]]; }; }; then
    die "target $TARGET is not strictly newer than @companion latest $SWARMIFY_LATEST"
  fi
fi

green "Bump: $BUMP ($PHNX_LATEST -> $TARGET)"

# ----- Source of truth: npm registry says whether $TARGET is already published -----
# Run these checks NOW (before tests) so a re-run that's already partly published
# can short-circuit cleanly and the user can see what will actually happen.
PHNX_TARGET_PUBLISHED=false
if npm view "$PHNX_PKG@$TARGET" version >/dev/null 2>&1; then
  PHNX_TARGET_PUBLISHED=true
fi
gray "  $PHNX_PKG@$TARGET     $($PHNX_TARGET_PUBLISHED && echo 'already published — will skip' || echo 'will publish')"
echo

# ----- Sync package.json with target -----
ORIGINAL_PKG_VERSION="$(jq -r .version package.json)"
PKG_BUMPED=false
restore_package_json() {
  if $PKG_BUMPED; then
    tmp="$(mktemp)"
    jq --arg v "$ORIGINAL_PKG_VERSION" '.version = $v' package.json > "$tmp"
    mv "$tmp" package.json
    yellow "Reverted package.json to $ORIGINAL_PKG_VERSION"
  fi
}
# Initial trap; replaced later by cleanup_all once SHIM_TMP and NPMRC_TMP exist.
trap restore_package_json EXIT

if [[ "$ORIGINAL_PKG_VERSION" != "$TARGET" ]]; then
  yellow "Updating package.json: $ORIGINAL_PKG_VERSION -> $TARGET"
  tmp="$(mktemp)"
  jq --arg v "$TARGET" '.version = $v' package.json > "$tmp"
  mv "$tmp" package.json
  PKG_BUMPED=true
fi

# ----- Strict TypeScript check -----
# Run tsc --noEmit first so type errors surface clearly, separate from the
# real build's filesystem operations. This catches anything strict-mode
# tsconfig.json complains about (unused locals, implicit any, etc.).
bold "Type-checking (tsc --noEmit)..."
TSC_LOG="$(mktemp "${TMPDIR:-/tmp}/agents-cli-tsc.XXXXXX")"
if ! npx --no-install tsc --noEmit --pretty false > "$TSC_LOG" 2>&1; then
  red "TypeScript errors:"
  cat "$TSC_LOG" >&2
  rm -f "$TSC_LOG"
  die "fix the type errors above before releasing"
fi
# Even with exit 0, surface anything that looks like a warning or note we
# might have missed (tsc rarely emits these, but be paranoid).
if grep -iE '\bwarning\b|\bdeprecated\b' "$TSC_LOG" >/dev/null 2>&1; then
  red "tsc emitted warnings:"
  grep -iE '\bwarning\b|\bdeprecated\b' "$TSC_LOG" >&2
  rm -f "$TSC_LOG"
  die "fix the warnings above before releasing"
fi
rm -f "$TSC_LOG"
green "Type check clean."

# ----- Build (real artifacts) -----
bold "Building (bun run build)..."
rm -rf dist
BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/agents-cli-build.XXXXXX")"
if ! bun run build > "$BUILD_LOG" 2>&1; then
  red "Build failed:"
  cat "$BUILD_LOG" >&2
  rm -f "$BUILD_LOG"
  die "build failed"
fi
# Same paranoid scan over build output (the keychain copy step shouldn't
# print anything; if it does, we want to know).
if grep -iE '\berror\b|\bwarning\b' "$BUILD_LOG" >/dev/null 2>&1; then
  red "build emitted warnings/errors:"
  grep -iE '\berror\b|\bwarning\b' "$BUILD_LOG" >&2
  rm -f "$BUILD_LOG"
  die "fix the build output above before releasing"
fi
rm -f "$BUILD_LOG"
green "Build clean."

# ----- Tests (remote, on crabbox) -----
# The full suite runs on a leased crabbox VM, NOT locally: a release test run
# freezes the mac for minutes and the box matches the Linux CI environment.
# Publishing still happens here (the signed macOS keychain helper can only be
# produced + notarized locally) -- only the test gate is offloaded. sandbox.sh
# rsyncs this checkout to the box and runs the suite there. TASK_ID pins a
# stable remote workspace so re-runs of the same release reuse it.
if $SKIP_TESTS; then
  yellow "Skipping tests (--skip-tests)"
else
  # pipefail is on, so a failure in the remote run propagates through the pipe.
  # We tee the streamed output so a developer can scroll back through any
  # individual failure; the log is also scanned for silent unhandled errors.
  bold "Running tests on crabbox (scripts/sandbox.sh)..."
  TEST_LOG="$(mktemp "${TMPDIR:-/tmp}/agents-cli-test.XXXXXX")"
  # `bun run build` before test: crabbox's sync honors .gitignore, so the
  # gitignored dist/ never reaches the box -- the integration tests that spawn
  # a child importing dist/ need it built there. Matches ci.yml (Build->Test).
  if ! TASK_ID="release-$TARGET" "$ROOT/scripts/sandbox.sh" "bun install && bun run build && bun run test" 2>&1 | tee "$TEST_LOG"; then
    red "Tests failed (crabbox)."
    rm -f "$TEST_LOG"
    die "fix failing tests before releasing"
  fi
  # vitest sometimes prints "Unhandled error between tests" without failing
  # the run. Catch that and treat it as a release blocker.
  if grep -E 'Unhandled error|UnhandledPromiseRejection' "$TEST_LOG" >/dev/null 2>&1; then
    red "test run had unhandled errors:"
    grep -E 'Unhandled error|UnhandledPromiseRejection' "$TEST_LOG" >&2
    rm -f "$TEST_LOG"
    die "investigate the unhandled errors above before releasing"
  fi
  rm -f "$TEST_LOG"
  green "Tests clean."
fi
echo

# ----- Tarball preview (always) -----
bold "Tarball preview ($PHNX_PKG@$TARGET)"
npm pack --dry-run 2>&1 | tail -10
echo

# ----- Build the shim package on disk so we can preview/publish it -----
bold "Building $SWARMIFY_PKG@$TARGET shim..."
SHIM_SRC="$ROOT/scripts/companion-shim"
SHIM_TMP="$(mktemp -d "${TMPDIR:-/tmp}/agents-cli-shim.XXXXXX")"
# Cleanup of SHIM_TMP layered onto the existing EXIT trap (which restores
# package.json on abort). bash only keeps the most recent EXIT trap, so we
# define a combined cleanup function.
cleanup_all() {
  restore_package_json
  rm -rf "${SHIM_TMP:-}"
  rm -f "${NPMRC_TMP:-}"
}
trap cleanup_all EXIT

cp -R "$SHIM_SRC/bin" "$SHIM_SRC/scripts" "$SHIM_SRC/README.md" "$SHIM_TMP/"
cat > "$SHIM_TMP/package.json" <<EOF
{
  "name": "$SWARMIFY_PKG",
  "version": "$TARGET",
  "description": "This package has moved to $PHNX_PKG. Install that instead.",
  "dependencies": {
    "$PHNX_PKG": "$TARGET"
  },
  "bin": {
    "agents": "bin/agents.js",
    "ag": "bin/agents.js"
  },
  "scripts": {
    "postinstall": "node scripts/postinstall.js"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/phnx-labs/agents-cli.git"
  },
  "homepage": "https://agents-cli.sh",
  "bugs": {
    "url": "https://github.com/phnx-labs/agents-cli/issues"
  }
}
EOF

bold "Tarball preview ($SWARMIFY_PKG@$TARGET shim)"
( cd "$SHIM_TMP" && npm pack --dry-run 2>&1 | tail -10 )
echo

# ----- Bail out here in DRY-RUN mode -----
if ! $APPLY; then
  green "Dry run looks good. Re-run with --apply to publish $TARGET to both packages."
  echo
  yellow "Will run on --apply (using NPM_TOKEN from npmjs.com bundle, no 2FA prompts):"
  yellow "  1. git commit -m 'chore(release): $TARGET'  (skipped if HEAD already is)"
  yellow "  2. git tag v$TARGET                          (skipped if tag exists)"
  yellow "  3. npm publish $PHNX_PKG@$TARGET             (skipped if already on registry)"
  yellow "  4. npm publish $SWARMIFY_PKG@$TARGET shim    (skipped if already on registry)"
  yellow "  5. git push origin main + tag"
  exit 0
fi

# ----- Confirmation (--apply only) -----
if ! $YES; then
  read -r -p "Publish $TARGET to BOTH $PHNX_PKG and $SWARMIFY_PKG? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || die "aborted"
fi

# Past this point we want to keep the bumped package.json, since we're
# committing it. Disable the auto-revert.
PKG_BUMPED=false

# ----- Roll the changelog: promote "## Unreleased" -> "## $TARGET" -----
# Without this, every release leaves its notes stranded under "Unreleased" and
# the section grows across releases with no per-version headers. Only fires when
# the Unreleased section actually has content, so a notes-less release can't
# create an empty version header.
if [[ -f CHANGELOG.md ]]; then
  unrel_content="$(awk '/^## Unreleased[[:space:]]*$/{f=1;next} f&&/^## /{exit} f&&/[^[:space:]]/{print}' CHANGELOG.md)"
  if [[ -n "$unrel_content" ]]; then
    tmp_cl="$(mktemp)"
    awk -v ver="$TARGET" '
      ins { print; next }
      seen && /^## / { print; ins=1; seen=0; next }
      seen && /[^[:space:]]/ { print "## " ver; print ""; print; ins=1; seen=0; next }
      seen { print; next }
      /^## Unreleased[[:space:]]*$/ { print; seen=1; next }
      { print }
    ' CHANGELOG.md > "$tmp_cl"
    mv "$tmp_cl" CHANGELOG.md
    git add CHANGELOG.md
    green "Rolled CHANGELOG: ## Unreleased -> ## $TARGET"
  else
    gray "CHANGELOG: no Unreleased content to roll"
  fi
fi

# ----- Commit (idempotent on package.json diff alone) -----
git add package.json
if ! git diff --cached --quiet; then
  git commit -m "chore(release): $TARGET"
  green "Created release commit"
else
  gray "package.json already at $TARGET, no commit needed"
fi

# ----- Tag at HEAD (idempotent on tag presence) -----
if git rev-parse --verify --quiet "refs/tags/v$TARGET" >/dev/null; then
  gray "Tag v$TARGET already exists, leaving alone"
else
  git tag "v$TARGET"
  green "Created tag v$TARGET at HEAD ($(git rev-parse --short HEAD))"
fi

# ----- Publish @phnx-labs (skip if pre-flight saw it on registry) -----
bold "Publishing $PHNX_PKG@$TARGET..."
if $PHNX_TARGET_PUBLISHED; then
  yellow "$PHNX_PKG@$TARGET is already on the registry, skipping publish"
elif ! npm publish --access=public --provenance=false; then
  red "publish failed for $PHNX_PKG"
  red "the version commit and tag remain locally; rerun: $0 $TARGET --apply"
  exit 1
else
  green "Published $PHNX_PKG@$TARGET"
fi
echo

# @swarmify/agents-cli legacy shim no longer published as of v1.20.0.

# ----- Push commit + tag -----
bold "Pushing commit and tag to origin..."
git push origin main
git push origin "v$TARGET"

green "Released $TARGET to both packages"
