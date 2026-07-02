#!/usr/bin/env bash
#
# Release script for agents-cli.
#
# Publishes @phnx-labs/agents-cli (the canonical package) to npm. The legacy
# @swarmify/agents-cli shim is built + previewed for reference but NOT published
# (frozen at 1.19.x since v1.20.0).
#
# Flow (--apply): open the release as a chore(release) PR on a release/v<version>
# branch -- which fires the full cross-platform CI matrix (.github/workflows/
# ci.yml) plus the test + gitleaks checks -- wait for that CI to go green,
# squash-merge the PR, verify the merged tree matches what we built, then tag
# v<version> at the merge commit and npm-publish locally (publishing must stay on
# macOS because the tarball bundles the signed + notarized keychain helper).
#
# Usage: scripts/release.sh <version> [--apply]
#
# Default mode is DRY-RUN: every local check runs (type-check, build, tarball
# preview) and the detected release state is reported, but nothing is pushed,
# opened, merged, tagged, or published. Add --apply to actually release. Tests
# run in CI on the release PR, not locally.
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
  yellow "Mode: DRY-RUN (no branch, PR, merge, tag, publish, or push -- pass --apply to actually release)"
fi
echo

# ----- Pre-flight -----
command -v npm >/dev/null    || die "npm not found"
command -v node >/dev/null   || die "node not found"
command -v git >/dev/null    || die "git not found"
command -v jq >/dev/null     || die "jq not found (brew install jq)"
command -v gh >/dev/null      || die "gh (GitHub CLI) not found (brew install gh) -- needed to open + merge the release PR"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated -- run 'gh auth login'"

# Working tree must be clean. This is load-bearing: the release commit is built
# straight from the index via 'git write-tree' (see the apply phase), so a dirty
# tree would smuggle unrelated changes into the release PR + published tarball.
if [[ -n "$(git status --porcelain)" ]]; then
  die "working tree is dirty -- commit or stash first"
fi

# Resolve the default branch dynamically; must be on it and in sync with origin.
git fetch --quiet origin
DEFAULT_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
[[ -n "$DEFAULT_BRANCH" ]] || DEFAULT_BRANCH="main"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "$DEFAULT_BRANCH" ]] || die "not on $DEFAULT_BRANCH (on '$BRANCH') -- release runs from the default branch"
BASE_SHA="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$DEFAULT_BRANCH")"
[[ "$BASE_SHA" == "$REMOTE" ]] || die "$DEFAULT_BRANCH is not in sync with origin/$DEFAULT_BRANCH (run 'git push' first)"

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

# ----- Tests: run in CI on the release PR, not here -----
# The suite is no longer run locally / on crabbox at release time. The apply
# phase opens the release as a PR on a release/v<version> branch, which triggers
# the full cross-platform CI matrix (.github/workflows/ci.yml) plus the 'test'
# and 'gitleaks' checks; the script blocks on that CI being green before it
# merges and publishes (see "Wait for CI" below). Running the suite here too
# would double-run it (a crabbox lease + minutes) and create a second source of
# truth. Local 'tsc --noEmit' + 'bun run build' above stay as the fast pre-PR
# fail-fast (and the build is needed for the tarball preview + publish anyway).
# --skip-tests is accepted for backward compatibility but is now a no-op.
if $SKIP_TESTS; then
  gray "(--skip-tests: tests run in CI on the release PR now; flag is a no-op)"
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
  # Revert any working-tree edits to package.json / CHANGELOG.md back to HEAD so
  # that an abort (or a dry-run exit) always leaves a clean, re-runnable
  # checkout. HEAD never moves during a release (the release commit is pushed via
  # commit-tree, and the merge lands on origin only), so HEAD is the pre-release
  # state. The success path already restores these before exiting, making this a
  # no-op there. Falls back to the jq revert if git checkout is unavailable.
  git checkout -q HEAD -- package.json CHANGELOG.md 2>/dev/null || restore_package_json
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
  "license": "Apache-2.0",
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

