#!/usr/bin/env bash
#
# Release script for agents-cli. Self-routing, zero-config.
#
# Publishes @phnx-labs/agents-cli (the canonical package) to npm. The legacy
# @swarmify/agents-cli shim is built + previewed for reference but NOT published
# (frozen at 1.19.x since v1.20.0).
#
# Three self-selected homes, no environment variables to set:
#   - Orchestrate (bump, changelog, PR, tag): a release-owned detached worktree
#     on the box you invoke it on (git + gh), based on fresh origin/<default>.
#   - Proof: exact-tree attestations (tree + toolchain + lockfile + policy) plus
#     the pretested npm tarball they name. Ordinary release never re-runs the
#     full suite and never accepts parent/nearby commit evidence.
#   - Promote: the home base (any OS, mac-mini by default, `--device <name>`)
#     holds the npm publish identity. It publishes the exact attested .tgz,
#     reuses immutable helper artifacts, and runs a real install smoke.
#     Sign/notarize of helpers is outside this ordinary path (RUSH-3026).
#
# Flow (--apply): require a passing attestation for origin/<default>; open the
# chore(release) PR; require an attestation + pretested tarball for the release
# commit tree; squash-merge only when the final default-branch tree equals that
# attested candidate; tag; promote the exact .tgz. Ordinary release P99 is
# <=180 seconds. A retry still demands the same exact-tree key.
#
# Usage: scripts/release.sh <version> [--apply] [--device <name>]
#
# --device <name> (alias --host) picks the Mac that builds/signs/publishes;
# defaults to mac-mini. Everything else is unchanged and zero-config.
#
# Default mode is DRY-RUN: every local check runs (type-check) and the detected
# release state is reported, but nothing is pushed, opened, merged, tagged, or
# published. Add --apply to actually release. Functional proof is the exact-tree
# attestation; the published artifact is the attested tarball.
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

# ----- Home base: which machine runs the promote + npm publish phase -----
# Promote-only (RUSH-3026): the phase needs the npm publish token + gh auth,
# nothing macOS-specific. It defaults to mac-mini and is overridable with
# `--device <name>` (parsed below, alias `--host`) so a release can be driven
# to any promote-ready box when mac-mini is down. Not an env var -- the target
# is a flag with a default, never ambient config. Everything else self-selects (attestations for proof;
# the invoking box for git+gh orchestration).
readonly RELEASE_HOME_BASE_DEFAULT="mac-mini"

# Detect the short hostname of the box we are on, portably (macOS + Linux).
# `scutil --get LocalHostName` is the macOS name that matches the ssh/Tailscale
# name; `hostname -s` is the Linux short name. ON_HOME_BASE is computed after arg
# parse, once --device has resolved the effective RELEASE_HOME_BASE.
if [[ "$(uname)" == "Darwin" ]]; then
  THIS_HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
else
  THIS_HOST="$(hostname -s 2>/dev/null || hostname)"
fi

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
# --orchestration-phase is an INTERNAL marker added only by release-worktree.sh.
# It prevents the release-owned checkout from recursively creating another one.
ORCHESTRATION_PHASE=false
TARGET=""
# --device <name> (alias --host) selects the Mac that runs the privileged
# build + sign + notarize + npm publish phase; defaults to mac-mini. A for-loop
# with a pending flag (not `shift`) preserves "$@" intact, so the release-worktree
# re-exec (RELEASE_ARGS=("$@")) forwards every arg including --device.
DEVICE=""
expect_device=false
for arg in "$@"; do
  if $expect_device; then DEVICE="$arg"; expect_device=false; continue; fi
  case "$arg" in
    --apply) APPLY=true ;;
    --skip-tests) SKIP_TESTS=true ;;
    --yes|-y) YES=true ;;
    --home-base-phase) HOME_BASE_PHASE=true ;;
    --orchestration-phase) ORCHESTRATION_PHASE=true ;;
    --device|--host) expect_device=true ;;
    --device=*|--host=*) DEVICE="${arg#*=}" ;;
    -h|--help) printf '%s\n' "usage: scripts/release.sh <version> [--apply] [--device <name>] [--skip-tests] [--yes]"; exit 0 ;;
    --*) die "unknown flag: $arg" ;;
    *)
      [[ -z "$TARGET" ]] || die "unexpected argument: $arg"
      TARGET="$arg"
      ;;
  esac
