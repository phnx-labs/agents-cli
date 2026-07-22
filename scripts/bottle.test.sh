#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SHA="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
OUT="/tmp/agents-dbg-bottle-dry-run.out"
bash scripts/bottle.sh 0.1.0 --sha256 "$SHA" > "$OUT"

grep -q 'cask "agents-dbg"' "$OUT"
grep -q "$SHA" "$OUT"
if grep -q "class AgentsDbg < Formula" "$OUT"; then
  echo "bottle.test.sh: Formula should not be emitted" >&2
  exit 1
fi

TAP_REMOTE="$(mktemp -d)"
TAP_REPO="$(mktemp -d)"
git init --bare "$TAP_REMOTE" >/dev/null
git clone "$TAP_REMOTE" "$TAP_REPO" >/dev/null 2>&1
git -C "$TAP_REPO" config user.email "agents-cli-test@example.com"
git -C "$TAP_REPO" config user.name "agents-cli test"
printf "test tap\n" > "$TAP_REPO/README.md"
git -C "$TAP_REPO" add README.md
git -C "$TAP_REPO" commit -m "seed tap" >/dev/null
git -C "$TAP_REPO" push -u origin HEAD >/dev/null 2>&1

bash scripts/bottle.sh 0.1.0 --sha256 "$SHA" --tap-repo "$TAP_REPO" --confirm --push >/dev/null
FIRST_COMMIT="$(git -C "$TAP_REPO" rev-parse HEAD)"
bash scripts/bottle.sh 0.1.0 --sha256 "$SHA" --tap-repo "$TAP_REPO" --confirm --push >/dev/null
SECOND_COMMIT="$(git -C "$TAP_REPO" rev-parse HEAD)"
[[ "$FIRST_COMMIT" == "$SECOND_COMMIT" ]]
git -C "$TAP_REPO" diff --quiet

# A stale Formula with the same name is removed so the tap is not ambiguous.
mkdir -p "$TAP_REPO/Formula"
printf "class AgentsDbg < Formula\nend\n" > "$TAP_REPO/Formula/agents-dbg.rb"
git -C "$TAP_REPO" add Formula/agents-dbg.rb
git -C "$TAP_REPO" commit Formula/agents-dbg.rb -m "stale formula" >/dev/null
bash scripts/bottle.sh 0.1.0 --sha256 "$SHA" --tap-repo "$TAP_REPO" --confirm --push >/dev/null
[[ ! -f "$TAP_REPO/Formula/agents-dbg.rb" ]]

bash -n scripts/bottle.sh
echo "bottle.test.sh: OK"
