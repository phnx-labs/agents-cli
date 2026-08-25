#!/usr/bin/env bash
#
# The canonical way to run the agents-cli suite. Every other script that needs
# tests calls THIS one -- build.sh and release-attestation-produce.sh included.
#
# WHY THIS EXISTS (RUSH-3178). The suite is ~13k tests and pins a machine for
# ~10 minutes. It must never land on an interactive box. Before this script the
# only offloaded path was the `test:remote` package.json alias, and offloading
# was opt-in AT EACH CALL SITE because scripts/sandbox.sh took a hand-composed
# command string rather than a verb. Every call site opted out: build.sh:95 and
# release-attestation-produce.sh:151 both ran `bun run test` on whatever box
# invoked them, and agents ran vitest directly for the same reason. Making the
# offload the DEFAULT, inside one entry point, is what makes that impossible
# rather than merely discouraged.
#
# Usage:
#   scripts/test.sh                      # offload to a crabbox (the default)
#   scripts/test.sh --device <box>       # run on a named fleet box over ssh
#   scripts/test.sh --here               # run on THIS machine (explicit, loud)
#   scripts/test.sh --repo-root <dir>    # test that tree instead of this one
#   scripts/test.sh -- --retry=2         # everything after `--` goes to vitest
#
# NO SILENT FALLBACK. When the crabbox pool is unreachable this script FAILS and
# names the exact `--device` command to re-run, rather than quietly running the
# suite locally. A fallback here would recreate the very bug it exists to stop:
# the operator believes work was offloaded while their laptop melts.
set -euo pipefail

cd "$(dirname "$0")/.."
CLI_DIR="$(pwd)"

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
gray()  { printf '\033[2m%s\033[0m\n'  "$*"; }
bold()  { printf '\033[1m%s\033[0m\n'  "$*"; }
die()   { red "error: $*"; exit 1; }

MODE="offload"
DEVICE=""
REPO_ROOT=""
VITEST_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) [[ -n "${2:-}" ]] || die "--device needs a machine name"; DEVICE="$2"; MODE="device"; shift 2 ;;
    --device=*) DEVICE="${1#*=}"; MODE="device"; shift ;;
    --here|--local) MODE="here"; shift ;;
    --repo-root) [[ -n "${2:-}" ]] || die "--repo-root needs a directory"; REPO_ROOT="$2"; shift 2 ;;
    --repo-root=*) REPO_ROOT="${1#*=}"; shift ;;
    --) shift; VITEST_ARGS=("$@"); break ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unexpected argument: $1 (did you mean '-- $1' to pass it to vitest?)" ;;
  esac
done

# --repo-root lets the attestation producer test the isolated worktree it built
# at an exact commit, so the bytes tested are the bytes attested.
if [[ -n "$REPO_ROOT" ]]; then
  [[ -d "$REPO_ROOT/apps/cli" ]] || die "--repo-root '$REPO_ROOT' has no apps/cli"
  CLI_DIR="$(cd "$REPO_ROOT/apps/cli" && pwd)"
fi
TREE_ROOT="$(cd "$CLI_DIR/../.." && pwd)"