# ----- Detect prior-run state (for idempotent re-runs + dry-run reporting) -----
# Everything keys off external truth (npm registry + git + open PRs), never off
# local commit subjects, so a half-finished release re-runs cleanly.
RELEASE_BRANCH="release/v$TARGET"
MAIN_AT_TARGET=false
if [[ "$(git show "origin/$DEFAULT_BRANCH:package.json" 2>/dev/null | jq -r .version 2>/dev/null || echo '')" == "$TARGET" ]]; then
  MAIN_AT_TARGET=true   # a prior run already merged the chore(release) PR
fi
EXISTING_PR="$(gh pr list --head "$RELEASE_BRANCH" --state open --json number --jq '.[0].number // empty' 2>/dev/null || true)"

# ----- Bail out here in DRY-RUN mode -----
if ! $APPLY; then
  green "Dry run looks good. Re-run with --apply to release $TARGET via a PR."
  echo
  bold "Detected state:"
  gray "  default branch            $DEFAULT_BRANCH @ ${BASE_SHA:0:9}"
  gray "  $PHNX_PKG@$TARGET on npm     $($PHNX_TARGET_PUBLISHED && echo yes || echo no)"
  gray "  origin/$DEFAULT_BRANCH at $TARGET   $($MAIN_AT_TARGET && echo yes || echo no)"
  gray "  open release PR           ${EXISTING_PR:-none} ($RELEASE_BRANCH)"
  echo
  yellow "Will run on --apply (NPM_TOKEN from npmjs.com bundle, no 2FA prompts):"
  yellow "  1. roll CHANGELOG '## Unreleased' -> '## $TARGET'"
  yellow "  2. push branch $RELEASE_BRANCH (chore(release): $TARGET) -> fires the full CI matrix"
  yellow "  3. open a PR into $DEFAULT_BRANCH"
  yellow "  4. wait for CI green (matrix + test + gitleaks), fail-closed"
  yellow "  5. squash-merge the PR"
  yellow "  6. verify merged tree == built tree, tag v$TARGET at the merge commit"
  yellow "  7. npm publish $PHNX_PKG@$TARGET, push the tag"
  gray   "  (steps already done in a prior run are skipped: published / merged / PR-open / tag-exists)"
  exit 0
fi

# ----- Confirmation (--apply only) -----
if ! $YES; then
  read -r -p "Release $TARGET via a PR into $DEFAULT_BRANCH, then publish $PHNX_PKG? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || die "aborted"
fi

# Auto-revert of the package.json bump is no longer wanted here — the bump is
# carried into the release branch commit (and the cleanup trap reverts the
# working tree to HEAD on any abort, keeping re-runs clean).
PKG_BUMPED=false

# ----- Short-circuit: already published -----
# Registry is the source of truth. If the version is live, the release happened;
# just make sure the tag exists on the merged commit and is pushed.
if $PHNX_TARGET_PUBLISHED; then
  green "$PHNX_PKG@$TARGET is already on the registry."
  if ! git ls-remote --exit-code --tags origin "v$TARGET" >/dev/null 2>&1; then
    git tag -f "v$TARGET" "origin/$DEFAULT_BRANCH" >/dev/null
    git push origin "v$TARGET" && green "Pushed missing tag v$TARGET"
  else
    gray "Tag v$TARGET already on origin, nothing to do."
  fi
  exit 0
fi

# ----- Wait for CI to go green on a PR (bounded + fail-closed) -----
# Poll `gh pr checks` on a hard deadline rather than `gh pr checks --watch`: the
# watch is UNBOUNDED (a check that registers then stalls -- e.g. tests.yml's
# `test` job hanging -- would hang the release forever) and it can
# exit 0 on a partial set. This loop waits until every expected context is
# present AND terminal (capped at 60m), then re-asserts each is a pass and dies
# otherwise. NOTE: these names are the job/matrix labels of ci.yml (the build
# matrix), tests.yml (test), and secret-scan.yml (gitleaks) -- a rename there
# must be mirrored here, or the release times out (fail-closed, never publishes).
EXPECTED_CHECKS=(test gitleaks \
  "build (ubuntu-latest, 22)"  "build (ubuntu-latest, 24)" \
  "build (macos-latest, 22)"   "build (macos-latest, 24)" \
  "build (windows-latest, 22)" "build (windows-latest, 24)")
