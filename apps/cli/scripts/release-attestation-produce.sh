#!/usr/bin/env bash
#
# Interim producer for exact-tree release attestations (RUSH-2749).
#
# RUSH-2666 landed the CONSUMER (release.sh requires a passing attestation for
# a candidate tree, never rebuilds) without a PRODUCER: nothing writes
# ATTEST.json + the pretested tarball into the attestation store. Every
# release.sh run wedges at "missing exact attestation key" as a result. The
# durable fix is a CI lane on the near-instant-CI plan
# (.agents/artifacts/2026-08-15/plan-ci-release-near-instant.md); this script
# is the documented interim path an operator runs by hand until that lane
# lands, and it doubles as the reusable step that lane will eventually call.
#
# What it does, against an isolated worktree at the EXACT commit given:
#   1. Runs the full suite (bun run test). Fail closed -- no attestation is
#      written for a red suite.
#   2. On a macOS box with `agents` + the apple.com secrets bundle, signs and
#      notarizes the CLI binary and the two helper .apps headlessly (the same
#      steps release.sh's privileged phase ran before RUSH-2666 relocated
#      build/sign to attestation time). Off that box, this step is skipped and
#      `npm pack`'s own prepack gates (verify-keychain-helper.sh,
#      verify-menubar-helper.sh) fail closed instead -- there is no unsigned
#      fallback tarball. (The CLI binary left the tarball in RUSH-3026, so its
#      gate left prepack; the sign step below still builds it on a Mac for the
#      per-release GitHub-asset path.)
#   3. Packs the tarball (`npm pack`) and binds its sha256 into the record.
#   4. Writes the attestation via release-attestation.sh write, then copies
#      the tarball alongside it so release-attestation.sh tarball/promote can
#      find it (`require`/`tarball` resolve the .tgz relative to the JSON's
#      own directory).
#
# Usage:
#   scripts/release-attestation-produce.sh <commit-ish> [--dir DIR]
#                                           [--repo-root DIR] [--keep]
#
# --dir defaults to $RELEASE_ATTESTATION_DIR or <repo-root>/.release-attestations
# -- the same resolution release.sh uses, so producing and requiring agree
# without any extra flags once RELEASE_ATTESTATION_DIR is set consistently.
# --keep leaves the worktree in place for inspection instead of removing it.
set -euo pipefail

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
gray()   { printf '\033[2m%s\033[0m\n'  "$*"; }
bold()   { printf '\033[1m%s\033[0m\n'  "$*"; }

die() { red "error: $*"; exit 1; }

cd "$(dirname "$0")/.."
DEFAULT_REPO_ROOT="$(git rev-parse --show-toplevel)"

COMMIT_ISH=""
REPO_ROOT="$DEFAULT_REPO_ROOT"
STORE=""
KEEP=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) STORE="$2"; shift 2 ;;
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    -h|--help)
      sed -n '3,32p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    --*) die "unknown flag: $1" ;;
    *)
      [[ -z "$COMMIT_ISH" ]] || die "unexpected argument: $1"
      COMMIT_ISH="$1"
      shift
      ;;
  esac
done
[[ -n "$COMMIT_ISH" ]] || die "usage: scripts/release-attestation-produce.sh <commit-ish> [--dir DIR] [--repo-root DIR] [--keep]"

git -C "$REPO_ROOT" fetch --quiet origin
SHA="$(git -C "$REPO_ROOT" rev-parse --verify "$COMMIT_ISH^{commit}" 2>/dev/null)" \
  || die "cannot resolve '$COMMIT_ISH' to a commit in $REPO_ROOT (fetch origin first if it's a remote ref)"
TREE="$(git -C "$REPO_ROOT" rev-parse "$SHA^{tree}")"

STORE="${STORE:-${RELEASE_ATTESTATION_DIR:-$REPO_ROOT/.release-attestations}}"
mkdir -p "$STORE"
# Resolve to an absolute path NOW, while cwd is still stable -- the rest of
# this script cd's into the throwaway worktree below, and a relative $STORE
# would then resolve there instead, silently writing (and losing, on cleanup)
# the attestation in the wrong directory.
STORE="$(cd "$STORE" && pwd)"

WT="$(mktemp -d "${TMPDIR:-/tmp}/agents-cli-attest-produce.XXXXXX")"
cleanup() {
  if $KEEP; then
    gray "kept worktree for inspection: $WT"
  else
    git -C "$REPO_ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
    rm -rf "$WT"
  fi
}
trap cleanup EXIT

bold "Producing attestation for ${SHA:0:12} (tree ${TREE:0:12})"
git -C "$REPO_ROOT" worktree add --quiet --detach "$WT" "$SHA" \
  || die "could not create worktree at $WT from $SHA"