done
$expect_device && die "--device needs a machine name (e.g. --device zion)"
[[ -n "$TARGET" ]] || die "usage: scripts/release.sh <version> [--apply]  (e.g. 1.14.2 --apply)"
[[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be MAJOR.MINOR.PATCH (no pre-release tags)"

# Resolve the privileged-phase target: --device if given, else the mac-mini
# default. ON_HOME_BASE says whether THIS box is that target (run inline vs ssh).
readonly RELEASE_HOME_BASE="${DEVICE:-$RELEASE_HOME_BASE_DEFAULT}"
ON_HOME_BASE=false
[[ "$THIS_HOST" == "$RELEASE_HOME_BASE" ]] && ON_HOME_BASE=true

# The caller's checkout is never the orchestration workspace. It may be a dirty
# shared main checkout or an agent's feature worktree; either way, release-owned
# isolation keeps unrelated work out of the release index and avoids contending
# for the branch already checked out there. The internal home-base phase is
# already inside its own tagged worktree and deliberately bypasses this hop.
if ! $HOME_BASE_PHASE && ! $ORCHESTRATION_PHASE; then
  CALLER_GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
    || die "release.sh must run from an agents-cli git checkout"
  CALLER_REPO_ROOT="$(dirname "$CALLER_GIT_COMMON_DIR")"
  exec scripts/release-worktree.sh "$CALLER_REPO_ROOT" "$@"
fi

if $APPLY; then
  bold "Mode: APPLY (real publish)"
else
  yellow "Mode: DRY-RUN (no branch, PR, merge, tag, publish, or push -- pass --apply to actually release)"
fi
gray "  this box:   $THIS_HOST$($ON_HOME_BASE && echo '  (home base)' || echo '')"
gray "  home base:  $RELEASE_HOME_BASE  (promote attested tgz + reuse helpers + install smoke)"
gray "  proof:      exact-tree attestation (tree/toolchain/lock/policy); ordinary P99 <=180s"
echo

# ----- Privileged phase on the home base (internal --home-base-phase entrypoint) -----
# This runs the TAGGED release.sh (route_home_base_phase checks out the tag into a
# worktree and invokes THAT worktree's script with --home-base-phase), so the
# script executing here is guaranteed to carry --home-base-phase and
# headless-sign-context.sh. It therefore assumes it is ALREADY inside the tagged
# worktree ($ROOT = <tag-worktree>/apps/cli, cwd set by the caller): it verifies
# the checked-out version == $TARGET, downloads the attested tarball + manifest
# from the tag (the throwaway worktree has no store), publishes those bytes, and
# re-attaches the verified helper zip. It does NOT create its own worktree.
run_home_base_phase() {
  # No platform gate: this phase is promote-only (download attested tgz, verify,
  # install-smoke, npm publish, re-attach the reused helper zip) — nothing here
  # signs or notarizes, so a Linux home base works (RUSH-3026). The tarball no
  # longer carries the version-stamped signed CLI binary; its two .app helpers
  # are manifest-reused, already-signed artifacts. The gray line doubles as the
  # deterministic routing sentinel release.test.ts asserts --device reached here.
  gray "home base: $RELEASE_HOME_BASE (promote-only -- no signing on this path)"
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

  # Ordinary path: promote the exact pretested tarball. Headless secrets are
  # only for the npmjs.com token -- codesign/notarytool are outside this path.
  command -v agents >/dev/null 2>&1 \
    || die "'agents' CLI not on PATH on $RELEASE_HOME_BASE -- needed to inject the npmjs.com token"
  # shellcheck source=scripts/headless-sign-context.sh
  . scripts/headless-sign-context.sh
  resolve_npm_auth

  local repo_root tree attest_dir attest tgz_json tgz manifest
  repo_root="$(git rev-parse --show-toplevel)"
  tree="$(git rev-parse "HEAD^{tree}")"
  # The tagged worktree is throwaway and has no store. Pull the files the
  # trigger uploaded to v$TARGET (stable names) into a temp dir.
  attest_dir="$(mktemp -d "${TMPDIR:-/tmp}/agents-cli-release-attest.XXXXXX")"
  gh release download "v$TARGET" --dir "$attest_dir" \
    --pattern 'release-attestation.json' \
    --pattern 'release-manifest.json' \
    --pattern 'phnx-labs-agents-cli-*.tgz' \
    --pattern 'ComputerHelper.app.zip*' \
    || die "could not download attested artifacts from GitHub release v$TARGET -- the trigger must upload them before this phase"
  bold "Requiring exact-tree attestation for ${tree:0:12} (no parent/nearby fallback)..."
  attest="$(scripts/release-attestation.sh require --dir "$attest_dir" --tree "$tree" --repo-root "$repo_root")" \
    || die "no passing attestation for tagged tree $tree -- refusing parent/nearby evidence"
  tgz_json="$(scripts/release-attestation.sh tarball --file "$attest" --require-file)"
  tgz="$(jq -r .path <<<"$tgz_json")"
  scripts/release-attestation.sh promote --file "$attest" --tarball "$tgz" >/dev/null \
    || die "pretested tarball failed digest bind -- refusing to rebuild"

  manifest="$attest_dir/release-manifest.json"
  [[ -f "$manifest" ]] || die "release manifest missing at $manifest -- no fallback rebuild"
  scripts/release-manifest.sh require --file "$manifest" --repo-root "$repo_root" \
    || die "helper manifest failed -- rebuild/notarization is outside the ordinary release path"

  bold "Install-smoke of the exact pretested tarball..."
  scripts/release-install-smoke.sh "$tgz" "$TARGET" \
    || die "install smoke failed for $tgz"

  bold "Publishing the exact pretested tarball $(basename "$tgz") as $PHNX_PKG@$TARGET..."
  # Same bytes CI already packed. OIDC provenance when the GitHub token exchange
  # is present; token publish of those same bytes otherwise.
  if [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]]; then
    npm publish "$tgz" --access=public --provenance \
      || die "npm publish (OIDC provenance) failed on $RELEASE_HOME_BASE (tag exists; rerun to retry)"
  else
    npm publish "$tgz" --access=public --provenance=false \
      || die "npm publish failed on $RELEASE_HOME_BASE (tag exists; rerun to retry)"
  fi
  green "Published $PHNX_PKG@$TARGET from attested $tgz"

  gh release view "v$TARGET" --json assets --jq '.assets[].name' 2>/dev/null | grep -qx 'ComputerHelper.app.zip' \
    || die "v$TARGET is missing ComputerHelper.app.zip -- the client still downloads the per-CLI-version URL; reuse the prior zip (no rebuild)"
}

# Resolve the npm publish token from the local `npmjs.com` secrets bundle and
# write a temp .npmrc. Called ONLY on the home base (by run_home_base_phase),
# inside the headless secrets context, so the token never crosses to the trigger
# box. Defined here (before the --home-base-phase dispatch) so that entrypoint,
# which exits before the trigger-box preflight, can reach it.
resolve_npm_auth() {
  # Read NPM_TOKEN from the npmjs.com bundle via the globally-installed `agents`
  # (homebrew). We resolve the token BEFORE the build, so the worktree's own
  # dist/ does not exist yet -- there is no local build to prefer, and the
  # headless context sourced above has already set AGENTS_SECRETS_PASSPHRASE so
  # this resolves silently. The value is captured from `secrets exec` injection
  # (the printenv-capture idiom, docs/secrets.md) -- the plaintext export mode
  # was removed (RUSH-2774).
  command -v agents >/dev/null || die "'agents' CLI not on PATH (needed to read npmjs.com secrets bundle on $RELEASE_HOME_BASE)"
  NPM_TOKEN="$(agents secrets exec npmjs.com -- printenv NPM_TOKEN 2>/dev/null || true)"
  [[ -n "$NPM_TOKEN" ]] \
    || die "could not resolve NPM_TOKEN from the 'npmjs.com' secrets bundle on $RELEASE_HOME_BASE (agents secrets create npmjs.com && agents secrets add npmjs.com NPM_TOKEN)"

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

# Annotated v<version> tag whose message is the folded changelog already on that
# commit. Delegates to create-annotated-release-tag.sh (extracted so the contract
# is unit-testable without npm/gh). Optional third arg --force rewrites a local
# tag (already-published recovery / lightweight-upgrade path).
create_annotated_release_tag() {
  scripts/create-annotated-release-tag.sh "$@"
}

# The internal --home-base-phase entrypoint short-circuits everything else.
if $HOME_BASE_PHASE; then
  [[ -n "$TARGET" ]] || die "--home-base-phase needs a <version>"
  bold "[home-base phase] promote attested tgz + reuse helpers + install smoke on $THIS_HOST"
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
command -v bun >/dev/null    || die "bun not found"
command -v git >/dev/null    || die "git not found"
command -v jq >/dev/null     || die "jq not found (brew install jq)"
command -v gh >/dev/null      || die "gh (GitHub CLI) not found (brew install gh) -- needed to open + merge the release PR"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated -- run 'gh auth login'"

# Resolve the default branch dynamically. release-worktree.sh checked out this
# fresh remote tip in a detached worktree, so the caller need not be on main and
# its dirty files cannot enter the index used below.
git fetch --quiet origin
DEFAULT_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
[[ -n "$DEFAULT_BRANCH" ]] || DEFAULT_BRANCH="main"
BASE_SHA="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$DEFAULT_BRANCH")"
[[ "$BASE_SHA" == "$REMOTE" ]] || die "release worktree is not at fresh origin/$DEFAULT_BRANCH -- recreate only this release worktree and retry"
if [[ -n "$(git status --porcelain)" ]]; then
  red "release worktree became dirty before orchestration; changed files:" >&2
  git status --short >&2
  die "release-owned worktree must stay clean -- inspect the listed files; do not stash or alter the caller checkout"
fi

# A clean clone/worktree has no node_modules. Install from the pinned lockfile in
# this isolated tree rather than borrowing mutable dependencies from the caller.
bun install --frozen-lockfile >/dev/null \
  || die "dependency install failed in the isolated release worktree"

# ----- npm auth: resolved ON the home base, never borrowed to the trigger box -----
# The npm publish token lives on the home base (the --device target, mac-mini by
# default) and is resolved there (resolve_npm_auth, defined above), in its
# headless secrets context, at publish time -- it never crosses to the box that
# invoked the release. Anonymous
# `npm view` reads below (latest version, is-target-published) need no token, so
# version validation + the already-published short-circuit run fine on any box.

# ----- Route the privileged phase to the home base -----
# After the trigger box has merged + tagged the release (git + gh, which need the
# invoking box's auth), the promote+publish+computer-helper phase runs
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
# The signed keychain + menu-bar helpers need bin/embedded.provisionprofile -- an
# Apple provisioning profile that is a COMMITTED input as of commit 2567004b4
# (negated out of .gitignore: /apps/cli/bin/* + !/apps/cli/bin/embedded.provisionprofile),
# so any tag cut after that commit already carries it in the checked-out \$WT
# tree, with nothing left to seed. Two cases still need recovery: an OLDER tag
# cut before 2567004b4 (e.g. the stuck v1.22.36) genuinely lacks it in its own
# tree, and a home base whose own on-disk checkout (REPO_ROOT) has simply never
# been git-pulled past that commit -- "any Mac that has not previously been home
# base" (RUSH-2541) -- lacks it on disk even though origin does not. The fetch
# above always refreshes origin/\$DEFAULT_BRANCH's remote-tracking ref regardless
# of REPO_ROOT's local working-tree state, so recover the blob from THAT ref
# rather than trusting whatever happens to be checked out on REPO_ROOT's disk.
mkdir -p "\$WT/apps/cli/bin"
# Guarded with \`|| true\`, NOT a bare assignment: under this snippet's own
# \`set -euo pipefail\` (top of this heredoc), symbolic-ref returning non-zero --
# the normal state of a checkout bootstrapped via \`init && remote add && fetch\`
# rather than \`clone\`, i.e. plausibly a brand-new fleet home base -- trips
# errexit on the assignment itself and kills the phase silently, before the
# very next line's "main" fallback ever runs. Same anti-pattern, same fix
# assert_promote_home_base uses for this reason.
DEFAULT_BRANCH="\$(git -C "\$REPO_ROOT" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')" || true
[ -n "\$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="main"
if [ -f "\$WT/apps/cli/bin/embedded.provisionprofile" ]; then
  : # already in the tagged tree -- nothing to seed
elif git -C "\$REPO_ROOT" show "origin/\$DEFAULT_BRANCH:apps/cli/bin/embedded.provisionprofile" > "\$WT/apps/cli/bin/embedded.provisionprofile" 2>/dev/null; then
  : # recovered from the freshly-fetched origin/\$DEFAULT_BRANCH ref
elif [ -f "\$REPO_ROOT/apps/cli/bin/embedded.provisionprofile" ]; then
  cp "\$REPO_ROOT/apps/cli/bin/embedded.provisionprofile" "\$WT/apps/cli/bin/embedded.provisionprofile"
else
  echo "error: apps/cli/bin/embedded.provisionprofile not found on the tagged tree, on origin/\$DEFAULT_BRANCH, or on this home base's disk. It is a committed file (see commit 2567004b4) -- recover it from git history and verify apps/cli/bin/embedded.provisionprofile is tracked on origin/\$DEFAULT_BRANCH, then retry. Do NOT regenerate it at developer.apple.com; the existing profile is valid until 2044." >&2
  exit 1
fi
cd "\$WT/apps/cli"
scripts/release.sh $1 --home-base-phase --device "$RELEASE_HOME_BASE"
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
  bold "Routing build + sign + publish to the home base ($RELEASE_HOME_BASE) via agents ssh (from the tagged tree)..."
  # Prefer `agents ssh` over plain `ssh`: it uses the devices registry + brokered
  # credentials and survives host-key / PATH quirks that plain ssh hits on
  # headless Linux workers (Host key verification failed).
  #
  # CRITICAL: pass the remote command as ONE argv element. `agents ssh` joins
  # cmd[] with spaces via wrapRemoteCommand (lib/devices/connect.ts) before
  # handing OpenSSH a single remote string — multi-arg forms like
  #   agents ssh host -- bash -lc 'cd … && bash -s'
  # become `bash -lc cd … && bash -s` (quotes stripped), so `cd` runs with no
  # argument and the snippet's `git rev-parse` fails: "not a git repository".
  # A single quoted string preserves the remote shell syntax. Snippet on stdin
  # (`bash -s`); $HOME expands on the REMOTE side.
  if command -v agents >/dev/null 2>&1; then
    agents ssh "$RELEASE_HOME_BASE" -- 'cd $HOME/src/github.com/muqsitnawaz/agents-cli && bash -s' <<<"$snippet" \
      || return 1
  else
    # Fallback when agents is not on PATH on the trigger box (rare).
    ssh "$RELEASE_HOME_BASE" 'cd $HOME/src/github.com/muqsitnawaz/agents-cli && bash -s' <<<"$snippet" \
      || return 1
  fi
}

# ----- Promote home-base preflight (fail fast BEFORE any mutation) -----
# The home-base phase above is promote-only (download attested tgz, verify,
# install-smoke, npm publish, re-attach the reused helper zip) and runs at the
# very END of the release, AFTER the PR is merged and the tag pushed. If the
# resolved home base cannot promote -- no npm token bundle, no gh auth -- that
# failure lands after the two irreversible acts, leaving a tagged-but-UNPUBLISHED
# release (the RUSH-2535 shape). This runs the readiness probe ON the home base
# (inline if we ARE it, else the same `agents ssh` hop route_home_base_phase
# uses) and aborts here -- before the crabbox/PR/merge/tag phases -- when the box
# is not ready. Signing provisioning (cert/keychain/provisionprofile) is NOT
# probed: nothing on the promote path signs (RUSH-3026); helper signing has its
# own path and runs only when helper sources change.
assert_promote_home_base() {
  local out rc probe="scripts/promote-home-base-probe.sh"
  bold "Preflight: verifying $RELEASE_HOME_BASE can promote + publish..."
  # Capture rc with `&& rc=0 || rc=$?`, NOT `out="$(cmd)"; rc=$?`: under this
  # script's `set -euo pipefail`, a bare failing assignment trips errexit and
  # kills the script AT that line, before `rc=$?` runs -- so the diagnostic dump
  # and the die() below would be dead code and the release would abort with no
  # stated reason (the very "fail loud at boundaries" the preflight exists for).
  # The && / || tested context suppresses errexit and preserves the probe's rc.
  if $ON_HOME_BASE; then
    out="$(bash "$probe" 2>&1)" && rc=0 || rc=$?
  elif command -v agents >/dev/null 2>&1; then
    # Ship THIS worktree's fresh probe over stdin and run it in the home base's
    # own checkout dir. Piping (bash -s) -- not invoking a remote path -- because
    # the home base's on-disk checkout may predate this script
    # (route_home_base_phase makes the same choice for the same reason).
    # $HOME expands remotely.
    out="$(agents ssh "$RELEASE_HOME_BASE" -- 'cd $HOME/src/github.com/muqsitnawaz/agents-cli && bash -s' < "$probe" 2>&1)" && rc=0 || rc=$?
  else
    out="$(ssh "$RELEASE_HOME_BASE" 'cd $HOME/src/github.com/muqsitnawaz/agents-cli && bash -s' < "$probe" 2>&1)" && rc=0 || rc=$?
  fi
  if [[ "$rc" != "0" ]]; then
    printf '%s\n' "$out" | sed 's/^/  /' >&2
    die "device $RELEASE_HOME_BASE cannot promote + publish (see probe output above) -- fix the named gap or pass --device <ready-box>"
  fi
  phase_ok "$RELEASE_HOME_BASE can promote + publish (npm token + gh auth verified)"
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
# here requires live npm and GitHub authentication. It prints the bump kind, or
# the accepted versions to stderr and exits 1.
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

# ----- Finish a stuck release before starting a new one -----
# A release that dies after the tag but before the publish leaves a pushed v* tag
# the registry never saw. The next run then validates its bump against npm (which
# is behind), cuts the NEXT version, and the gap widens by one every time: on
# 2026-08-02 that turned a one-version gap into npm 1.20.78 / main 1.20.81 with
# v1.20.80 and v1.20.81 tagged and unpublished. Refuse to widen it -- the
# unpublished tag is a release to finish, and re-running with that version is the
# documented recovery (it rebuilds from the merged PR's CI-tested tree).
# Fail CLOSED. A `|| true` here would mean a transient network blip silently
# disables the guard and the release bumps straight past a stuck version -- the
# exact widening this check exists to stop. If we cannot read the tags, we do not
# know whether it is safe to proceed, so we stop.
#
# The result is consumed via a command substitution below and fed to the loop as
# a here-string -- NOT `done < <(remote_version_tags)`. That distinction is the
# whole guard: a process substitution runs in a subshell, so `die` there exits
# only the subshell, the loop reads an empty list, and release.sh sails on with
# "no stuck tag found" -- fail-OPEN, the precise bug this function exists to
# prevent. A command substitution's non-zero status propagates to the assignment
# under `set -e`, so the script actually stops.
remote_version_tags() {
  local out
  out="$(git ls-remote --tags origin 'refs/tags/v*' 2>&1)" \
    || die "could not read remote tags from origin -- refusing to release without checking for a stuck version: $out"
  printf '%s\n' "$out" | grep -v '\^{}$' || true
}

# The decision arithmetic lives in scripts/stuck-release.sh so it can be tested
# directly (scripts/stuck-release.test.ts); this block only gathers the facts it
# needs -- the pushed tags, and whether the registry has each one.
TAG_FACTS=""
REMOTE_TAG_LINES="$(remote_version_tags)"
while read -r _sha _ref; do
  v="${_ref#refs/tags/v}"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  # Only versions ahead of the registry can be stuck, so only those are worth an
  # `npm view` round trip.
  [[ "$v" != "$PHNX_LATEST" ]] || continue
  [[ "$(printf '%s\n%s\n' "$PHNX_LATEST" "$v" | sort -V | tail -1)" == "$v" ]] || continue
  if npm view "$PHNX_PKG@$v" version >/dev/null 2>&1; then
    TAG_FACTS+="$v yes"$'\n'
  else
    TAG_FACTS+="$v no"$'\n'
  fi
done <<< "$REMOTE_TAG_LINES"

# $BUMP + $PKG_JSON_VERSION let stuck-release.sh exempt the one deadlock case:
# patch-from-main stepping over main's own unpublishable version (see its header).
UNPUBLISHED_TAG="$(printf '%s' "$TAG_FACTS" | scripts/stuck-release.sh "$PHNX_LATEST" "$BUMP" "$PKG_JSON_VERSION" || true)"

if [[ -n "$UNPUBLISHED_TAG" && "$UNPUBLISHED_TAG" != "$TARGET" ]]; then
  red "v$UNPUBLISHED_TAG is tagged but was never published -- finish that release first."
  gray "  registry latest   $PHNX_LATEST"
  gray "  stuck tag         v$UNPUBLISHED_TAG"
  gray "  you asked for     $TARGET"
  echo
  yellow "  Re-run with the stuck version; it rebuilds from that release PR's CI-tested tree:"
  yellow "    scripts/release.sh $UNPUBLISHED_TAG --apply"
  die "refusing to bump past an unpublished release"
fi

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
# preflight, attestation, PR+attest+merge, tag, promote, verify. A catch-up
# publish (main already at $TARGET) skips attestation+PR phases -> 4 phases.
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
    die "$DEFAULT_BRANCH tree $(git rev-parse "$MERGED_RELEASE_SHA^{tree}") != attested candidate $(git rev-parse "$CI_TESTED_HEAD^{tree}") -- refusing parent/nearby evidence"
  fi
  [[ "$(git show "$MERGED_RELEASE_SHA:apps/cli/package.json" | jq -r .version)" == "$TARGET" ]] \
    || die "merged release PR #$MERGED_RELEASE_PR is not version $TARGET"

  # The catch-up guards above (CI-tested head match + tree match + version match)
  # are preserved intact -- they gate an unverified retry publish. What is NOT
  # done here anymore: building artifacts on the trigger box. The whole
  # privileged phase (promote + publish + computer-helper) now runs on the home
  # base against the tagged tree, so no staged helper / historical worktree
  # build is needed on the invoking box.
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

# Ordinary release does not rebuild or notarize on the trigger box or the home
# base. The home base promotes the attested tarball and reuses helper artifacts.
# The trigger box's job is typecheck + attestation + PR + merge + tag.

# ----- Proof -----
# Functional proof is the exact-tree attestation (tree/toolchain/lock/policy)
# plus the pretested tarball digest. --skip-tests does not skip that bind.

# ----- Tarball preview -----
# Ordinary release publishes the attested .tgz; it does not pack a new one here.
if [[ -n "${RELEASE_PRETESTED_TGZ:-}" && -f "${RELEASE_PRETESTED_TGZ}" ]]; then
  bold "Pretested tarball $RELEASE_PRETESTED_TGZ"
  ls -l "$RELEASE_PRETESTED_TGZ"
else
  gray "Pretested tarball is resolved from the attestation store at promote time -- this path never rebuilds one."
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
  # Stop renewing before dropping, so the renewer cannot re-push a lease we are
  # about to delete and leave the ref orphaned until its TTL.
  if [[ -n "${LEASE_RENEWER_PID:-}" ]]; then
    kill "$LEASE_RENEWER_PID" >/dev/null 2>&1 || true
    wait "$LEASE_RENEWER_PID" 2>/dev/null || true
  fi
  # Drop the release lease on every exit path. A run that dies without reaching
  # this (SIGKILL, severed ssh, rebooted box) leaves the lease behind on purpose:
  # release-lease.sh reclaims it after its TTL and logs whose it was, rather than
  # letting a half-dead release look finished.
  if [[ "${LEASE_HELD:-false}" == "true" ]]; then
    scripts/release-lease.sh release || true
  fi
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
    "url": "git+https://github.com/phnx-labs/agi-cli.git"
  },
  "homepage": "https://agents-cli.sh",
  "bugs": {
    "url": "https://github.com/phnx-labs/agi-cli/issues"
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
  yellow "  2. [this box] require exact-tree attestation (tree/toolchain/lock/policy) for origin/$DEFAULT_BRANCH"
  yellow "  3. [this box] push branch $RELEASE_BRANCH (chore(release): $TARGET); open a PR"
  yellow "  4. [this box] require attestation + pretested tgz for the release commit tree (90s), fail-closed"
  yellow "  5. [this box] squash-merge only if final tree == attested candidate; tag v$TARGET"
  yellow "  6. [$RELEASE_HOME_BASE] promote exact tgz + reuse helpers + install smoke + npm publish"
  gray   "  (steps already done in a prior run are skipped: published / merged / PR-open / tag-exists)"
  exit 0
fi

# ----- Confirmation (--apply only) -----
if ! $YES; then
  read -r -p "Release $TARGET via a PR into $DEFAULT_BRANCH, then publish $PHNX_PKG? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || die "aborted"
fi

# ----- Claim the release lease (the mutex) -----
# Agents release from whichever box they are on, so exclusivity has to live on
# origin, not on a local flock. Claim BEFORE the first mutation: everything past
# this point (changelog fold, branch push, PR, merge, tag, publish) is what two
# concurrent runs clobber. On 2026-08-02 two agents entered here at once and only
# found out at the publish gate -- by then one had already merged and tagged, and
# the version was left merged but unshipped.
#
# Released by cleanup_all's trap on EVERY exit path, success or failure.
#
# Declare THIS process as the lease holder. A run killed externally never reaches
# the trap, and the lease then outlives it: without a recorded pid the only cure
# is waiting out the TTL, during which `status` reads `held` with nothing
# releasing. With it, the next claim (or `release-lease.sh clear`) on this box
# sees the holder is gone and reclaims immediately. It must be the orchestrating
# release.sh pid, not $$ inside the lease script -- the background renewer runs
# release-lease.sh in a fresh shell every 10 minutes, and recording that shell
# would stamp every renewed lease with an already-dead pid.
export RELEASE_LEASE_HOLDER_PID=$$
LEASE_HELD=false
if ! scripts/release-lease.sh claim "$TARGET"; then
  die "another release is in flight -- watch it instead of racing it (scripts/release-lease.sh status)"
fi
LEASE_HELD=true

# Keep the lease fresh for as long as this release runs. The TTL is "how long
# since the holder last proved it was alive", NOT "how long a release takes" --
# a healthy release routinely outlives any sane TTL (the CI matrix alone has run
# 57 minutes; release 1.20.77 took 186 minutes wall clock). Without this
# renewer a long-but-healthy release would go stale mid-flight and a second
# releaser would reclaim its lease, recreating the exact collision the lease
# exists to prevent. Killed by cleanup_all.
LEASE_RENEWER_PID=""
( while sleep 600; do scripts/release-lease.sh renew >/dev/null 2>&1 || exit 0; done ) &
LEASE_RENEWER_PID=$!

# Called before every irreversible step. Fails CLOSED: if we cannot prove the
# lease is still ours, we stop rather than merge/tag/publish alongside whoever
# holds it now.
require_lease() { # $1 = what we are about to do
  scripts/release-lease.sh verify \
    || phase_fail "lost the release lease before $1 -- refusing to continue; another releaser owns this pipeline now"
}

# Auto-revert of the package.json bump is no longer wanted here — the bump is
# carried into the release branch commit (and the cleanup trap reverts the
# working tree to HEAD on any abort, keeping re-runs clean).
PKG_BUMPED=false

phase "Preflight + version validation complete" "$THIS_HOST"
phase_ok "isolated origin/$DEFAULT_BRANCH, bump $BUMP ($PHNX_LATEST -> $TARGET), type check + tarball preview done"

# Fail fast BEFORE any mutation when the resolved home base cannot publish.
# On origin/main this probe existed but was never invoked (dead since the
# RUSH-2666 rewrite), so an unready home base failed only AFTER merge+tag --
# the exact tagged-but-unpublished shape RUSH-2535 documented. Wired here, it
# aborts before the attestation/PR/merge/tag phases (RUSH-3026).
assert_promote_home_base

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
      if [[ "$(git rev-parse "$MERGED_RELEASE_SHA^{tree}")" != "$(git rev-parse "FETCH_HEAD^{tree}")" ]]; then
        die "already-published $TARGET: $DEFAULT_BRANCH tree $(git rev-parse "$MERGED_RELEASE_SHA^{tree}") != attested candidate $(git rev-parse "FETCH_HEAD^{tree}") -- refusing parent/nearby evidence"
      fi
      TAG_TARGET="$MERGED_RELEASE_SHA"
    else
      TAG_TARGET="origin/$DEFAULT_BRANCH"
    fi
    [[ "$(git show "$TAG_TARGET:apps/cli/package.json" | jq -r .version)" == "$TARGET" ]] \
      || die "refusing to create v$TARGET: $TAG_TARGET does not contain package version $TARGET"
    # This is the second place a tag gets pushed (the already-published recovery
    # path), and it is just as irreversible as the primary one -- gate it too, or
    # a lease lost during the npm-view round trip lets two releasers both push a
    # tag for the same version.
    require_lease "pushing the missing tag v$TARGET"
    create_annotated_release_tag "$TARGET" "$(git rev-parse "$TAG_TARGET^{commit}")" --force
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

# ----- Exact-tree attestation (ordinary release proof) -----
# Bound to 90 seconds so the whole ordinary release stays inside the 180s P99.
# --skip-tests does not skip this: there is no fallback rebuild or parent-commit
# evidence. Sign/notarize is not invoked here.
attestation_store_dir() {
  printf '%s\n' "${RELEASE_ATTESTATION_DIR:-$REPO_ROOT/.release-attestations}"
}

# Stage the attested json + tgz + manifest + reused helper zip onto v$TARGET so
# the throwaway home-base worktree can download them. Never rebuilds a helper.
upload_release_proof() {
  local tree="$1"
  local store attest tgz_json tgz dest
  store="$(attestation_store_dir)"
  attest="$(scripts/release-attestation.sh require --dir "$store" --tree "$tree" --repo-root "$REPO_ROOT")" \
    || die "cannot upload proof: no attestation for $tree"
  dest="$(mktemp -d "${TMPDIR:-/tmp}/agents-cli-release-proof.XXXXXX")"
  cp "$attest" "$dest/release-attestation.json"
  tgz_json="$(scripts/release-attestation.sh tarball --file "$attest" --require-file)"
  tgz="$(jq -r .path <<<"$tgz_json")"
  [[ -n "$tgz" && -f "$tgz" ]] || die "pretested tarball missing -- refusing to rebuild"
  cp "$tgz" "$dest/$(basename "$tgz")"
  [[ -f "$store/release-manifest.json" ]] \
    || die "release manifest missing at $store/release-manifest.json -- no fallback rebuild"
  cp "$store/release-manifest.json" "$dest/release-manifest.json"
  if ! scripts/release-manifest.sh copy-asset --file "$store/release-manifest.json" --helper computer-mac --asset-path "$dest"; then
    gh release download "v$PHNX_LATEST" --dir "$dest" --pattern 'ComputerHelper.app.zip*' \
      || die "could not reuse ComputerHelper.app.zip from v$PHNX_LATEST -- no fallback rebuild"
  fi
  if gh release view "v$TARGET" >/dev/null 2>&1; then
    gh release upload "v$TARGET" "$dest"/* --clobber \
      || die "failed to upload attested artifacts to v$TARGET"
  else
    gh release create "v$TARGET" "$dest"/* --verify-tag --title "v$TARGET" \
      --notes "attested tarball + reused helper for $TARGET" \
      || die "failed to create GitHub release v$TARGET with attested artifacts"
  fi
}

wait_for_attestation() {
  local tree="$1"
  local attest_dir
  attest_dir="$(attestation_store_dir)"
  local deadline=$(( $(date +%s) + 90 ))
  local out
  [[ -n "$tree" ]] || die "missing tree digest for attestation"
  bold "Waiting for exact-tree attestation ${tree:0:12} (90s P99 budget)..."
  while :; do
    if out="$(scripts/release-attestation.sh require --dir "$attest_dir" --tree "$tree" --repo-root "$REPO_ROOT" 2>/dev/null)"; then
      green "attestation $(basename "$out")"
      printf '%s\n' "$out"
      return 0
    fi
    (( $(date +%s) > deadline )) && break
    sleep 5
  done
  scripts/release-attestation.sh require --dir "$attest_dir" --tree "$tree" --repo-root "$REPO_ROOT"
}

# A prior normal release run can merge its PR and then fail before publishing.
# Re-running must reuse the exact attested release tree — never treat a manual
# package.json bump or a squash merge containing concurrent main changes as
# release validation.
if $MAIN_AT_TARGET && ! $PHNX_TARGET_PUBLISHED; then
  [[ -n "$MERGED_RELEASE_PR" && -n "$MERGED_RELEASE_SHA" && -n "$MERGED_RELEASE_HEAD" ]] \
    || die "main is already at $TARGET but no complete merged $RELEASE_BRANCH PR exists -- refusing an unverified catch-up publish; cut the next patch through the normal release PR flow"
  if [[ -z "${CI_TESTED_HEAD:-}" ]]; then
    git fetch --quiet origin "pull/$MERGED_RELEASE_PR/head" \
      || die "could not fetch the attested head for merged release PR #$MERGED_RELEASE_PR"
    CI_TESTED_HEAD="$(git rev-parse FETCH_HEAD)"
  fi
  [[ "$CI_TESTED_HEAD" == "$MERGED_RELEASE_HEAD" ]] \
    || die "fetched PR head ${CI_TESTED_HEAD:0:9} != recorded release head ${MERGED_RELEASE_HEAD:0:9} -- refusing catch-up publish"
  if [[ "$(git rev-parse "$CI_TESTED_HEAD^{tree}")" != "$(git rev-parse "$MERGED_RELEASE_SHA^{tree}")" ]]; then
    die "$DEFAULT_BRANCH tree $(git rev-parse "$MERGED_RELEASE_SHA^{tree}") != attested candidate $(git rev-parse "$CI_TESTED_HEAD^{tree}") -- refusing parent/nearby evidence"
  fi
  HISTORICAL_CATCHUP=true
  bold "Re-validating attestation for merged release PR #$MERGED_RELEASE_PR before catch-up publish..."
  wait_for_attestation "$(git rev-parse "$MERGED_RELEASE_SHA^{tree}")" >/dev/null
fi

# ----- Require functional attestation for origin/<default> before opening a PR -----
if ! $MAIN_AT_TARGET; then
  phase "Require origin/$DEFAULT_BRANCH attestation" "$THIS_HOST"
  if $SKIP_TESTS; then
    gray "(--skip-tests does not skip attestation; exact-tree proof is still required)"
  fi
  wait_for_attestation "$(git rev-parse "origin/$DEFAULT_BRANCH^{tree}")" >/dev/null
  phase_ok "origin/$DEFAULT_BRANCH tree is attested (toolchain/lock/policy bound)"
fi

# ----- Open (or reuse) the release PR + merge, unless already merged -----
if ! $MAIN_AT_TARGET; then
  phase "Open release PR, wait for release-tree attestation, merge" "$THIS_HOST"
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

  # Regenerate the command index (docs/command-index.{md,json}) from the CLI's own
  # command tree so the shipped docs always match the shipped surface. Deterministic
  # introspection, no LLM; folded into the release commit below.
  bun scripts/gen-command-index.ts
  green "Regenerated docs/command-index.{md,json}"

  # Build the release commit from the index WITHOUT moving HEAD. The signed +
  # notarized macOS apps under bin/ are untracked, so we must build + publish
  # from THIS checkout; a worktree off origin/main would fail prepack. write-tree
  # is safe because the working tree is clean apart from our package.json +
  # CHANGELOG edits (enforced by the clean-tree preflight).
  git add -A package.json CHANGELOG.md .changelog docs/command-index.md docs/command-index.json
  BRANCH_TREE="$(git write-tree)"
  RELEASE_COMMIT="$(git commit-tree "$BRANCH_TREE" -p "$BASE_SHA" -m "chore(release): $TARGET")"

  PR_NUMBER=""
  RELEASE_CI_HEAD=""
  if [[ -n "$EXISTING_PR" ]]; then
    PR_NUMBER="$EXISTING_PR"
    EXISTING_HEAD="$(gh pr view "$EXISTING_PR" --json headRefOid --jq .headRefOid 2>/dev/null || true)"
    if [[ -n "$EXISTING_HEAD" && "$(git rev-parse "$EXISTING_HEAD^{tree}" 2>/dev/null || true)" == "$BRANCH_TREE" ]]; then
      RELEASE_CI_HEAD="$EXISTING_HEAD"
      gray "Reusing open PR #$PR_NUMBER ($RELEASE_BRANCH); branch tree already matches."
    else
      git push --force-with-lease origin "$RELEASE_COMMIT:refs/heads/$RELEASE_BRANCH"
      RELEASE_CI_HEAD="$RELEASE_COMMIT"
      gray "Updated PR #$PR_NUMBER branch to the freshly built release commit."
    fi
  else
    # force-with-lease, not a plain push: a prior run may have left a stale
    # release/v<version> branch with no open PR. RELEASE_COMMIT is a fresh
    # commit-tree (a sibling of that stale tip, not a descendant), so a non-force
    # push would be rejected non-fast-forward and brick the re-run. The lease is
    # safe -- preflight fetched origin, so we only overwrite a ref we have seen.
    git push --force-with-lease origin "$RELEASE_COMMIT:refs/heads/$RELEASE_BRANCH"
    RELEASE_CI_HEAD="$RELEASE_COMMIT"
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

  [[ -n "$RELEASE_CI_HEAD" ]] || die "could not resolve attested head for PR #$PR_NUMBER"
  wait_for_attestation "$(git rev-parse "$RELEASE_CI_HEAD^{tree}")" >/dev/null

  # Squash-merge. Never --admin. Attestation of the exact release tree is the
  # functional gate -- not a full-suite matrix wait. Re-prove the lease before
  # the first irreversible act.
  require_lease "merging PR #$PR_NUMBER"
  bold "Merging PR #$PR_NUMBER (squash)..."
  gh pr merge "$PR_NUMBER" --squash --delete-branch || die "merge failed for PR #$PR_NUMBER (left open)"
  green "Merged PR #$PR_NUMBER"
  phase_ok "PR #$PR_NUMBER: attested tree squash-merged"
fi

# Phase 4 (both paths): resolve the CI-tested release commit + create/push the tag.
phase "Verify attested tree + tag v$TARGET" "$THIS_HOST"

# The published tarball MUST be the exact attested candidate tree. Final
# default-branch tree digest must equal that candidate; parent/nearby SHAs
# never count.
git fetch --quiet origin "$DEFAULT_BRANCH"
if $HISTORICAL_CATCHUP; then
  MERGED_SHA="$MERGED_RELEASE_SHA"
  CI_COMMIT="$CI_TESTED_HEAD"
else
  MERGED_SHA="$(git rev-parse "origin/$DEFAULT_BRANCH")"
  CI_COMMIT="$RELEASE_COMMIT"
fi
MERGED_VER="$(git show "$MERGED_SHA:apps/cli/package.json" | jq -r .version)"
[[ "$MERGED_VER" == "$TARGET" ]] || die "merged $DEFAULT_BRANCH is at $MERGED_VER, not $TARGET -- refusing to tag/publish"

[[ -n "${CI_COMMIT:-}" ]] || die "internal: no attested release commit resolved -- refusing to publish"
[[ "$(git show "$CI_COMMIT:apps/cli/package.json" | jq -r .version)" == "$TARGET" ]] \
  || die "attested release commit ${CI_COMMIT:0:9} is not version $TARGET -- refusing to publish"

MERGED_TREE="$(git rev-parse "$MERGED_SHA^{tree}")"
ATTESTED_TREE="$(git rev-parse "$CI_COMMIT^{tree}")"
[[ "$MERGED_TREE" == "$ATTESTED_TREE" ]] \
  || die "final $DEFAULT_BRANCH tree $MERGED_TREE != attested candidate $ATTESTED_TREE -- refusing parent/nearby evidence"
wait_for_attestation "$MERGED_TREE" >/dev/null
PUBLISH_SHA="$MERGED_SHA"

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
  # A leftover lightweight tag at the right commit would otherwise be pushed as-is
  # and skip the annotated-notes contract. Upgrade it in place.
  if [[ "$(git cat-file -t "refs/tags/v$TARGET")" != "tag" ]]; then
    create_annotated_release_tag "$TARGET" "$PUBLISH_SHA" --force
    green "Upgraded lightweight local tag v$TARGET to annotated at $(git rev-parse --short "$PUBLISH_SHA")"
  else
    gray "Tag v$TARGET already exists locally at the verified release commit"
  fi
else
  create_annotated_release_tag "$TARGET" "$PUBLISH_SHA"
  green "Created annotated tag v$TARGET at $(git rev-parse --short "$PUBLISH_SHA")"
fi

# ----- Push the tag (git, on the trigger box) so the home base can resolve it -----
# The tag is created + pushed here, before the privileged phase, so the home base
# resolves the exact release commit from origin. @swarmify/agents-cli legacy shim
# is no longer published as of v1.20.0.
#
# The lease gate belongs HERE, not on the `git tag` above: a local tag is local
# and reversible, the PUSH is the irreversible, shared act. Gating only the tag
# creation left this push ungated whenever the local tag already existed (a
# re-run, or a prior attempt), because that path skips the else branch entirely
# and falls straight through to here.
require_lease "pushing tag v$TARGET"
git push origin "v$TARGET"
upload_release_proof "$MERGED_TREE"
phase_ok "attested tree verified; tag v$TARGET at ${PUBLISH_SHA:0:9} pushed; proof uploaded"

# Restore the working tree to clean now that the tag is durable; the privileged
# phase below builds from a fresh checkout of the tag (locally on the home base,
# or over ssh), never from this working tree.
restore_release_tree

# ----- Privileged phase: promote attested tgz + reuse helpers + install smoke -----
# Routes to the home base ($RELEASE_HOME_BASE): inline if we ARE it, else over ssh.
# The npm token is resolved on the home base and never crosses to this box. On
# failure this halts with the cause; the tag + merge are durable, so a re-run
# resumes at the publish (the already-published short-circuit + tag idempotency
# make it safe).
phase "Promote attested tgz + reuse helpers + install smoke" "$RELEASE_HOME_BASE"
require_lease "publishing $PHNX_PKG@$TARGET"
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
