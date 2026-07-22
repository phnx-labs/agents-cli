#!/usr/bin/env bash
# Generate or update Homebrew tap entries for agents-dbg.
#
# Usage: scripts/bottle.sh <version> --sha256 <sha> [flags]
#
# Flags:
#   --asset <name>       Zip asset name (default: agents-dbg-<version>-universal.zip)
#   --repo <owner/repo>  GitHub release repo (default: phnx-labs/agents-cli)
#   --tap-repo <path>    Existing muqsitnawaz/homebrew-tap checkout
#   --confirm            Write Casks/ file. Without it, print it.
#   --push               Commit and push tap changes after writing.

set -euo pipefail

die() { echo "Error: $1" >&2; exit 1; }

VERSION=""
SHA256=""
ASSET=""
REPO="${GITHUB_REPOSITORY:-phnx-labs/agents-cli}"
TAP_REPO="${HOMEBREW_TAP_REPO:-}"
CONFIRM=0
PUSH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha256) SHA256="${2:-}"; [[ -n "$SHA256" ]] || die "--sha256 requires a value"; shift 2 ;;
    --asset) ASSET="${2:-}"; [[ -n "$ASSET" ]] || die "--asset requires a value"; shift 2 ;;
    --repo) REPO="${2:-}"; [[ -n "$REPO" ]] || die "--repo requires a value"; shift 2 ;;
    --tap-repo) TAP_REPO="${2:-}"; [[ -n "$TAP_REPO" ]] || die "--tap-repo requires a path"; shift 2 ;;
    --confirm) CONFIRM=1; shift ;;
    --push) PUSH=1; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) die "unknown flag: $1" ;;
    *)
      [[ -z "$VERSION" ]] || die "unexpected arg: $1"
      VERSION="$1"
      shift
      ;;
  esac
done

[[ -n "$VERSION" ]] || die "version required"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be X.Y.Z"
[[ "$SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || die "--sha256 must be a 64-character hex digest"
ASSET="${ASSET:-agents-dbg-${VERSION}-universal.zip}"

URL="https://github.com/${REPO}/releases/download/agents-dbg-v${VERSION}/${ASSET}"

cask() {
  cat <<EOF
cask "agents-dbg" do
  version "${VERSION}"
  sha256 "${SHA256}"

  url "${URL}"
  name "agents-dbg"
  desc "Private install-only Mac app for debugging agents work streams"
  homepage "https://github.com/${REPO}"

  app "agents-dbg.app"

  uninstall quit: "com.phnxlabs.agents-dbg"
end
EOF
}

if [[ $CONFIRM -eq 0 ]]; then
  echo "Casks/agents-dbg.rb"
  cask
  exit 0
fi

if [[ -z "$TAP_REPO" ]]; then
  command -v gh >/dev/null 2>&1 || die "gh CLI required to clone tap when --tap-repo is omitted"
  TAP_REPO="$(mktemp -d)/homebrew-tap"
  gh repo clone muqsitnawaz/homebrew-tap "$TAP_REPO"
fi

[[ -d "$TAP_REPO/.git" ]] || die "tap repo is not a git checkout: $TAP_REPO"
mkdir -p "$TAP_REPO/Casks"
cask > "$TAP_REPO/Casks/agents-dbg.rb"

# Remove any stale Formula that would collide with the Cask name in the same tap.
if [[ -f "$TAP_REPO/Formula/agents-dbg.rb" ]]; then
  git -C "$TAP_REPO" rm -f "Formula/agents-dbg.rb"
  if [[ -d "$TAP_REPO/Formula" && -z "$(ls -A "$TAP_REPO/Formula")" ]]; then
    rmdir "$TAP_REPO/Formula"
  fi
fi

echo "Updated tap files:"
echo "  $TAP_REPO/Casks/agents-dbg.rb"

if [[ $PUSH -eq 1 ]]; then
  git -C "$TAP_REPO" add Casks/agents-dbg.rb
  if ! git -C "$TAP_REPO" diff --cached --quiet; then
    git -C "$TAP_REPO" commit -m "agents-dbg ${VERSION}"
    git -C "$TAP_REPO" push
  fi
fi