vitest_suffix() {
  ((${#VITEST_ARGS[@]})) && printf ' -- %s' "${VITEST_ARGS[*]}"
}

# Resolve a device NAME to an address ssh/rsync can actually reach.
#
# Raw `ssh <name>` resolves against whatever the local resolver knows, which for
# the yosemite worker pool is a 192.168.1.x LAN entry -- unroutable from off-LAN,
# so it hangs until ConnectTimeout. The device registry carries the tailscale
# dnsName, which works from anywhere on the tailnet. Read it rather than trusting
# the bare hostname: the registry is the CLI's own source of truth for how to
# reach a box (`agents devices list --json`).
#
# Also refuses the interactive host by name -- the machine someone is sitting at
# is never a test target, and `--here` is the explicit way to say otherwise.
device_addr() {
  command -v agents >/dev/null 2>&1 \
    || die "the 'agents' CLI is not on PATH, so device '$1' cannot be resolved"
  agents devices list --json 2>/dev/null | python3 -c '
import json, sys
want = sys.argv[1]
for r in json.load(sys.stdin):
    if r.get("name") == want:
        if r.get("interactive"):
            sys.exit(2)
        a = r.get("address") or {}
        addr = a.get("dnsName") or a.get("ip")
        if not addr:
            sys.exit(3)
        user = r.get("user")
        print(f"{user}@{addr}" if user else addr)
        sys.exit(0)
sys.exit(1)
' "$1"
}

case "$MODE" in
  here)
    # Deliberately loud. Running the full suite on the machine someone is using
    # is a real cost, so it is never something that happens implicitly.
    red "WARNING: running the full suite on THIS machine ($(hostname -s))."
    red "         ~13k tests, several minutes of pinned CPU. Ctrl-C now to offload instead."
    cd "$CLI_DIR"
    # shellcheck disable=SC2046
    exec bun run test $( ((${#VITEST_ARGS[@]})) && printf -- '-- %s' "${VITEST_ARGS[*]}" )
    ;;

  device)
    command -v rsync >/dev/null || die "rsync not found (needed to ship the tree to $DEVICE)"
    command -v ssh   >/dev/null || die "ssh not found"

    ADDR="$(device_addr "$DEVICE")" || case $? in
      2) die "'$DEVICE' is the INTERACTIVE host -- the suite is never scheduled there.
  Pass --here if you genuinely mean to pin this machine." ;;
      3) die "device '$DEVICE' has no reachable address in the registry (agents devices list)" ;;
      *) die "device '$DEVICE' is not in the registry -- see 'agents devices list'" ;;
    esac

    ssh -o BatchMode=yes -o ConnectTimeout=15 "$ADDR" true 2>/dev/null \
      || die "cannot reach '$DEVICE' ($ADDR) over ssh -- see 'agents devices list'"

    remote_dir="\$HOME/.agents/test-runs/agents-cli"
    bold "Offloading the suite to $DEVICE"
    gray "  addr:   $ADDR"
    gray "  tree:   $TREE_ROOT"

    ssh "$ADDR" "mkdir -p $remote_dir" >/dev/null
    # Ship the working tree, not a git clone: this must test the EXACT bytes on
    # disk (the producer's isolated worktree, or an operator's uncommitted work),
    # never whatever the remote could fetch from origin.
    rsync -az --delete \
      --exclude '.git' --exclude 'node_modules' --exclude 'dist' \
      --exclude '.agents/worktrees' --exclude '.release-attestations' \
      "$TREE_ROOT/" "$ADDR:.agents/test-runs/agents-cli/"

    green "Tree shipped. Running the suite on $DEVICE..."
    ssh "$ADDR" "cd ~/.agents/test-runs/agents-cli/apps/cli \
      && bun install --silent \
      && bun run build >/dev/null \
      && bun run test$(vitest_suffix)"
    ;;

  offload)
    [[ -x scripts/sandbox.sh ]] || die "scripts/sandbox.sh missing -- cannot offload"
    if ! command -v crabbox >/dev/null 2>&1; then
      die "crabbox is not installed on this machine, so the suite cannot be offloaded to the pool.
  Run it on a fleet Linux box instead:   scripts/test.sh --device yosemite-m1
  Or, if you accept pinning THIS machine: scripts/test.sh --here"
    fi
    # Fail loud, never silently local. The crabbox pool has been down fleet-wide
    # (RUSH-3004 Hetzner 403, RUSH-2773) and that outage is exactly when someone
    # is tempted to "just run it here" -- so name the alternative in the error.
    # VITEST_ARGS must ride through here too. The producer passes
    # `-- --retry=2 --maxWorkers=2` and offload is its DEFAULT mode, so dropping
    # them silently removes the mitigation that keeps a good tree from
    # false-failing (see release-attestation-produce.sh's RUSH-3015 note).
    if ! scripts/sandbox.sh test ${VITEST_ARGS[@]+"${VITEST_ARGS[@]}"}; then
      die "the crabbox run failed (pool outage? see RUSH-3004 / RUSH-2773).
  Run it on a fleet Linux box instead:   scripts/test.sh --device yosemite-m1
  Or, if you accept pinning THIS machine: scripts/test.sh --here"
    fi
    ;;
esac
