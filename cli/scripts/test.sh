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
# The default is now `auto` (RUSH-3211), not crabbox. Crabbox needs its binary
# plus provider credentials, so a default that required them failed on any box
# without them -- and a default that fails is a default nobody uses. `auto` draws
# from the fleet workers the operator has already marked, through the CLI's own
# picker, so the no-argument invocation works everywhere.
#
# Usage:
#   scripts/test.sh                      # auto-pick the least-loaded worker (default)
#   scripts/test.sh --device auto        # the same thing, said explicitly
#   scripts/test.sh --device <box>       # run on a named fleet box over ssh
#   scripts/test.sh --crabbox            # offload to a disposable crabbox instead
#   scripts/test.sh --here               # run on THIS machine (explicit, loud)
#   scripts/test.sh --repo-root <dir>    # test that tree instead of this one
#   scripts/test.sh -- --retry=2         # everything after `--` goes to vitest
#
# NO SILENT FALLBACK. When no worker is eligible this script FAILS and names the
# exact `--device` command to re-run, rather than quietly running the suite
# locally. A fallback here would recreate the very bug it exists to stop: the
# operator believes work was offloaded while their laptop melts.
set -euo pipefail

cd "$(dirname "$0")/.."
CLI_DIR="$(pwd)"

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
gray()  { printf '\033[2m%s\033[0m\n'  "$*"; }
bold()  { printf '\033[1m%s\033[0m\n'  "$*"; }
die()   { red "error: $*"; exit 1; }

# `auto` is the default (RUSH-3211). Every call site that does not name a box
# gets a real worker without the operator having to know which boxes are free --
# which is the whole point of test.sh existing. crabbox is still available, but
# it is now an explicit choice: it needs the crabbox binary + provider creds,
# so defaulting to it made the default path fail on any box without them.
MODE="auto"
DEVICE=""
REPO_ROOT=""
VITEST_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) [[ -n "${2:-}" ]] || die "--device needs a machine name"; DEVICE="$2"; MODE="device"; shift 2 ;;
    --device=*) DEVICE="${1#*=}"; MODE="device"; shift ;;
    --crabbox) MODE="crabbox"; shift ;;
    --here|--local) MODE="here"; shift ;;
    --repo-root) [[ -n "${2:-}" ]] || die "--repo-root needs a directory"; REPO_ROOT="$2"; shift 2 ;;
    --repo-root=*) REPO_ROOT="${1#*=}"; shift ;;
    --) shift; VITEST_ARGS=("$@"); break ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unexpected argument: $1 (did you mean '-- $1' to pass it to vitest?)" ;;
  esac
done

# `--device auto` is the same sentinel `agents run --device auto` uses; accept it
# here rather than dialing a literal, nonexistent host named "auto".
if [[ "$MODE" == "device" && "$DEVICE" == "auto" ]]; then MODE="auto"; DEVICE=""; fi

# --repo-root lets the attestation producer test the isolated worktree it built
# at an exact commit, so the bytes tested are the bytes attested.
if [[ -n "$REPO_ROOT" ]]; then
  [[ -d "$REPO_ROOT/cli" ]] || die "--repo-root '$REPO_ROOT' has no cli"
  CLI_DIR="$(cd "$REPO_ROOT/cli" && pwd)"
fi
TREE_ROOT="$(cd "$CLI_DIR/.." && pwd)"

