#!/usr/bin/env bash
# design-drift · Phase 1 — scope the recently-merged work.
#
# Enumerates PRs merged to the default branch inside the review window, collects
# the changed files, and lays out a RUN_DIR the quality engine can analyze.
# READ-ONLY: only reads git/gh and writes into the gitignored .agents/artifacts/
# scratch area. Never touches source.
#
# Usage: scope.sh [--since "<git-date>"]
#   --since  explicit window start (any `git log --since` value). When omitted,
#            the window starts at the date of the most recent prior
#            design-drift report in .agents/reports/, or 14 days ago on first run.
#
# Emits (to stdout) the RUN_DIR path on the last line. Side effects, all under
# $RUN_DIR: files.txt, surfaces.txt, prs.json, meta.json, findings/.
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"

SINCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) SINCE="${2:-}"; shift 2 ;;
    *) echo "scope.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Resolve the default branch (never hardcode main).
git fetch origin --quiet || true
git remote set-head origin --auto >/dev/null 2>&1 || true
BASE="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
BASE="${BASE:-main}"

REPORTS_DIR="$REPO/.agents/reports"

# Window start: explicit --since wins; else the newest prior report's date; else 14d.
if [[ -z "$SINCE" ]]; then
  LAST_REPORT="$(ls -1 "$REPORTS_DIR"/design-drift-*.md 2>/dev/null | sort | tail -1 || true)"
  if [[ -n "$LAST_REPORT" ]]; then
    # Filename shape: design-drift-YYYY-MM-DD.md
    LAST_DATE="$(basename "$LAST_REPORT" | sed -E 's/design-drift-([0-9]{4}-[0-9]{2}-[0-9]{2})\.md/\1/')"
    SINCE="$LAST_DATE"
  else
    SINCE="14 days ago"
  fi
fi

RUN_TS="$(date -u +"%Y-%m-%dT%H-%M-%S")"
RUN_DIR="$REPO/.agents/artifacts/${RUN_TS}-design-drift"
mkdir -p "$RUN_DIR/findings"

# Merged PRs in the window (best-effort; gh may be offline on a fleet box).
if command -v gh >/dev/null 2>&1 && \
   gh pr list --state merged --base "$BASE" --limit 200 \
     --json number,title,mergedAt,headRefName,author >"$RUN_DIR/prs.all.json" 2>/dev/null; then
  # Keep only PRs merged at/after the window start.
  SINCE_ISO="$(date -u -d "$SINCE" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")"
  if [[ -n "$SINCE_ISO" ]]; then
    jq --arg s "$SINCE_ISO" '[.[] | select(.mergedAt >= $s)] | sort_by(.mergedAt)' \
      "$RUN_DIR/prs.all.json" >"$RUN_DIR/prs.json"
  else
    cp "$RUN_DIR/prs.all.json" "$RUN_DIR/prs.json"
  fi
else
  echo "[]" >"$RUN_DIR/prs.json"
fi
PR_COUNT="$(jq 'length' "$RUN_DIR/prs.json")"

# Changed files in the window, from the default branch history. `git log --since`
# filters by commit (merge) date, which rebase-merge stamps at merge time.
git log "origin/$BASE" --since="$SINCE" --name-only --pretty=tformat: -- \
  | sed '/^$/d' | sort -u >"$RUN_DIR/files.txt" || true
FILE_COUNT="$(wc -l <"$RUN_DIR/files.txt" | tr -d ' ')"

# Surface summary: which top-level command / module surfaces the window touched,
# with a per-surface changed-file count. This is the constellation the drift lens
# reasons over ("N commands all touching the messaging surface").
awk -F/ '
  /^apps\/cli\/src\/commands\// { print "commands/" $5; next }
  /^apps\/cli\/src\/lib\//      { print "lib/" $5; next }
  /^apps\/factory\/src\//       { print "factory/" $4; next }
  { print $1 "/" $2 }
' "$RUN_DIR/files.txt" | sed 's/\.ts$//;s/\.tsx$//;s/\.test$//' \
  | sort | uniq -c | sort -rn >"$RUN_DIR/surfaces.txt" || true

cat >"$RUN_DIR/meta.json" <<JSON
{
  "run_ts": "$RUN_TS",
  "base": "$BASE",
  "window_since": "$SINCE",
  "pr_count": $PR_COUNT,
  "file_count": $FILE_COUNT,
  "run_dir": "$RUN_DIR",
  "repo": "$REPO"
}
JSON

echo "design-drift scope: window since '$SINCE' on origin/$BASE" >&2
echo "  merged PRs in window: $PR_COUNT" >&2
echo "  changed files: $FILE_COUNT" >&2
echo "  top surfaces:" >&2
head -12 "$RUN_DIR/surfaces.txt" >&2 || true
echo "$RUN_DIR"