missing="$(git -C "$WT" status --short | awk '$1 == "D" || $2 == "D" { print $2 }')"
[[ -z "$missing" ]] || die "worktree $WT is incomplete; missing tracked files: $missing"

cd "$WT/apps/cli"

bun install --frozen-lockfile || die "bun install failed for ${SHA:0:12}"

bold "Running the full suite..."
# RUSH-3007: cutting 1.22.44, the operator exported CI=true by hand to get
# vitest.config.ts's extended hookTimeout profile (RUSH-2970 trap 5a), which
# also armed tests/setup.ts's leak tripwires against this box's REAL
# ~/.agents — a live daemon + active sessions tripped 129/129 test files on
# hermeticity-guard writes while every individual test (12,559/12,559)
# passed, and the producer correctly refused to attest. AGENTS_ATTEST_PRODUCER
# is this script's own explicit, narrower opt-in: it gets the same vitest
# profile (tests/hermetic-guards.ts:shouldEnableCiTestProfile) WITHOUT arming
# those tripwires (shouldArmHermeticGuards). Unset CI defensively so a caller
# shell that still exports it by habit (the exact operator mistake above)
# cannot re-arm the guards out from under this flag.
unset CI
export AGENTS_ATTEST_PRODUCER=1
# Mirrors isVitestWorkerCrashWithZeroFailures (scripts/ci-scope.ts): vitest can
# exit 1 on an unhandled teardown "Worker exited unexpectedly" after every test
# passed (RUSH-2215; hit by this producer on a fully green tree, RUSH-2758).
# Only that exact shape is tolerated -- any 'failed' in the summary, or a
# missing summary, stays fail-closed.
suite_green_despite_worker_crash() {
  local log="$1" files_line tests_line
  grep -q 'Worker exited unexpectedly' "$log" || return 1
  files_line="$(grep -E '^[[:space:]]*Test Files[[:space:]]' "$log" | tail -1)"
  tests_line="$(grep -E '^[[:space:]]*Tests[[:space:]]' "$log" | tail -1)"
  [[ -n "$files_line" && -n "$tests_line" ]] || return 1
  grep -qE '(^|[^[:alnum:]])failed([^[:alnum:]]|$)' <<<"$files_line" && return 1
  grep -qE '(^|[^[:alnum:]])failed([^[:alnum:]]|$)' <<<"$tests_line" && return 1
  grep -qE '(^|[^[:alnum:]])passed([^[:alnum:]]|$)' <<<"$tests_line"
}
SUITE_LOG="$(mktemp "${TMPDIR:-/tmp}/agents-cli-attest-suite.XXXXXX")"
# RUSH-3015 follow-up: even with the producer's maxWorkers cap, 2 integration
# tests (self-heal.integration, drift-sync) flake under parallel load -- they
# contend on shared version-home state -- plus transient `npm 404` when real-CLI
# install tests hammer the registry. That flakes ~every producer run and refuses
# to attest a good tree, blocking releases. Retry re-runs a failed test (a real
# regression still fails all 3 attempts and stays fail-closed), and --maxWorkers=2
# cuts contention below the config's producer default of 4. Passed as CLI flags
# (not vitest.config.ts) on purpose: editing the global-setup config forces
# ci-scope to select those same flaky files into THIS pr's CI, which self-blocks
# the fix; and CLI flags override whatever config the attested commit carries, so
# the mitigation applies to every tree the producer runs, old or new.
if bun run test -- --retry=2 --maxWorkers=2 2>&1 | tee "$SUITE_LOG"; then
  green "Suite passed."
elif suite_green_despite_worker_crash "$SUITE_LOG"; then
  gray "vitest worker exited after zero test failures; treating as pass (RUSH-2215)."
  green "Suite passed (teardown worker-exit tolerated on a green summary)."
else
  die "suite failed for ${SHA:0:12} -- refusing to attest a red tree (log: $SUITE_LOG)"
fi
rm -f "$SUITE_LOG"

