#!/usr/bin/env bash
# Public installer for agents-dbg. Hosted from:
# https://raw.githubusercontent.com/phnx-labs/agents-cli/main/scripts/install-agents-dbg.sh

set -euo pipefail

die() { echo "Error: $1" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "agents-dbg is a macOS app"

if ! command -v brew >/dev/null 2>&1; then
  die "Homebrew is required. Install Homebrew from https://brew.sh and rerun this installer."
fi

brew tap muqsitnawaz/tap >/dev/null
brew install --cask muqsitnawaz/tap/agents-dbg

if [[ -d "/Applications/agents-dbg.app" ]]; then
  open "/Applications/agents-dbg.app"
else
  open -a agents-dbg
fi
