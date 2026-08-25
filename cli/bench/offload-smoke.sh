#!/usr/bin/env bash
# Headless offload smoke test.
#
# Proves `agents run` dispatches a headless agent end-to-end and prints how long
# it took. Run it ON the offload device (e.g. the GB10 / yosemite-s0), or from a
# laptop over ssh:  ssh muqsit@yosemite-s0 'bash -s' < bench/offload-smoke.sh
#
# Headless leaves no TUI / Ink render loop and no terminal-emulator repaint on
# the host — that is the whole point of pushing fan-out work off the laptop.
set -euo pipefail

AGENT="${AGENT:-claude}"
MODEL="${MODEL:-haiku}"
PROMPT="${PROMPT:-Reply with exactly: OK}"

echo "# headless offload smoke | host=$(hostname) agent=${AGENT} model=${MODEL}"
start=$(date +%s.%N)

out="$(agents run "${AGENT}" "${PROMPT}" --model "${MODEL}" --mode plan --quiet 2>/dev/null | tail -1)"

end=$(date +%s.%N)
elapsed=$(awk "BEGIN{printf \"%.2f\", ${end}-${start}}")

echo "reply : ${out}"
echo "wall  : ${elapsed}s"
[ -n "${out}" ] && echo "PASS — headless dispatch works on $(hostname)" || { echo "FAIL — empty reply"; exit 1; }
