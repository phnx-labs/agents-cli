#!/usr/bin/env bash
#
# Release script for agents-cli. Self-routing, zero-config.
#
# Publishes @phnx-labs/agents-cli (the canonical package) to npm. The legacy
# @swarmify/agents-cli shim is built + previewed for reference but NOT published
# (frozen at 1.19.x since v1.20.0).
#
# Three self-selected homes, no environment variables to set:
#   - Orchestrate (bump, changelog, PR, tag): the box you invoke it on (git + gh).
#   - CI / tests: a crabbox (dynamic Hetzner Linux VM) via scripts/sandbox.sh --
#     never a hardcoded instance. Covers the Linux suite; the GH Actions matrix
#     still covers the cross-platform (macOS/Windows) legs on the release PR.
#   - Build + sign + notarize + npm publish + computer-helper: the mac-mini home
#     base (the one hardcoded name -- it holds the Developer ID cert + npm publish
#     rights). If you invoke from mac-mini it runs locally; otherwise the script
#     ssh's to mac-mini, checks out the merged tag, and runs the privileged phase
#     there in mac-mini's headless secrets context (no Touch ID, no token borrow).
#
# Flow (--apply): run the Linux suite on a crabbox; open the release as a
# chore(release) PR on a release/v<version> branch -- which fires the full
# cross-platform CI matrix (.github/workflows/ci.yml) plus the test + gitleaks
# checks -- wait for that CI to go green, squash-merge the PR, verify the merged
# tree matches what we built, then tag v<version> at the merge commit and route
# the build+sign+publish phase to the home base. If a publish fails after the PR
# merge, a retry rebuilds from that merged PR's exact CI-tested tree even when
# newer commits have since landed on main.
#
# Usage: scripts/release.sh <version> [--apply]
#
# Default mode is DRY-RUN: every local check runs (type-check, build, tarball
# preview) and the detected release state is reported, but nothing is pushed,
# opened, merged, tagged, or published. Add --apply to actually release. Tests
# run on a crabbox (Linux) + in the GH Actions matrix on the release PR.
#
# Validates that <version> is a single-step bump from the current published
# @phnx-labs latest -- patch+1, or minor+1 with patch=0, or major+1 with
# minor=patch=0. No skips. Two exceptions cover main running ahead of the
# registry: the version main already carries (phnx-catchup), and the next patch
# after it (patch-from-main) for when main's own version can no longer be
# published because its merged release PR no longer matches the tree CI tested.

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

# ----- Home base: the one hardcoded machine name (owner-endorsed) -----
# The build/sign/notarize/publish/computer-helper phase MUST run here: it is the
# only box that holds the Developer ID cert + npm publish rights + the headless
# signing/secrets context. This is a constant, NOT an env var -- nobody sets
# anything to release. Everything else self-selects (crabbox for tests; the
# invoking box for git+gh orchestration).
readonly RELEASE_HOME_BASE="mac-mini"

# Detect the short hostname of the box we are on, portably (macOS + Linux), and
# compute whether we are already on the home base. `scutil --get LocalHostName`
# is the macOS name that matches the ssh/Tailscale name; `hostname -s` is the
# Linux short name.
if [[ "$(uname)" == "Darwin" ]]; then
  THIS_HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
else
  THIS_HOST="$(hostname -s 2>/dev/null || hostname)"
fi
ON_HOME_BASE=false
[[ "$THIS_HOST" == "$RELEASE_HOME_BASE" ]] && ON_HOME_BASE=true

# ----- Phase tracker -----
# A running [n/N] progress line the operator can follow: each phase names the box
# it runs on, and closes with a ✓ (pass) or ✗ (fail + one-line cause). Reuses the
# bold/green/red helpers above. TOTAL_PHASES is the count for the current mode.
PHASE_NUM=0
TOTAL_PHASES=6
phase() {
  PHASE_NUM=$((PHASE_NUM + 1))
  bold "[$PHASE_NUM/$TOTAL_PHASES] $1  (on: $2)"
}
phase_ok()   { green "  ✓ $1"; }
# phase_fail prints the ✗ + cause + (optional) log location, then aborts. This is
# the single failure surface: never a bare "CI red" or a silent hang.
phase_fail() {
  red "  ✗ $1"
  [[ -n "${2:-}" ]] && red "    log: $2"
  exit 1
}

# ----- Parse args -----
APPLY=false
SKIP_TESTS=false
YES=false
# --home-base-phase is an INTERNAL entrypoint, not a user knob: the trigger box
# ssh's release.sh onto the home base with this flag to run ONLY the privileged
# publish phase (build + sign + notarize + npm publish + computer-helper) against
# an already-merged+tagged release. It is never something an operator passes.
HOME_BASE_PHASE=false
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --skip-tests) SKIP_TESTS=true ;;
    --yes|-y) YES=true ;;
    --home-base-phase) HOME_BASE_PHASE=true ;;
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
gray "  this box:   $THIS_HOST$($ON_HOME_BASE && echo '  (home base)' || echo '')"
gray "  home base:  $RELEASE_HOME_BASE  (build + sign + notarize + npm publish + computer-helper)"
gray "  tests:      a crabbox (dynamic Hetzner Linux VM, selected at run time)"
echo