# Sign + notarize headlessly, matching what release.sh's privileged phase did
# before RUSH-2666 moved build/sign to attestation time. Skipped off a macOS
# signing box; npm pack's own prepack gates fail closed in that case (no
# unsigned tarball is ever attested).
if [[ "$(uname)" == "Darwin" ]] && command -v agents >/dev/null 2>&1 \
  && [[ -x scripts/sign-cli-binary.sh ]]; then
  bold "Signing + notarizing the CLI binary and helper apps..."
  # Unlocks rush-signing.keychain-db and authorizes codesign/notarytool to use
  # the Developer ID key non-interactively; without it a headless `agents
  # secrets exec` hits errSecInternalComponent (the key ACL prompts for UI
  # approval that a headless session can never answer). Same preamble
  # release.sh's own privileged phase sources before any signing call.
  # shellcheck source=scripts/headless-sign-context.sh
  . scripts/headless-sign-context.sh
  agents secrets exec apple.com -- scripts/sign-cli-binary.sh \
    || die "CLI binary sign/notarize failed"
  agents secrets exec apple.com -- bash -c '
    set -euo pipefail
    menubar/scripts/build.sh release
    rm -rf bin/MenubarHelper.app
    cp -R menubar/dist/MenubarHelper.app bin/MenubarHelper.app
    codesign --verify --deep --strict "bin/MenubarHelper.app"
    xcrun stapler validate "bin/MenubarHelper.app"
    scripts/build-keychain-helper.sh
    shasum -a 256 "bin/Agents CLI.app/Contents/MacOS/Agents CLI" > "scripts/Agents CLI.app.sha256"
  ' || die "signed helper build failed"
else
  gray "Not on a macOS signing box -- skipping helper sign/build; npm pack's prepack gates decide."
  # Seed the already-signed helper .apps from the caller checkout (RUSH-3026).
  # The ordinary release never rebuilds an unchanged helper, and this fresh
  # worktree has an empty bin/ -- without seeding, every non-Mac producer died
  # at prepack, which chained attestation production (and therefore releases)
  # to a Mac. The prepack gates still decide: the keychain app must match the
  # tree's committed sha pin and the menubar app must be present, so a wrong or
  # tampered seed fails the pack exactly as before. Seeding is copy-if-absent
  # only -- a Darwin producer's freshly signed apps are never overwritten.
  for app in "Agents CLI.app" "MenubarHelper.app"; do
    if [[ ! -d "bin/$app" && -d "$REPO_ROOT/apps/cli/bin/$app" ]]; then
      mkdir -p bin
      cp -R "$REPO_ROOT/apps/cli/bin/$app" "bin/$app"
      gray "seeded bin/$app from the caller checkout (already-signed; prepack gates verify it)"
    fi
  done
fi

bold "Building (bun run build)..."
rm -rf dist
bun run build || die "build failed for ${SHA:0:12}"

bold "Packing the pretested tarball (npm pack)..."
TGZ_NAME="$(npm pack --silent 2>&1 | tail -1)"
[[ -f "$TGZ_NAME" ]] || die "npm pack did not produce a tarball (got: $TGZ_NAME)"
if command -v sha256sum >/dev/null 2>&1; then
  TGZ_DIGEST="$(sha256sum "$TGZ_NAME" | awk '{print $1}')"
else
  TGZ_DIGEST="$(shasum -a 256 "$TGZ_NAME" | awk '{print $1}')"
fi
green "Packed $TGZ_NAME (sha256:$TGZ_DIGEST)"

# suite is "selected", not "full" or a producer-invented name: release.sh
# never passes --suite to `release-attestation.sh require`
# (bind_tree_lock_policy defaults an unset --suite to "selected"), so a record
# tagged anything else is invisible to it, key-for-key correct on tree/lock/
# policy or not. Running the full suite here satisfies "selected" -- it is a
# superset -- but the record must still speak the consumer's vocabulary.
ATTEST_TMP="$(mktemp "${TMPDIR:-/tmp}/agents-cli-attest.XXXXXX.json")"
scripts/release-attestation.sh identity --repo-root "$WT" --commit "$SHA" \
  | jq --arg name "$TGZ_NAME" --arg digest "sha256:$TGZ_DIGEST" \
      '. + {schemaVersion: 1, suite: "selected", conclusion: "pass", tarball: {filename: $name, digest: $digest}}' \
  > "$ATTEST_TMP"

DEST_JSON="$(scripts/release-attestation.sh write --dir "$STORE" --file "$ATTEST_TMP")" \
  || die "failed to write attestation record"
rm -f "$ATTEST_TMP"
DEST_DIR="$(dirname "$DEST_JSON")"
cp "$TGZ_NAME" "$DEST_DIR/$TGZ_NAME"

green "Wrote $DEST_JSON"
green "Tarball at $DEST_DIR/$TGZ_NAME"