# Render the vitest args for a command string that a SHELL will re-parse.
# Per-arg `%q`, never "$*": splicing joins on a space, so `--testNamePattern="a b"`
# arrives as two words and silently selects a different set of tests -- observed
# as 10,620 tests running where a filter should have matched a handful. Same bug
# sandbox.sh had; this is the sweep of the remaining call sites.
vitest_suffix() {
  ((${#VITEST_ARGS[@]})) || return 0
  local a
  printf ' --'
  for a in "${VITEST_ARGS[@]}"; do printf ' %s' "$(printf '%q' "$a")"; done
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

# Resolve MODE=auto to a concrete worker, then fall through to the device path.
#
# The eligibility rule is NOT reimplemented here. `agents devices pick` is the
# CLI's own worker picker (lib/devices/worker-pick.ts): same auto pool as
# `agents run --device auto`, so `role=worker` / `role=personal` marks move this
# surface too; same live reachability+load probe; same least-loaded ranking. It
# fails loud when no worker is eligible, and this script surfaces that verbatim
# rather than inventing a fallback.
if [[ "$MODE" == "auto" ]]; then
  command -v agents >/dev/null 2>&1 \
    || die "the 'agents' CLI is not on PATH, so a worker cannot be auto-picked.
  Name one explicitly:  scripts/test.sh --device yosemite-m1
  Or pin THIS machine:  scripts/test.sh --here"
  # stdout is the name alone; the candidate/load detail goes to stderr, so let it
  # through to the operator instead of swallowing it.
  if ! DEVICE="$(agents devices pick)"; then
    # Distinguish "the fleet has nothing free" from "your CLI is too old to ask".
    # Both exit non-zero here, and conflating them sends the operator hunting a
    # capacity problem that does not exist. This is a diagnostic, not a fallback:
    # either way the run aborts.
    if ! agents devices --help 2>/dev/null | grep -qE '^[[:space:]]*pick([[:space:]]|$)'; then
      die "the installed 'agents' CLI has no 'devices pick' -- it predates the auto-picker.
  Upgrade it, or name a box until you do:  scripts/test.sh --device yosemite-m1"
    fi
    die "no worker device is available (see the message above).
  Name one explicitly:  scripts/test.sh --device yosemite-m1
  Or pin THIS machine:  scripts/test.sh --here"
  fi
  [[ -n "$DEVICE" ]] || die "'agents devices pick' returned no device"
  # A worker that picked ITSELF runs in place. Shipping the tree over ssh to
  # localhost would be pure overhead, and the loud --here warning is wrong here:
  # a box marked `worker` running the suite is the intended outcome, not a
  # surprise. (On the interactive host this branch is unreachable -- `personal`
  # keeps it out of the pool.)
  if [[ "$(hostname -s 2>/dev/null || hostname)" == "$DEVICE" ]]; then
    gray "Auto-picked THIS machine ($DEVICE) -- it is a pool worker, so running in place."
    MODE="here-worker"
  else
    MODE="device"
  fi
fi

case "$MODE" in
  here|here-worker)
    # `here` is deliberately loud: running the full suite on the machine someone
    # is using is a real cost, so it never happens implicitly. `here-worker` is
    # the auto-pick landing on a pool worker, which is the intended outcome --
    # no warning, because nothing surprising happened.
    if [[ "$MODE" == "here" ]]; then
      red "WARNING: running the full suite on THIS machine ($(hostname -s))."
      red "         ~13k tests, several minutes of pinned CPU. Ctrl-C now to offload instead."
    fi
    cd "$CLI_DIR"
    # shellcheck disable=SC2046
    # Local exec: pass the array straight through. No command string is built,
    # so there is nothing for a second shell to re-split.
    if ((${#VITEST_ARGS[@]})); then
      exec bun run test -- "${VITEST_ARGS[@]}"
    fi
    exec bun run test
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

    # NOT under ~/.agents: that directory is itself a git repo (the DotAgents
    # repo). A tree unpacked inside it makes `git rev-parse --show-toplevel`
    # resolve to ~/.agents for anything in the suite that asks, and shows up as
    # `?? test-runs/` in the operator's own repo status. ~/.cache has no git
    # ancestor, which is why sandbox.sh's ~/workspaces choice never hit this.
    remote_dir="\$HOME/.cache/agents-cli/test-runs/tree"
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
      "$TREE_ROOT/" "$ADDR:${remote_dir#\$HOME/}/"

    # Give the shipped tree its own git repo. The WHY lives in
    # bound-repo-root.sh's docblock -- one explanation, one place. Fails loud:
    # without a repo, anything resolving a repo root breaks.
    ssh "$ADDR" "bash $remote_dir/cli/scripts/bound-repo-root.sh $remote_dir" \
      || die "could not give the shipped tree a git repo on '$DEVICE' -- refusing to run the suite, since anything resolving a repo root would fail or escape"

  green "Tree shipped. Running the suite on $DEVICE..."
    ssh "$ADDR" "cd $remote_dir/cli \
      && bun install --silent \
      && bun run build >/dev/null \
      && bun run test$(vitest_suffix)"
    ;;

  crabbox)
    [[ -x scripts/sandbox.sh ]] || die "scripts/sandbox.sh missing -- cannot offload"
    if ! command -v crabbox >/dev/null 2>&1; then
      die "--crabbox was requested but crabbox is not installed on this machine.
  Drop the flag to auto-pick a fleet worker: scripts/test.sh
  Or name one:                              scripts/test.sh --device yosemite-m1"
    fi
    # Fail loud, never silently local. Name the explicit alternatives without
    # guessing whether a credential, provider, network, or crabbox operation failed.
    # VITEST_ARGS must ride through here too. The producer passes
    # `-- --retry=2 --maxWorkers=2` and offload is its DEFAULT mode, so dropping
    # them silently removes the mitigation that keeps a good tree from
    # false-failing (see release-attestation-produce.sh's RUSH-3015 note).
    if ! scripts/sandbox.sh test ${VITEST_ARGS[@]+"${VITEST_ARGS[@]}"}; then
      die "the crabbox run failed; the command output above is the source of truth.
  To auto-pick a fleet worker instead: scripts/test.sh
  To pin THIS machine:                 scripts/test.sh --here"
    fi
    ;;
esac