# ----- Privileged phase on the home base (internal --home-base-phase entrypoint) -----
# This runs the TAGGED release.sh (route_home_base_phase checks out the tag into a
# worktree and invokes THAT worktree's script with --home-base-phase), so the
# script executing here is guaranteed to carry --home-base-phase and
# headless-sign-context.sh. It therefore assumes it is ALREADY inside the tagged
# worktree ($ROOT = <tag-worktree>/apps/cli, cwd set by the caller): it verifies
# the checked-out version == $TARGET, then builds the signed macOS artifacts
# fresh (the home base is the sign host), publishes to npm with the token resolved
# HERE, and pushes the computer-helper asset. It does NOT create its own worktree.
run_home_base_phase() {
  [[ "$(uname)" == "Darwin" ]] \
    || die "the home base ($RELEASE_HOME_BASE) must be macOS to build + sign + notarize + publish"
  command -v npm >/dev/null  || die "npm not found on $RELEASE_HOME_BASE"
  command -v node >/dev/null || die "node not found on $RELEASE_HOME_BASE"
  command -v git >/dev/null  || die "git not found on $RELEASE_HOME_BASE"
  command -v jq >/dev/null   || die "jq not found on $RELEASE_HOME_BASE (brew install jq)"
  command -v gh >/dev/null   || die "gh not found on $RELEASE_HOME_BASE (needed for the computer-helper release asset)"

  cd "$ROOT"

  # Registry is the source of truth. If already published, nothing to do -- the
  # privileged phase is idempotent (the trigger box already handled the tag).
  if npm view "$PHNX_PKG@$TARGET" version >/dev/null 2>&1; then
    green "$PHNX_PKG@$TARGET already on the registry -- nothing to publish"
    return 0
  fi

  # We are inside the tagged worktree already; verify the checked-out tree is
  # actually $TARGET before signing/publishing.
  local checked_out_ver
  checked_out_ver="$(jq -r .version package.json)"
  [[ "$checked_out_ver" == "$TARGET" ]] \
    || die "checked-out tree is at $checked_out_ver, not $TARGET -- refusing to build/publish on $RELEASE_HOME_BASE"

  # Enter the headless signing + secrets context (shared with remote-sign-mac.sh):
  # unlocks rush-signing.keychain-db + exports AGENTS_SECRETS_PASSPHRASE so
  # codesign, notarytool, AND `agents secrets` (npmjs.com token + apple.com creds)
  # all resolve with NO Touch ID and NO per-secret prompt. This must run BEFORE
  # resolve_npm_auth, which reads the npmjs.com bundle.
  command -v agents >/dev/null 2>&1 \
    || die "'agents' CLI not on PATH on $RELEASE_HOME_BASE -- needed to inject apple.com/npmjs.com creds"
  # shellcheck source=scripts/headless-sign-context.sh
  . scripts/headless-sign-context.sh

  # npm auth resolves HERE, on the home base, in its headless secrets context --
  # the token never crosses to the box that invoked the release.
  resolve_npm_auth

  bun install --frozen-lockfile >/dev/null \
    || die "dependency install failed in the tagged worktree on $RELEASE_HOME_BASE"

  # Sign + notarize the standalone binary, build the signed helpers, then publish.
  # These reuse the same scripts the macOS-local release path uses. The apple.com
  # bundle resolves headlessly (the context above set AGENTS_SECRETS_PASSPHRASE).
  bold "Signing + notarizing the standalone agents binary + helpers on $RELEASE_HOME_BASE..."
  agents secrets exec apple.com -- scripts/sign-cli-binary.sh \
    || die "CLI binary sign/notarize failed on $RELEASE_HOME_BASE"
  # The keychain + menu-bar helpers are the other signed .apps the tarball bundles.
  # Build them directly here so bin/ is populated before `bun run build`.
  agents secrets exec apple.com -- bash -c '
    set -euo pipefail
    menubar/scripts/build.sh release
    rm -rf bin/MenubarHelper.app
    cp -R menubar/dist/MenubarHelper.app bin/MenubarHelper.app
    codesign --verify --deep --strict "bin/MenubarHelper.app"
    scripts/build-keychain-helper.sh
    shasum -a 256 "bin/Agents CLI.app/Contents/MacOS/Agents CLI" > "scripts/Agents CLI.app.sha256"
  ' || die "signed helper build failed on $RELEASE_HOME_BASE"

  bold "Building (bun run build) on $RELEASE_HOME_BASE..."
  rm -rf dist
  bun run build >/dev/null || die "build failed on $RELEASE_HOME_BASE"

  bold "Publishing $PHNX_PKG@$TARGET from $RELEASE_HOME_BASE..."
  npm publish --access=public --provenance=false \
    || die "npm publish failed on $RELEASE_HOME_BASE (tag exists; rerun to retry)"
  green "Published $PHNX_PKG@$TARGET"

  # Publish the signed + notarized macOS computer helper as the release asset.
  # Best-effort: npm is already published, so a failure here is a warning.
  bold "Publishing the macOS computer helper asset for v$TARGET..."
  agents secrets exec apple.com -- scripts/publish-computer-helper-mac.sh "$TARGET" \
    || yellow "computer-helper publish failed -- retry on $RELEASE_HOME_BASE: agents secrets exec apple.com -- apps/cli/scripts/publish-computer-helper-mac.sh $TARGET"
}

# Resolve the npm publish token from the local `npmjs.com` secrets bundle and
# write a temp .npmrc. Called ONLY on the home base (by run_home_base_phase),
# inside the headless secrets context, so the token never crosses to the trigger
# box. Defined here (before the --home-base-phase dispatch) so that entrypoint,
# which exits before the trigger-box preflight, can reach it.
resolve_npm_auth() {
  local bundle_out token_line
  # Read the npmjs.com bundle via the globally-installed `agents` (homebrew). We
  # resolve the token BEFORE the build, so the worktree's own dist/ does not exist
  # yet -- there is no local build to prefer, and the headless context sourced
  # above has already set AGENTS_SECRETS_PASSPHRASE so this resolves silently.
  command -v agents >/dev/null || die "'agents' CLI not on PATH (needed to read npmjs.com secrets bundle on $RELEASE_HOME_BASE)"
  bundle_out="$(agents secrets export npmjs.com --plaintext 2>/dev/null || true)"
  [[ -n "$bundle_out" ]] \
    || die "no 'npmjs.com' secrets bundle on $RELEASE_HOME_BASE -- the home base must hold the publish token (agents secrets create npmjs.com && agents secrets add npmjs.com NPM_TOKEN)"
  token_line="$(printf '%s\n' "$bundle_out" | grep -E '^export NPM_TOKEN=' | head -1)"
  [[ -n "$token_line" ]] || die "secrets bundle 'npmjs.com' is missing key NPM_TOKEN"
  NPM_TOKEN="${token_line#export NPM_TOKEN=}"
  NPM_TOKEN="${NPM_TOKEN%\"}"; NPM_TOKEN="${NPM_TOKEN#\"}"
  NPM_TOKEN="${NPM_TOKEN%\'}"; NPM_TOKEN="${NPM_TOKEN#\'}"
  [[ -n "$NPM_TOKEN" ]] || die "NPM_TOKEN resolved to empty string on $RELEASE_HOME_BASE"

  NPMRC_TMP="$(mktemp "${TMPDIR:-/tmp}/agents-cli-npmrc.XXXXXX")"
  chmod 600 "$NPMRC_TMP"
  # Use ${NPM_TOKEN} env var reference - npm expands it at runtime. Writing the
  # token directly causes 404 errors for scoped packages.
  # shellcheck disable=SC2016
  printf '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nalways-auth=true\n' > "$NPMRC_TMP"
  export NPM_TOKEN
  export NPM_CONFIG_USERCONFIG="$NPMRC_TMP"

  local npm_user
  npm_user="$(npm whoami 2>/dev/null || true)"
  [[ -n "$npm_user" ]] || die "npm whoami failed with the resolved NPM_TOKEN on $RELEASE_HOME_BASE -- token may be expired or lack publish scope"
  green "npm authenticated as $npm_user (via npmjs.com bundle on $RELEASE_HOME_BASE)"
}