check_bucket() { jq -r --arg n "$1" 'map(select(.name==$n)) | (.[0].bucket // "missing")' <<<"$2"; }
wait_for_ci_green() {
  local pr="$1" ctx b results problem=0
  bold "Waiting for CI on PR #$pr (full matrix + test + gitleaks; up to 60m)..."
  local deadline=$(( $(date +%s) + 3600 ))
  while :; do
    results="$(gh pr checks "$pr" --json name,bucket 2>/dev/null || echo '[]')"
    local waiting=0
    for ctx in "${EXPECTED_CHECKS[@]}"; do
      b="$(check_bucket "$ctx" "$results")"
      [[ "$b" == "missing" || "$b" == "pending" ]] && { waiting=1; break; }
    done
    (( waiting == 0 )) && break
    (( $(date +%s) > deadline )) && { red "Timed out after 60m waiting for CI on PR #$pr."; break; }
    sleep 20
  done
  results="$(gh pr checks "$pr" --json name,bucket 2>/dev/null || echo '[]')"
  for ctx in "${EXPECTED_CHECKS[@]}"; do
    b="$(check_bucket "$ctx" "$results")"
    [[ "$b" == "pass" ]] || { red "  $ctx: $b"; problem=1; }
  done
  (( problem == 0 )) || die "CI not all-green on PR #$pr -- PR left OPEN. Fix on a normal PR to $DEFAULT_BRANCH, then re-run this script."
  green "CI all-green on PR #$pr."
}

# ----- Open (or reuse) the release PR + merge, unless already merged -----
if ! $MAIN_AT_TARGET; then
  # Roll the changelog: promote "## Unreleased" -> "## $TARGET". Only fires when
  # the Unreleased section has content, so a notes-less release can't create an
  # empty version header. The rolled notes become the PR body.
  PR_BODY="Release $TARGET."
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
      green "Rolled CHANGELOG: ## Unreleased -> ## $TARGET"
      PR_BODY="$(printf '## %s\n\n%s' "$TARGET" "$unrel_content")"
    else
      gray "CHANGELOG: no Unreleased content to roll"
    fi
  fi

  # Build the release commit from the index WITHOUT moving HEAD. The signed +
  # notarized macOS apps under bin/ are untracked, so we must build + publish
  # from THIS checkout; a worktree off origin/main would fail prepack. write-tree
  # is safe because the working tree is clean apart from our package.json +
  # CHANGELOG edits (enforced by the clean-tree preflight).
  git add package.json CHANGELOG.md
  BRANCH_TREE="$(git write-tree)"
  RELEASE_COMMIT="$(git commit-tree "$BRANCH_TREE" -p "$BASE_SHA" -m "chore(release): $TARGET")"

  PR_NUMBER=""
  if [[ -n "$EXISTING_PR" ]]; then
    PR_NUMBER="$EXISTING_PR"
    EXISTING_HEAD="$(gh pr view "$EXISTING_PR" --json headRefOid --jq .headRefOid 2>/dev/null || true)"
    if [[ -n "$EXISTING_HEAD" && "$(git rev-parse "$EXISTING_HEAD^{tree}" 2>/dev/null || true)" == "$BRANCH_TREE" ]]; then
      gray "Reusing open PR #$PR_NUMBER ($RELEASE_BRANCH); branch tree already matches."
    else
      git push --force-with-lease origin "$RELEASE_COMMIT:refs/heads/$RELEASE_BRANCH"
      gray "Updated PR #$PR_NUMBER branch to the freshly built release commit."
    fi
  else
    # force-with-lease, not a plain push: a prior run may have left a stale
    # release/v<version> branch with no open PR. RELEASE_COMMIT is a fresh
    # commit-tree (a sibling of that stale tip, not a descendant), so a non-force
    # push would be rejected non-fast-forward and brick the re-run. The lease is
    # safe -- preflight fetched origin, so we only overwrite a ref we have seen.
    git push --force-with-lease origin "$RELEASE_COMMIT:refs/heads/$RELEASE_BRANCH"
    green "Pushed $RELEASE_BRANCH"
  fi

  # The branch commit now durably holds the bump + changelog; restore the working
  # tree to clean so a CI-red abort leaves a re-runnable checkout.
  git checkout -q HEAD -- package.json CHANGELOG.md

  if [[ -z "$PR_NUMBER" ]]; then
    gh pr create --base "$DEFAULT_BRANCH" --head "$RELEASE_BRANCH" \
      --title "chore(release): $TARGET" --body "$PR_BODY" >/dev/null \
      || die "failed to open release PR for $RELEASE_BRANCH"
    PR_NUMBER="$(gh pr view "$RELEASE_BRANCH" --json number --jq .number 2>/dev/null || true)"
    [[ -n "$PR_NUMBER" ]] || die "opened PR but could not resolve its number for $RELEASE_BRANCH"
    green "Opened release PR #$PR_NUMBER"
  fi

  wait_for_ci_green "$PR_NUMBER"

  # Squash-merge. Never --admin: branch protection must hold, and the ruleset has
  # no PR-review rule, so green test+gitleaks is a sufficient, non-bypass merge.
  bold "Merging PR #$PR_NUMBER (squash)..."
  gh pr merge "$PR_NUMBER" --squash --delete-branch || die "merge failed for PR #$PR_NUMBER (left open)"
  green "Merged PR #$PR_NUMBER"
