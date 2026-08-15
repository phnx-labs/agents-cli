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
#      verify-menubar-helper.sh, verify-cli-binary.sh) fail closed instead --
#      there is no unsigned fallback tarball.
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
if ! bun run test; then
  die "suite failed for ${SHA:0:12} -- refusing to attest a red tree"
fi
green "Suite passed."

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