# Echo the commit a remote tag points at (peeled first, then direct). Defined here
# so both the --home-base-phase entrypoint and the trigger-box flow can use it.
remote_tag_commit() {
  local tag="$1" refs peeled direct
  refs="$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}")"
  peeled="$(awk '$2 ~ /\^\{\}$/ { print $1; exit }' <<<"$refs")"
  direct="$(awk '$2 !~ /\^\{\}$/ { print $1; exit }' <<<"$refs")"
  printf '%s' "${peeled:-$direct}"
}

# The internal --home-base-phase entrypoint short-circuits everything else.
if $HOME_BASE_PHASE; then
  [[ -n "$TARGET" ]] || die "--home-base-phase needs a <version>"
  bold "[home-base phase] build + sign + notarize + npm publish + computer-helper on $THIS_HOST"
  # NPMRC_TMP is cleaned up on exit; declare the trap here since the trigger-box
  # traps below are not reached on this path.
  NPMRC_TMP=""
  trap 'rm -f "${NPMRC_TMP:-}"' EXIT
  run_home_base_phase
  green "Released $TARGET (home-base phase)"
  exit 0
fi

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

# ----- npm auth: resolved ON the home base, never borrowed to the trigger box -----
# The npm publish token lives only on the home base (mac-mini) and is resolved
# there (resolve_npm_auth, defined above), in its headless secrets context, at
# publish time -- it never crosses to the box that invoked the release. Anonymous
# `npm view` reads below (latest version, is-target-published) need no token, so
# version validation + the already-published short-circuit run fine on any box.

# ----- Tests on a crabbox (dynamic Hetzner Linux VM) -----
# scripts/sandbox.sh already selects an available crabbox for THIS repo's profile
# (or warms a fresh one) and runs an arbitrary command on it -- never a hardcoded
# box. We run the full suite there, capture its output to a log, and on failure
# print which tests failed + the log location and HALT before any PR/publish.
# This covers the LINUX suite; the GH Actions CI matrix on the release PR still
# covers the cross-platform (macOS/Windows) legs (see wait_for_ci_green below).
run_crabbox_tests() {
  local log rc
  # X placeholders MUST be the trailing characters: BSD mktemp (macOS) treats
  # any suffix after them as part of a literal filename, so this template created
  # a real file called "…crabbox-tests.XXXXXX.log" and every later release on the
  # same box then died with "mkstemp failed: File exists". Matches the other
  # mktemp templates in this script.
  log="$(mktemp "${TMPDIR:-/tmp}/agents-cli-crabbox-tests.XXXXXX")"
  bold "Running the Linux test suite on a crabbox (dynamic Hetzner VM)..."
  gray "  (streaming; full log captured at $log)"
  # sandbox.sh with no --pr flag = test mode: rsync this tree to the box, run the
  # command. tee both streams so the operator watches live AND we keep the log.
  # Pass ONE string (sandbox does cmd="$*" and embeds it into a remote bash -c
  # script). Nested `bash -c '…'` loses quotes and becomes `bash -c cd …`.
  # Crabbox syncs the monorepo root; CLI tests live under apps/cli.
  if scripts/sandbox.sh -- 'cd apps/cli && bun install && bun run test' 2>&1 | tee "$log"; then
    rc=0
  else
    rc="${PIPESTATUS[0]}"
  fi
  if [[ "$rc" != "0" ]]; then
    red "  ✗ crabbox tests FAILED (exit $rc)"
    # Surface the actual failing test names + assertion output, not a bare "red".
    local fails
    fails="$(grep -E '^\s*(FAIL|×|✗|not ok|AssertionError|Error:|Expected|Received)' "$log" | head -40 || true)"
    if [[ -n "$fails" ]]; then
      red "  failing tests / errors:"
      printf '%s\n' "$fails" | while IFS= read -r line; do red "    $line"; done
    fi
    phase_fail "Linux tests failed on the crabbox -- release halted before opening a PR" "$log"
  fi
  phase_ok "crabbox tests passed (full log: $log)"
}

