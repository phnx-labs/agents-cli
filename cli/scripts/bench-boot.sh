#!/usr/bin/env bash
#
# bench-boot.sh — measure the `agents run` pre-exec wrapper cost (PHNX-3585).
#
# The AGI EXT "New Claude" boot runs `agents run claude --interactive`, and the
# whole wrapper cost is spent BEFORE the harness prints anything: bootstrap,
# version resolution, account rotation, config sync. This benchmark drives the
# REAL command with the `AGENTS_PROFILE_BOOT=1` per-stage profiler (see
# src/lib/boot-profile.ts) and reports the pre-exec timeline, so the boot cost
# stays measured and a regression is visible in one command.
#
# It hits the real path — real version homes, real account store, real spawn —
# and passes `-- --version` so the harness exits immediately: what's measured is
# the wrapper, not the model. Nothing here is mocked.
#
# Usage:
#   scripts/bench-boot.sh                 # build if needed, 6 runs of `run claude`
#   scripts/bench-boot.sh --agent codex   # profile a different harness
#   scripts/bench-boot.sh --runs 10       # more samples
#   scripts/bench-boot.sh --no-build      # use the existing dist/ as-is
#
# Notes:
#   - Run 1 is COLD (populates the file-store metadata cache); runs 2..N are
#     WARM (the steady state the ext boot actually hits). The summary reports
#     both, because the cold/warm gap IS the caching win this benchmark exists
#     to track.
#   - Needs the harness installed and an account resolvable on THIS box (it runs
#     the real launch). It is a developer perf tool, not a CI gate.

set -euo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="claude"
RUNS=6
BUILD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENT="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "bench-boot: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

cd "$CLI_DIR"

if [ "$BUILD" = "1" ]; then
  echo "[bench-boot] building dist/ …" >&2
  bun run build >/dev/null
fi

ENTRY="$CLI_DIR/dist/index.js"
if [ ! -f "$ENTRY" ]; then
  echo "[bench-boot] $ENTRY not found — run without --no-build, or 'bun run build' first." >&2
  exit 1
fi

# One `agents run <agent> --headless -- --version` invocation with the profiler
# on. Emits the boot-profile timeline to stderr right before spawn; we keep the
# harness's own stdout out of the way.
run_once() {
  AGENTS_PROFILE_BOOT=1 node "$ENTRY" run "$AGENT" --headless --quiet -- --version 2>&1 >/dev/null || true
}

total_of() { grep -oE 'total [0-9.]+ms' | grep -oE '[0-9.]+' | head -1; }
stage_of() { grep -E "^  $1 " | grep -oE '\+ *[0-9.]+ms' | grep -oE '[0-9.]+' | head -1; }

echo "[bench-boot] agent=$AGENT runs=$RUNS entry=$ENTRY" >&2
echo >&2

declare -a TOTALS RESOLVES
LAST_TIMELINE=""
for i in $(seq 1 "$RUNS"); do
  out="$(run_once)"
  LAST_TIMELINE="$out"
  t="$(printf '%s\n' "$out" | total_of || true)"
  r="$(printf '%s\n' "$out" | stage_of 'resolve-version:done' || true)"
  TOTALS[$i]="${t:-NA}"
  RESOLVES[$i]="${r:-NA}"
  label="warm"; [ "$i" = "1" ] && label="cold"
  printf '  run %-2s (%-4s)  total=%-8s  resolve-version=%s ms\n' "$i" "$label" "${t:-NA}ms" "${r:-NA}"
done

echo
echo "── last full pre-exec timeline ──"
printf '%s\n' "$LAST_TIMELINE" | grep -E 'boot-profile|\+ *[0-9.]+ms' || true

# Warm median (runs 2..N) — the steady state the ext boot hits.
if [ "$RUNS" -ge 2 ]; then
  warm_resolves="$(printf '%s\n' "${RESOLVES[@]:1}" | grep -vx NA | sort -n || true)"
  warm_totals="$(printf '%s\n' "${TOTALS[@]:1}" | grep -vx NA | sort -n || true)"
  median() { awk '{a[NR]=$1} END{ if(NR==0){print "NA"} else {print a[int((NR+1)/2)]} }'; }
  echo
  echo "── summary ──"
  echo "  cold resolve-version : ${RESOLVES[1]} ms   (populates the file-store metadata cache)"
  echo "  warm resolve-version : $(printf '%s\n' "$warm_resolves" | median) ms (median)"
  echo "  warm total pre-exec  : $(printf '%s\n' "$warm_totals" | median) ms (median)"
fi
