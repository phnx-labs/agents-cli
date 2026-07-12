#!/bin/bash

set -e

# Check if version argument is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <version>"
    echo "Example: $0 1.0.0"
    exit 1
fi

VERSION=$1

# Resolve script dir absolutely before any cwd change so activate.sh
# can be found regardless of the invocation shape (repo root vs package cwd).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Install dependencies (factory + UI) so a clean worktree can build.
if [ ! -d "node_modules" ]; then
    echo "Installing factory dependencies..."
    bun install
fi
if [ ! -d "ui/node_modules" ]; then
    echo "Installing UI dependencies..."
    (cd ui && bun install)
fi

# Build the extension
echo "Building extension..."
bash scripts/build.sh "$VERSION"

# Install the extension
VSIX_FILE="dist/swarm-ext-${VERSION}.vsix"

if [ ! -f "$VSIX_FILE" ]; then
    echo "Error: ${VSIX_FILE} not found"
    exit 1
fi

echo "Installing extension..."

INSTALLED=0

for CLI in cursor code codium; do
    if command -v "$CLI" >/dev/null 2>&1; then
        echo "  -> $CLI"
        "$CLI" --install-extension "$VSIX_FILE" --force
        INSTALLED=$((INSTALLED + 1))
    fi
done

if [ "$INSTALLED" -eq 0 ]; then
    echo "Error: no editor CLI found (tried cursor, code, codium)"
    exit 1
fi

echo "Extension installed to $INSTALLED editor(s)."

# Installed to disk != active in a running editor. Reload running windows and
# verify activation from exthost.log (best-effort reload, authoritative verify).
bash "$SCRIPT_DIR/activate.sh" "swarmify.swarm-ext"