# ----- Route the privileged phase to the home base -----
# After the trigger box has merged + tagged the release (git + gh, which need the
# invoking box's auth), the build+sign+notarize+publish+computer-helper phase runs
# on the home base -- always from the TAGGED release.sh, checked out into a
# throwaway worktree at v$TARGET, so the home base's own on-disk checkout (which,
# on the first release after this PR merges, predates --home-base-phase) is never
# executed. If we ARE the home base, do the checkout + run locally; otherwise the
# same steps run over ssh on $RELEASE_HOME_BASE. The npm token is resolved on the
# home base -- it never crosses to the trigger box.
#
# HOME_BASE_WT_SNIPPET is the shared shell that both paths run (locally via bash,
# or remotely via ssh): fetch origin + the tag, verify the tag's version, create a
# detached worktree at v$TARGET, and run THAT worktree's
# apps/cli/scripts/release.sh $TARGET --home-base-phase. The worktree is removed on
# exit whether the phase succeeds or fails (BLOCKER 3), via a scoped EXIT trap.
home_base_wt_snippet() {
  # $1 = version. Emits a self-contained bash program (no outer-shell expansion of
  # runtime values beyond the version, which is validated MAJOR.MINOR.PATCH).
  cat <<SNIPPET
set -euo pipefail
REPO_ROOT="\$(git rev-parse --show-toplevel)"
git -C "\$REPO_ROOT" fetch --quiet origin
git -C "\$REPO_ROOT" fetch --quiet origin "refs/tags/v$1:refs/tags/v$1" 2>/dev/null || true
git -C "\$REPO_ROOT" rev-parse --verify --quiet "refs/tags/v$1^{commit}" >/dev/null \\
  || { echo "tag v$1 not found on the home base after fetch" >&2; exit 1; }
TAG_VER="\$(git -C "\$REPO_ROOT" show "v$1:apps/cli/package.json" | jq -r .version)"
[ "\$TAG_VER" = "$1" ] \\
  || { echo "tag v$1 tree is at \$TAG_VER, not $1 -- refusing home-base phase" >&2; exit 1; }
WT="\$REPO_ROOT/.agents/worktrees/homebase-publish-v$1-\$\$"
trap 'git -C "\$REPO_ROOT" worktree remove --force "\$WT" >/dev/null 2>&1 || true' EXIT
git -C "\$REPO_ROOT" worktree add --quiet --detach "\$WT" "v$1" \\
  || { echo "could not create home-base publish worktree at \$WT" >&2; exit 1; }
[ -z "\$(git -C "\$WT" status --short | grep '^ D')" ] \\
  || { echo "home-base publish worktree \$WT is incomplete -- refusing to build" >&2; exit 1; }
cd "\$WT/apps/cli"
scripts/release.sh $1 --home-base-phase
SNIPPET
}
route_home_base_phase() {
  local snippet
  snippet="$(home_base_wt_snippet "$TARGET")"
  if $ON_HOME_BASE; then
    bold "Building + signing + publishing on the home base ($RELEASE_HOME_BASE, this box) from the tagged tree..."
    # cwd is this repo's apps/cli (ROOT), so the snippet's `git rev-parse
    # --show-toplevel` resolves the checkout we are in.
    bash -c "$snippet" || return 1
    return 0
  fi
  bold "Routing build + sign + publish to the home base ($RELEASE_HOME_BASE) over ssh (from the tagged tree)..."
  # Over ssh the remote shell starts in $HOME, so cd into the home base's checkout
  # first; then run the SAME snippet. `bash -lc` puts `agents` (homebrew) +
  # node/bun on PATH for the headless signing + secrets resolution. The snippet is
  # passed on stdin so no quoting of its body is needed across the ssh hop; $HOME
  # expands on the REMOTE side (single-quoted).
  ssh "$RELEASE_HOME_BASE" 'bash -lc "cd \$HOME/src/github.com/muqsitnawaz/agents-cli && bash -s"' <<<"$snippet" \
    || return 1
}

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

# Which kind of bump is this? The arithmetic lives in scripts/validate-bump.sh
# so it can be tested directly (scripts/validate-bump.test.ts) — reaching it
# here requires a clean main, npm auth and gh auth first. It prints the bump
# kind, or the accepted versions to stderr and exits 1.
PKG_JSON_VERSION="$(jq -r .version package.json)"
if ! BUMP="$(scripts/validate-bump.sh "$PHNX_LATEST" "$PKG_JSON_VERSION" "$SWARMIFY_LATEST" "$TARGET")"; then
  exit 1
fi
read -r SMAJ SMIN SPAT <<< "$(parse_v "$SWARMIFY_LATEST")"

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

# ----- Detect prior-run state (for idempotent re-runs + dry-run reporting) -----
# Everything keys off external truth (npm registry + git + PRs), never local
# commit subjects. Resolve this before building so a retry can build the exact
# merged release tree rather than whatever newer code now happens to be on main.
RELEASE_BRANCH="release/v$TARGET"
MAIN_AT_TARGET=false
if [[ "$(git show "origin/$DEFAULT_BRANCH:apps/cli/package.json" 2>/dev/null | jq -r .version 2>/dev/null || echo '')" == "$TARGET" ]]; then
  MAIN_AT_TARGET=true
fi

# Phase count for the [n/N] tracker, computed for the actual path taken so it
# never shows gaps or a wrong denominator. Normal release runs 6 phases:
# preflight, crabbox tests, PR+CI+merge, tag, publish, verify. A catch-up publish
# (main already at $TARGET) skips the tests + PR+CI+merge phases -> 4 phases.
if $MAIN_AT_TARGET; then
  TOTAL_PHASES=4
else
  TOTAL_PHASES=6
fi
EXISTING_PR="$(gh pr list --head "$RELEASE_BRANCH" --state open --json number --jq '.[0].number // empty' 2>/dev/null || true)"
MERGED_RELEASE_JSON="$(gh pr list --head "$RELEASE_BRANCH" --base "$DEFAULT_BRANCH" --state merged --limit 1 --json number,mergeCommit,headRefOid 2>/dev/null || echo '[]')"
MERGED_RELEASE_PR="$(jq -r '.[0].number // empty' <<<"$MERGED_RELEASE_JSON")"
MERGED_RELEASE_SHA="$(jq -r '.[0].mergeCommit.oid // empty' <<<"$MERGED_RELEASE_JSON")"
MERGED_RELEASE_HEAD="$(jq -r '.[0].headRefOid // empty' <<<"$MERGED_RELEASE_JSON")"

HISTORICAL_CATCHUP=false
HISTORICAL_WT=""
INVOKING_ROOT="$ROOT"
REPO_ROOT="$(git rev-parse --show-toplevel)"
PKG_BUMPED=false
remove_historical_worktree() {
  if [[ -n "${HISTORICAL_WT:-}" ]]; then
    cd "$INVOKING_ROOT"
    git -C "$REPO_ROOT" worktree remove --force "$HISTORICAL_WT" >/dev/null 2>&1 || true
    HISTORICAL_WT=""
  fi
}
cleanup_early() {
  rm -f "${NPMRC_TMP:-}"
  remove_historical_worktree
}
trap cleanup_early EXIT

