#!/bin/bash
# Run the Factory app locally: build the UI + host, then launch Electron.
#
# Usage: ./scripts/dev.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}$1${NC}"; }

cd "$APP_DIR"
[[ -d node_modules ]] || bash "$SCRIPT_DIR/install.sh"

info "Building UI + host..."
bun run build

info "Launching Factory..."
exec bun run start
