#!/bin/bash
# Install the Factory app's dependencies (the app package + the UI it bundles).
#
# Usage: ./scripts/install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}$1${NC}"; }

info "Installing Factory app deps..."
(cd "$APP_DIR" && bun install)

info "Installing bundled UI deps..."
(cd "$APP_DIR/../ui" && bun install)

info "Done."
