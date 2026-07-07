#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

expected="$(cut -d ' ' -f 1 "scripts/Agents CLI.app.sha256")"
actual="$(shasum -a 256 "bin/Agents CLI.app/Contents/MacOS/Agents CLI" | cut -d ' ' -f 1)"

if [ "$actual" != "$expected" ]; then
  echo "Agents CLI.app SHA256 mismatch" >&2
  echo "expected: $expected" >&2
  echo "actual:   $actual" >&2
  exit 1
fi
