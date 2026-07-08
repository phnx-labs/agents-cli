#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

expected="$(cut -d ' ' -f 1 "scripts/Agents CLI.app.sha256")"

# Portable sha256: macOS ships `shasum`, Linux ships `sha256sum`. Supporting both
# lets the prepack gate run on a Linux box that pulled the pre-signed helper via
# scripts/remote-sign-mac.sh.
if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "bin/Agents CLI.app/Contents/MacOS/Agents CLI" | cut -d ' ' -f 1)"
else
  actual="$(sha256sum "bin/Agents CLI.app/Contents/MacOS/Agents CLI" | cut -d ' ' -f 1)"
fi

if [ "$actual" != "$expected" ]; then
  echo "Agents CLI.app SHA256 mismatch" >&2
  echo "expected: $expected" >&2
  echo "actual:   $actual" >&2
  exit 1
fi