if $MAIN_AT_TARGET && ! $PHNX_TARGET_PUBLISHED && [[ -n "$MERGED_RELEASE_SHA" ]] && [[ "$MERGED_RELEASE_SHA" != "$BASE_SHA" ]]; then
  [[ -n "$MERGED_RELEASE_PR" && -n "$MERGED_RELEASE_HEAD" ]] \
    || die "main is ahead of the unpublished $TARGET release, but release PR metadata is incomplete"
  git fetch --quiet origin "pull/$MERGED_RELEASE_PR/head" \
    || die "could not fetch the CI-tested head for merged release PR #$MERGED_RELEASE_PR"
  CI_TESTED_HEAD="$(git rev-parse FETCH_HEAD)"
  [[ "$CI_TESTED_HEAD" == "$MERGED_RELEASE_HEAD" ]] \
    || die "fetched PR head ${CI_TESTED_HEAD:0:9} != recorded release head ${MERGED_RELEASE_HEAD:0:9} -- refusing catch-up publish"
  if [[ "$(git rev-parse "$CI_TESTED_HEAD^{tree}")" != "$(git rev-parse "$MERGED_RELEASE_SHA^{tree}")" ]]; then
    yellow "$DEFAULT_BRANCH drifted since release PR #$MERGED_RELEASE_PR merged (concurrent merges); will tag + publish the CI-tested head ${CI_TESTED_HEAD:0:9}, not the drifted merge."
  fi
  [[ "$(git show "$MERGED_RELEASE_SHA:apps/cli/package.json" | jq -r .version)" == "$TARGET" ]] \
    || die "merged release PR #$MERGED_RELEASE_PR is not version $TARGET"

  # The catch-up guards above (CI-tested head match + tree match + version match)
  # are preserved intact -- they gate an unverified retry publish. What is NOT
  # done here anymore: building the signed macOS artifacts on the trigger box.
  # The whole privileged phase (build + sign + notarize + publish + computer-
  # helper) now runs on the home base against the tagged tree, so no staged
  # helper / historical worktree build is needed on the invoking box.
  HISTORICAL_CATCHUP=true
  bold "Catch-up: main already at $TARGET (merged PR #$MERGED_RELEASE_PR at ${MERGED_RELEASE_SHA:0:9}); routing publish to the home base."
fi