# ----- Helper manifest (RUSH-2766) -----
# release.sh consumes $STORE/release-manifest.json at require_helpers (:231)
# and upload_release_proof (:976), but until now nothing produced it -- same
# consumer-without-producer class as the attestation itself was before this
# script existed (RUSH-2749). The manifest is a SINGLE file per store dir,
# carried forward across producer runs: a helper whose input digest still
# matches the recorded one keeps its already-attested record untouched; one
# that drifted is only re-recorded when a freshly built+signed asset for it
# is actually on disk in this worktree. This producer builds/signs keychain
# and menubar itself (the Darwin block above); computer-mac is signed by the
# separate native/computer-mac release path
# (scripts/publish-computer-helper-mac.sh) and is never rebuilt here, so a
# drifted computer-mac digest with no prior record to carry forward fails
# closed with the exact command to run, rather than shipping a stale or
# missing helper record.
if [[ -x scripts/release-manifest.sh ]]; then
  bold "Updating the helper manifest..."
  MANIFEST_FILE="$STORE/release-manifest.json"
  CLI_VERSION_MANIFEST="$(jq -r .version package.json)"
  if [[ ! -f "$MANIFEST_FILE" ]]; then
    # Seed from the last published release before falling back to an empty
    # manifest. Without this, a fresh store has no recorded computer-mac
    # inputDigest, the helper loop below reads "input changed", and the
    # computer-mac arm dies telling the operator to run
    # publish-computer-helper-mac.sh — which does not write a manifest, so the
    # instruction loops forever on a byte-identical helper. Every hand-cut
    # release hit this. RUSH-2970 trap 1.
    # Each step is checked on its own rather than chained, so the reason a seed
    # did not happen is the reason reported. A single `&&` chain collapsed three
    # distinct outcomes into one branch: a gh that fails on auth read as "no
    # prior release" — hiding exactly the misconfiguration worth surfacing — and
    # a repo with zero releases printed the literal string `null`, because
    # `jq -r '.[0].tagName'` on an empty array emits "null", not "".
    seed_note=""
    if ! command -v gh >/dev/null 2>&1; then
      seed_note="no gh on PATH"
    elif ! PRIOR_TAG="$(gh release list --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null)"; then
      seed_note="gh could not list releases (auth or network)"
    elif [[ -z "$PRIOR_TAG" || "$PRIOR_TAG" == "null" ]]; then
      seed_note="no published release to seed from"
    elif ! gh release download "$PRIOR_TAG" --pattern release-manifest.json --dir "$STORE" >/dev/null 2>&1 \
      || [[ ! -f "$MANIFEST_FILE" ]]; then
      seed_note="$PRIOR_TAG carries no release-manifest.json"
    fi

    if [[ -z "$seed_note" ]]; then
      gray "Seeded the helper manifest from $PRIOR_TAG (unchanged helpers carry forward)."
    else
      gray "Starting a fresh helper manifest — $seed_note."
      scripts/release-manifest.sh new --cli-version "$CLI_VERSION_MANIFEST" --cli-tree "$TREE" \
        > "$MANIFEST_FILE"
    fi
  fi

  manifest_asset_sha256() {
    local f="$1"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$f" | awk '{print $1}'
    else
      shasum -a 256 "$f" | awk '{print $1}'
    fi
  }

  for helper in computer-mac keychain menubar; do
    helper_digest="$(scripts/release-manifest.sh input-digest --repo-root "$WT" --helper "$helper")" \
      || die "could not compute input digest for helper $helper"
    recorded_digest="$(jq -r --arg n "$helper" '.helpers[$n].inputDigest // empty' "$MANIFEST_FILE")"
    if [[ -n "$recorded_digest" && "$recorded_digest" == "$helper_digest" ]]; then
      gray "helper $helper unchanged (${helper_digest#sha256:}) -- carrying forward its attested record"
      continue
    fi

    case "$helper" in
      keychain) asset="bin/Agents CLI.app/Contents/MacOS/Agents CLI" ;;
      menubar)  asset="bin/MenubarHelper.app/Contents/MacOS/MenubarHelper" ;;
      computer-mac)
        die "helper computer-mac input changed but this producer never rebuilds it -- run 'agents secrets exec apple.com -- scripts/publish-computer-helper-mac.sh' on a macOS signing box, then re-run this producer so the new digest is recorded"
        ;;
    esac
    [[ -f "$asset" ]] \
      || die "helper $helper input changed but no freshly signed asset at '$asset' -- run this producer on a macOS signing box"
    asset_digest="sha256:$(manifest_asset_sha256 "$asset")"
    scripts/release-manifest.sh put --file "$MANIFEST_FILE" --helper "$helper" \
      --helper-version "$CLI_VERSION_MANIFEST" --input-digest "$helper_digest" \
      --asset-digest "$asset_digest" --asset-path "$asset" --platform darwin \
      >/dev/null || die "failed to record helper $helper in the manifest"
    green "Recorded fresh $helper record (input ${helper_digest#sha256:})"
  done
  green "Manifest at $MANIFEST_FILE"
else
  gray "No scripts/release-manifest.sh in this tree -- skipping helper manifest production."
fi
