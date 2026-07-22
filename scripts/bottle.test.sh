#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SHA="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
OUT="/tmp/agents-dbg-bottle-dry-run.out"
bash scripts/bottle.sh 0.1.0 --sha256 "$SHA" > "$OUT"

grep -q "class AgentsDbg < Formula" "$OUT"
grep -q 'cask "agents-dbg"' "$OUT"
grep -q "$SHA" "$OUT"

bash -n scripts/bottle.sh
echo "bottle.test.sh: OK"
