#!/usr/bin/env bash
# Verify that agents-cli docs stay internally consistent.
# Run from apps/cli/.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ERRORS=0

log() { printf '%s\n' "$*"; }
fail() {
  printf '✗ %s\n' "$*" >&2
  ERRORS=$((ERRORS + 1))
}

# --- 1. AGENT-CHEATSHEET exists and covers the basics ---
CHEATSHEET="docs/AGENT-CHEATSHEET.md"
if [[ ! -f "$CHEATSHEET" ]]; then
  fail "$CHEATSHEET is missing"
else
  log "✓ $CHEATSHEET exists"
  for section in "The three DotAgents repos" "\`AGENTS.md\` is the canonical memory file" "Capability table gates" "Version homes" "Two unrelated things are called"; do
    if grep -qF "$section" "$CHEATSHEET"; then
      log "  ✓ covers: $section"
    else
      fail "$CHEATSHEET missing section: $section"
    fi
  done
fi

# --- 2. Entry points reference the cheat sheet ---
if grep -qF "AGENT-CHEATSHEET.md" AGENTS.md; then
  log "✓ AGENTS.md links to AGENT-CHEATSHEET.md"
else
  fail "AGENTS.md should link to AGENT-CHEATSHEET.md"
fi

if grep -qF "AGENT-CHEATSHEET.md" docs/README.md; then
  log "✓ docs/README.md links to AGENT-CHEATSHEET.md"
else
  fail "docs/README.md should link to AGENT-CHEATSHEET.md"
fi

# --- 3. No broken relative markdown links in docs/*.md ---
while IFS= read -r file; do
  while IFS= read -r match; do
    url="${match#*\(}"
    url="${url%\)}"
    url="${url%%#*}"
    [[ -z "$url" ]] && continue
    [[ "$url" == /* ]] && continue
    [[ "$url" == *://* ]] && continue
    [[ "$url" == mailto:* ]] && continue

    file_dir="$(cd "$(dirname "$file")" && pwd)"
    if (cd "$file_dir" && [[ -f "$url" || -d "$url" ]]); then
      continue
    fi
    resolved="$(cd "$file_dir" && pwd)/$url"
    fail "broken link in $file -> $url (resolved: $resolved)"
  done < <(grep -oE '\[[^]]+\]\([^)]+\)' "$file")
done < <(find docs -name '*.md')

# --- 4. The generated command index is up to date ---
# docs/command-index.{md,json} are generated from the CLI's own command tree
# (scripts/gen-command-index.ts). Regenerate into a temp dir and diff, so a PR
# that adds/renames a command but forgets to run `npm run gen:index` fails here.
# Skipped when bun is unavailable (a bare local run without the toolchain).
if command -v bun >/dev/null 2>&1; then
  TMP_INDEX="$(mktemp -d)"
  trap 'rm -rf "$TMP_INDEX"' EXIT
  if GEN_COMMAND_INDEX_OUT_DIR="$TMP_INDEX" bun scripts/gen-command-index.ts >/dev/null 2>&1; then
    stale=0
    for f in command-index.md command-index.json; do
      if ! diff -q "docs/$f" "$TMP_INDEX/$f" >/dev/null 2>&1; then
        fail "docs/$f is stale — run 'npm run gen:index' and commit the result"
        stale=1
      fi
    done
    [[ $stale -eq 0 ]] && log "✓ command index (docs/command-index.{md,json}) is up to date"
  else
    fail "gen-command-index.ts failed to run — cannot verify the command index"
  fi
else
  log "• skipping command-index freshness check (bun not on PATH)"
fi

if [[ $ERRORS -eq 0 ]]; then
  log "✓ Docs verification passed"
  exit 0
else
  log "✗ Docs verification failed with $ERRORS error(s)"
  exit 1
fi