fi

# ----- Resolve the merged commit + integrity guards (before any publish) -----
git fetch --quiet origin "$DEFAULT_BRANCH"
MERGED_SHA="$(git rev-parse "origin/$DEFAULT_BRANCH")"
MERGED_VER="$(git show "$MERGED_SHA:package.json" | jq -r .version)"
[[ "$MERGED_VER" == "$TARGET" ]] || die "merged $DEFAULT_BRANCH is at $MERGED_VER, not $TARGET -- refusing to tag/publish"
if [[ -n "${BRANCH_TREE:-}" ]]; then
  # A single-commit squash onto an unchanged base yields a tree identical to what
  # we built + published from. A mismatch means a concurrent merge or a stray
  # push landed on the branch -- the local tarball would not match merged main.
  [[ "$(git rev-parse "$MERGED_SHA^{tree}")" == "$BRANCH_TREE" ]] \
    || die "merged tree != built tree -- refusing to publish (concurrent merge or stray push on $RELEASE_BRANCH)"
fi

# Bring the working-tree package.json/CHANGELOG to exactly the merged code so the
# published tarball matches merged main. dist/ was already built from the same
# source (base + bump) earlier and is unaffected.
git checkout -q "$MERGED_SHA" -- package.json CHANGELOG.md

# ----- Tag at the merged commit (idempotent) -----
if git rev-parse --verify --quiet "refs/tags/v$TARGET" >/dev/null; then
  gray "Tag v$TARGET already exists locally, leaving alone"
else
  git tag "v$TARGET" "$MERGED_SHA"
  green "Created tag v$TARGET at $(git rev-parse --short "$MERGED_SHA")"
fi

# ----- Publish @phnx-labs -----
bold "Publishing $PHNX_PKG@$TARGET..."
if ! npm publish --access=public --provenance=false; then
  red "publish failed for $PHNX_PKG"
  red "the PR is merged and the tag exists locally; rerun to retry publish: $0 $TARGET --apply"
  exit 1
fi
green "Published $PHNX_PKG@$TARGET"
echo

# @swarmify/agents-cli legacy shim no longer published as of v1.20.0.

# ----- Push the tag; restore the working tree to a clean state -----
git push origin "v$TARGET"
git checkout -q HEAD -- package.json CHANGELOG.md 2>/dev/null || true

green "Released $TARGET"
gray "Local $DEFAULT_BRANCH is behind origin by the release commit -- run: git pull --ff-only"
