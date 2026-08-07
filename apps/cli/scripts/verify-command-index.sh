#!/usr/bin/env bash
# Fail if docs/command-index.{md,json} are stale versus the CLI's own command
# tree — i.e. a command was added/renamed/re-described but `npm run gen:index`
# was not re-run and the result committed. Regenerates into a temp dir and diffs.
#
# Requires bun + node_modules (the generator loads every command module). Run
# from a CI job that has the toolchain and fires on CLI *source* changes
# (cli-preflight) so it catches the real drift case, plus the docs job for a
# hand-edit of the committed artifacts. Run from apps/cli/.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

GEN_COMMAND_INDEX_OUT_DIR="$TMP" bun scripts/gen-command-index.ts >/dev/null

rc=0
for f in command-index.md command-index.json; do
  if ! diff -q "docs/$f" "$TMP/$f" >/dev/null 2>&1; then
    printf '✗ docs/%s is stale — run `npm run gen:index` and commit the result\n' "$f" >&2
    rc=1
  fi
done

if [[ $rc -eq 0 ]]; then
  echo "✓ command index (docs/command-index.{md,json}) is up to date"
fi
exit $rc
