#!/bin/bash

set -e

# Check if version argument is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <version>"
    echo "Example: $0 1.0.0"
    exit 1
fi

VERSION=$1

# Get the project root directory
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

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
bash "$(dirname "${BASH_SOURCE[0]}")/activate.sh" "swarmify.swarm-ext"