# ----- Sync package.json with target -----
ORIGINAL_PKG_VERSION="$(jq -r .version package.json)"
restore_package_json() {
  if $PKG_BUMPED; then
    tmp="$(mktemp)"
    jq --arg v "$ORIGINAL_PKG_VERSION" '.version = $v' package.json > "$tmp"
    mv "$tmp" package.json
    yellow "Reverted package.json to $ORIGINAL_PKG_VERSION"
  fi
  cleanup_early
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

# The build + sign + notarize of the signed macOS artifacts no longer happens on
# the trigger box: it runs on the home base ($RELEASE_HOME_BASE) in the privileged
# phase (run_home_base_phase / --home-base-phase). That box is the only one with
# the Developer ID cert + headless signing context, and every release rebuilds the
# version-stamped standalone binary there. The trigger box's job is the fast local
# fail-fast (tsc, above) + orchestration (tests on a crabbox, PR, merge, tag).

# ----- Tests -----
# The Linux suite runs on a dynamic crabbox in the --apply flow, before the PR is
# opened (see run_crabbox_tests / the "[2/6] Linux tests" phase below); the GH
# Actions CI matrix on the release PR then covers the macOS/Windows legs. Local
# 'tsc --noEmit' above is the fast pre-flight fail-fast. --skip-tests skips the
# crabbox lease only (CI still gates the PR).

# ----- Tarball preview (home base only) -----
# `npm pack --dry-run` fires prepack, whose verify-keychain-helper.sh /
# verify-menubar-helper.sh / verify-cli-binary.sh gates need the signed macOS
# artifacts. Those are built only on the home base, so the preview runs there.
# On the trigger box we skip it and note where the real tarball is produced.
if $ON_HOME_BASE && [[ -d dist && -d "bin/Agents CLI.app" ]]; then
  bold "Tarball preview ($PHNX_PKG@$TARGET)"
  npm pack --dry-run 2>&1 | tail -10
else
  gray "Tarball preview skipped on $THIS_HOST -- the signed tarball is built + packed on the home base ($RELEASE_HOME_BASE)."
fi
echo

# ----- Build the shim package on disk so we can preview/publish it -----
bold "Building $SWARMIFY_PKG@$TARGET shim..."
SHIM_SRC="$ROOT/scripts/companion-shim"
SHIM_TMP="$(mktemp -d "${TMPDIR:-/tmp}/agents-cli-shim.XXXXXX")"
# Cleanup of SHIM_TMP layered onto the existing EXIT trap (which restores
# package.json on abort). bash only keeps the most recent EXIT trap, so we
# Reset the changelog working-tree edits (bump + folded queue + regenerated
# aggregate) back to HEAD so an abort or dry-run always leaves a clean,
# re-runnable checkout. release-changelog.ts creates .changelog/$TARGET.md (new),
# drains .changelog/next/* (deletes), and rewrites CHANGELOG.md — `git checkout`
# alone won't drop the newly-added version file, so remove it explicitly first.
restore_release_tree() {
  if [[ -n "${TARGET:-}" ]]; then
    rm -f ".changelog/$TARGET.md"
    git reset -q -- ".changelog/$TARGET.md" >/dev/null 2>&1 || true
  fi
  git checkout -q HEAD -- package.json CHANGELOG.md .changelog 2>/dev/null || restore_package_json
}

# define a combined cleanup function.
cleanup_all() {
  # Revert any working-tree edits to package.json / CHANGELOG.md back to HEAD so
  # that an abort (or a dry-run exit) always leaves a clean, re-runnable
  # checkout. HEAD never moves during a release (the release commit is pushed via
  # commit-tree, and the merge lands on origin only), so HEAD is the pre-release
  # state. The success path already restores these before exiting, making this a
  # no-op there. Falls back to the jq revert if git checkout is unavailable.
  restore_release_tree
  rm -rf "${SHIM_TMP:-}"
  rm -f "${NPMRC_TMP:-}"
  remove_historical_worktree
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

# ----- Bail out here in DRY-RUN mode -----
if ! $APPLY; then
  green "Dry run looks good. Re-run with --apply to release $TARGET via a PR."
  echo
  bold "Detected state:"
  gray "  default branch            $DEFAULT_BRANCH @ ${BASE_SHA:0:9}"
  gray "  $PHNX_PKG@$TARGET on npm     $($PHNX_TARGET_PUBLISHED && echo yes || echo no)"
  gray "  origin/$DEFAULT_BRANCH at $TARGET   $($MAIN_AT_TARGET && echo yes || echo no)"
  gray "  open release PR           ${EXISTING_PR:-none} ($RELEASE_BRANCH)"
  gray "  merged release PR         ${MERGED_RELEASE_PR:-none} ($RELEASE_BRANCH)"
  echo
  yellow "Will run on --apply (self-routing, zero-config -- no env vars, no 2FA prompt):"
  yellow "  1. [this box: $THIS_HOST] fold .changelog/next/* -> .changelog/$TARGET.md + regenerate CHANGELOG.md"
  yellow "  2. [crabbox]  run the Linux test suite on a dynamic Hetzner VM; halt on failure"
  yellow "  3. [this box] push branch $RELEASE_BRANCH (chore(release): $TARGET) -> fires the CI matrix; open a PR"
  yellow "  4. [this box] wait for CI green (matrix + test + gitleaks), fail-closed"
  yellow "  5. [this box] squash-merge the PR; verify merged tree == expected; tag v$TARGET"
  yellow "  6. [$RELEASE_HOME_BASE] build + sign + notarize + npm publish + push tag + computer-helper (token resolved there)"
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

phase "Preflight + version validation complete" "$THIS_HOST"
phase_ok "clean $DEFAULT_BRANCH, bump $BUMP ($PHNX_LATEST -> $TARGET), type check + tarball preview done"

# ----- Short-circuit: already published -----
# Registry is the source of truth. If the version is live, the release happened;
# just make sure the tag exists on the merged commit and is pushed.
if $PHNX_TARGET_PUBLISHED; then
  green "$PHNX_PKG@$TARGET is already on the registry."
  REMOTE_TAG_SHA="$(remote_tag_commit "v$TARGET")"
  if [[ -z "$REMOTE_TAG_SHA" ]]; then
    # Published but no tag yet: tag the exact commit that was shipped. When a
    # merged release PR is known, apply the same drift rule as the primary flow --
    # the CI-tested PR head over the drifted merge -- by re-fetching the PR head
    # here (CI_TESTED_HEAD is only populated on the not-yet-published paths, so it
    # is never set on this branch). Otherwise fall back to the default branch.
    if [[ -n "$MERGED_RELEASE_PR" && -n "$MERGED_RELEASE_SHA" ]]; then
      git fetch --quiet origin "pull/$MERGED_RELEASE_PR/head" \
        || die "could not fetch the CI-tested head for merged release PR #$MERGED_RELEASE_PR"
      TAG_TARGET="$(scripts/select-publish-commit.sh "$MERGED_RELEASE_SHA" "$(git rev-parse FETCH_HEAD)")"
    else
      TAG_TARGET="origin/$DEFAULT_BRANCH"
    fi
    [[ "$(git show "$TAG_TARGET:apps/cli/package.json" | jq -r .version)" == "$TARGET" ]] \
      || die "refusing to create v$TARGET: $TAG_TARGET does not contain package version $TARGET"
    git tag -f "v$TARGET" "$(git rev-parse "$TAG_TARGET^{commit}")" >/dev/null
    git push origin "v$TARGET" && green "Pushed missing tag v$TARGET"
  else
    # Already published + tagged: accept any tag that references version TARGET. A
    # drift-fallback release tags the CI-tested PR head rather than the merge
    # commit, so verify the tag's own tree carries TARGET instead of requiring it
    # to equal the merge commit. Fetch --force so a stale local v$TARGET (from a
    # prior tagging attempt) is overwritten rather than leaving the fetch rejected
    # ("would clobber existing tag") and reading the stale ref; never swallow the
    # fetch's exit code.
    git fetch --quiet --force origin "refs/tags/v$TARGET:refs/tags/v$TARGET" \
      || die "could not fetch remote tag v$TARGET to verify its version"
    [[ "$(git show "v$TARGET:apps/cli/package.json" | jq -r .version)" == "$TARGET" ]] \
      || die "remote tag v$TARGET points at $REMOTE_TAG_SHA, which is not version $TARGET"
    gray "Tag v$TARGET already present for the published release."
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
# matrix), tests.yml (test-shard 1..3 + typecheck + compiled-smoke), and
# secret-scan.yml (gitleaks) -- a rename/reshard there must be mirrored here, or
# the release times out (fail-closed, never publishes). tests.yml was resharded
# from a single `test` job into `test-shard (N)` + `typecheck` + `compiled-smoke`;
# the stale `test` name here hung every release for the full 60m before failing
# (found + fixed 2026-07-29 cutting 1.20.73).
EXPECTED_CHECKS=("test-shard (1)" "test-shard (2)" "test-shard (3)" typecheck compiled-smoke gitleaks \
  "build (ubuntu-latest, 22)"  "build (ubuntu-latest, 24)" \
  "build (macos-latest, 22)"   "build (macos-latest, 24)")
# The Windows build jobs gate the release by default. Set RELEASE_REQUIRE_WINDOWS=0 to
# drop them from the wait when Windows CI is red on pre-existing, Windows-only test
# breakage (POSIX file-mode / symlink assertions that don't hold on win32) unrelated to
# the release diff. Windows is not a required check on this repo, so skipping the wait
# never merges past a real branch-protection gate -- it only stops a known-noisy matrix
# leg from blocking an otherwise-green, reviewed release.
if [[ "${RELEASE_REQUIRE_WINDOWS:-1}" == "1" ]]; then
  EXPECTED_CHECKS+=("build (windows-latest, 22)" "build (windows-latest, 24)")
fi
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

# A prior normal release run can merge its PR and then fail before publishing.
# Re-running must reuse the exact CI-tested release tree — never treat a manual
# package.json bump or a squash merge containing concurrent main changes as
# release validation. This is the catch-up hole that let 1.20.58 publish before
# its Windows tag matrix failed.
if $MAIN_AT_TARGET && ! $PHNX_TARGET_PUBLISHED; then
  [[ -n "$MERGED_RELEASE_PR" && -n "$MERGED_RELEASE_SHA" && -n "$MERGED_RELEASE_HEAD" ]] \
    || die "main is already at $TARGET but no complete merged $RELEASE_BRANCH PR exists -- refusing an unverified catch-up publish; cut the next patch through the normal release PR flow"
  if [[ -z "${CI_TESTED_HEAD:-}" ]]; then
    git fetch --quiet origin "pull/$MERGED_RELEASE_PR/head" \
      || die "could not fetch the CI-tested head for merged release PR #$MERGED_RELEASE_PR"
    CI_TESTED_HEAD="$(git rev-parse FETCH_HEAD)"
  fi
  [[ "$CI_TESTED_HEAD" == "$MERGED_RELEASE_HEAD" ]] \
    || die "fetched PR head ${CI_TESTED_HEAD:0:9} != recorded release head ${MERGED_RELEASE_HEAD:0:9} -- refusing catch-up publish"
  if [[ "$(git rev-parse "$CI_TESTED_HEAD^{tree}")" != "$(git rev-parse "$MERGED_RELEASE_SHA^{tree}")" ]]; then
    yellow "$DEFAULT_BRANCH drifted since release PR #$MERGED_RELEASE_PR merged (concurrent merges); will tag + publish the CI-tested head ${CI_TESTED_HEAD:0:9}, not the drifted merge."
  fi
  # This IS a catch-up: the release PR is merged and only the tag + publish remain,
  # so phase 4 must resolve the release commit from the merged PR (MERGED_RELEASE_SHA
  # + CI_TESTED_HEAD, both resolved above) rather than from RELEASE_COMMIT, which only
  # the branch-creating path defines. The earlier detection at the top of the script
  # sets this too, but only when main has moved PAST the release merge; when main sits
  # exactly AT the merge commit -- the normal state after a merge -- only this block
  # runs, and leaving the flag false made phase 4 dereference an unset RELEASE_COMMIT
  # and abort under `set -u`. That aborted every retry of an unpublished release.
  HISTORICAL_CATCHUP=true
  bold "Re-validating CI from merged release PR #$MERGED_RELEASE_PR before catch-up publish..."
  wait_for_ci_green "$MERGED_RELEASE_PR"
fi

# ----- Tests on a crabbox (before opening the PR) -----
# Only for a genuinely new release (a catch-up publish already went through CI on
# its merged PR). On failure this halts before any PR/publish with the failing
# tests + log location. --skip-tests skips the crabbox lease (CI still gates the
# PR below). Covers Linux; the GH Actions matrix on the PR covers macOS/Windows.
#
# Test the CLEAN, pre-bump tree: the only working-tree mutation so far is the
# package.json version bump, and the suite is version-independent, so we revert to
# $ORIGINAL_PKG_VERSION for the rsync (sandbox.sh copies the working tree) and
# re-apply the bump afterward. This avoids testing a half-mutated tree (bumped
# version but not-yet-folded changelog) that never actually ships.
if ! $MAIN_AT_TARGET; then
  phase "Linux tests" "a crabbox"
  if $SKIP_TESTS; then
    gray "(--skip-tests: skipping the crabbox Linux suite; the GH Actions CI matrix still gates the PR)"
    phase_ok "skipped (--skip-tests); GH Actions CI still gates the PR"
  else
    if $PKG_BUMPED; then
      _rb_tmp="$(mktemp)"
      jq --arg v "$ORIGINAL_PKG_VERSION" '.version = $v' package.json > "$_rb_tmp" && mv "$_rb_tmp" package.json
    fi
    run_crabbox_tests
    if $PKG_BUMPED; then
      _rb_tmp="$(mktemp)"
      jq --arg v "$TARGET" '.version = $v' package.json > "$_rb_tmp" && mv "$_rb_tmp" package.json
    fi
  fi
fi

# ----- Open (or reuse) the release PR + merge, unless already merged -----
if ! $MAIN_AT_TARGET; then
  phase "Open release PR, wait for the CI matrix (macOS/Windows/Linux), merge" "$THIS_HOST + GH Actions"
  # Collapse the release queue: fold every .changelog/next/<slug>.md fragment into
  # .changelog/$TARGET.md, then regenerate the released-only aggregate CHANGELOG.md.
  # Fails closed if the queue is empty (a release must document itself). The folded
  # notes become the PR body. Uses `if ! NOTES=$(...)` — not a bare `NOTES=$(...)`
  # assignment, which would swallow a non-zero exit under `set -e`.
  PR_BODY="Release $TARGET."
  if ! NOTES="$(bun scripts/release-changelog.ts "$TARGET")"; then
    red "CHANGELOG queue empty (or fold failed) — a release must document itself." >&2
    red "  Add a note at .changelog/next/<ticket>.md before releasing $TARGET." >&2
    exit 1
  fi
  PR_BODY="$(printf '## %s\n\n%s' "$TARGET" "$NOTES")"
  green "Folded .changelog/next/* -> .changelog/$TARGET.md; regenerated CHANGELOG.md"

  # Build the release commit from the index WITHOUT moving HEAD. The signed +
  # notarized macOS apps under bin/ are untracked, so we must build + publish
  # from THIS checkout; a worktree off origin/main would fail prepack. write-tree
  # is safe because the working tree is clean apart from our package.json +
  # CHANGELOG edits (enforced by the clean-tree preflight).
  git add -A package.json CHANGELOG.md .changelog
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
  restore_release_tree

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
  phase_ok "PR #$PR_NUMBER: CI matrix all-green, squash-merged"
fi

# Phase 4 (both paths): resolve the CI-tested release commit + create/push the tag.
phase "Verify CI-tested tree + tag v$TARGET" "$THIS_HOST"

# ----- Resolve the merge commit + the CI-tested release commit -----
# The published tarball MUST be a tree the full CI matrix went green on. Normally
# that is the commit that landed on the default branch. But the default branch is
# busy: if unrelated PRs merge during this release PR's CI window, the squash-merge
# lands on a newer base and its tree diverges from what CI actually tested. In that
# case we do NOT publish the drifted, never-tested-as-a-unit merge tree -- we tag +
# publish the exact release commit the matrix validated (the PR head), and the
# commits that merged during the window ride the next release.
git fetch --quiet origin "$DEFAULT_BRANCH"
if $HISTORICAL_CATCHUP; then
  MERGED_SHA="$MERGED_RELEASE_SHA"
  CI_COMMIT="$CI_TESTED_HEAD"                 # the merged release PR's CI-tested head
else
  MERGED_SHA="$(git rev-parse "origin/$DEFAULT_BRANCH")"
  CI_COMMIT="$RELEASE_COMMIT"                 # the release PR head this run built + CI-tested
fi
MERGED_VER="$(git show "$MERGED_SHA:apps/cli/package.json" | jq -r .version)"
[[ "$MERGED_VER" == "$TARGET" ]] || die "merged $DEFAULT_BRANCH is at $MERGED_VER, not $TARGET -- refusing to tag/publish"

# CI_COMMIT is, by construction, the commit GH Actions ran the full matrix on (a
# normal run built it via commit-tree and pushed it as the PR head; a catch-up
# fetched it from pull/<pr>/head and re-asserted CI green). Its tree is the
# CI-tested tree. Re-assert its version so we never tag a mismatched commit.
[[ -n "${CI_COMMIT:-}" ]] || die "internal: no CI-tested release commit resolved -- refusing to publish"
[[ "$(git show "$CI_COMMIT:apps/cli/package.json" | jq -r .version)" == "$TARGET" ]] \
  || die "CI-tested release commit ${CI_COMMIT:0:9} is not version $TARGET -- refusing to publish"

# Tag the merge commit when its tree still matches the CI-tested tree (clean, keeps
# the tag on the default branch); on concurrent-merge drift, tag the CI-tested
# release commit so the published artifact is exactly what CI validated.
PUBLISH_SHA="$(scripts/select-publish-commit.sh "$MERGED_SHA" "$CI_COMMIT")"
if [[ "$PUBLISH_SHA" != "$MERGED_SHA" ]]; then
  yellow "Concurrent merge drifted $DEFAULT_BRANCH during CI; tagging the CI-tested release commit ${PUBLISH_SHA:0:9} (its tree passed the full matrix). Commits that merged during the window ride the next release."
fi

# The published tarball is built on the home base from a fresh checkout of the
# tag (below), so the trigger box's working tree is not the publish source and is
# left untouched here -- restore_release_tree keeps it clean for a re-run.

# ----- Tag at the CI-tested release commit (idempotent) -----
REMOTE_TAG_SHA="$(remote_tag_commit "v$TARGET")"
[[ -z "$REMOTE_TAG_SHA" || "$REMOTE_TAG_SHA" == "$PUBLISH_SHA" ]] \
  || die "remote tag v$TARGET points at $REMOTE_TAG_SHA, not verified release commit $PUBLISH_SHA"
if git rev-parse --verify --quiet "refs/tags/v$TARGET" >/dev/null; then
  [[ "$(git rev-parse "refs/tags/v$TARGET^{commit}")" == "$PUBLISH_SHA" ]] \
    || die "local tag v$TARGET does not point at the verified release commit $PUBLISH_SHA"
  gray "Tag v$TARGET already exists locally at the verified release commit"
else
  git tag "v$TARGET" "$PUBLISH_SHA"
  green "Created tag v$TARGET at $(git rev-parse --short "$PUBLISH_SHA")"
fi

# ----- Push the tag (git, on the trigger box) so the home base can resolve it -----
# The tag is created + pushed here, before the privileged phase, so the home base
# resolves the exact release commit from origin. @swarmify/agents-cli legacy shim
# is no longer published as of v1.20.0.
git push origin "v$TARGET"
phase_ok "CI-tested tree verified; tag v$TARGET at ${PUBLISH_SHA:0:9} pushed"

# Restore the working tree to clean now that the tag is durable; the privileged
# phase below builds from a fresh checkout of the tag (locally on the home base,
# or over ssh), never from this working tree.
restore_release_tree

# ----- Privileged phase: build + sign + notarize + npm publish + computer-helper -----
# Routes to the home base ($RELEASE_HOME_BASE): inline if we ARE it, else over ssh.
# The npm token is resolved on the home base and never crosses to this box. On
# failure this halts with the cause; the tag + merge are durable, so a re-run
# resumes at the publish (the already-published short-circuit + tag idempotency
# make it safe).
phase "Build + sign + notarize + npm publish + computer-helper" "$RELEASE_HOME_BASE"
route_home_base_phase \
  || phase_fail "privileged phase failed on the home base ($RELEASE_HOME_BASE) -- PR merged + tag v$TARGET pushed; rerun to retry: $0 $TARGET --apply"
phase_ok "published $PHNX_PKG@$TARGET from $RELEASE_HOME_BASE (token resolved there; no Touch ID)"

# ----- Verify the published version live (from the trigger box) -----
phase "Verify live" "$THIS_HOST"
PUBLISHED_NOW="$(npm view "$PHNX_PKG@$TARGET" version 2>/dev/null || true)"
if [[ "$PUBLISHED_NOW" == "$TARGET" ]]; then
  phase_ok "npm registry reports $PHNX_PKG@$TARGET; tag v$TARGET pushed"
else
  phase_fail "npm registry does not yet report $PHNX_PKG@$TARGET (saw '${PUBLISHED_NOW:-none}') -- check the home-base publish output"
fi

green "Released $TARGET"
gray "Local $DEFAULT_BRANCH is behind origin by the release commit -- run: git pull --ff-only"
