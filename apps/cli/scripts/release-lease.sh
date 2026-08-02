#!/usr/bin/env bash
#
# release-lease.sh -- mutual exclusion for release.sh, held on `origin`.
#
# Why a git ref and not flock: agents release from whichever box they happen to
# be on (zion, mac-mini, yosemite-*, a Hetzner crabbox). A filesystem lock is
# invisible across machines, so two agents on two boxes both enter release.sh
# and race the same release branch, tag, and publish. Every box already
# authenticates to origin, so origin is the one place they can agree on.
#
# The mutex is `git push` itself. The lease ref points at an ORPHAN commit (no
# parents), so a second claimant's push can never be a fast-forward of the
# first's -- git rejects it, and that rejection IS the failed lock acquisition.
# No polling, no TTL race, no second service to run.
#
# Usage:
#   release-lease.sh claim <version> [--ttl-min N]   # 0 = acquired, 1 = held by someone else
#   release-lease.sh renew                            # refresh our lease's timestamp
#   release-lease.sh verify                           # 0 = we still hold it, 1 = we do NOT
#   release-lease.sh release                          # drop the lease we hold
#   release-lease.sh status                           # print the current holder, if any
#
# Env:
#   RELEASE_LEASE_REF   override the ref (tests point this at a scratch ref)
#   RELEASE_LEASE_TTL   minutes before an unrenewed lease is reclaimable (30)
#
# A lease older than the TTL is reclaimable: a release that dies without running
# its trap (SIGKILL, a severed ssh, a rebooted box) must not wedge the pipeline
# forever. Reclaiming is itself a compare-and-swap (--force-with-lease pinned to
# the exact stale sha), so two agents reclaiming at once still yield one winner,
# and the stale holder is always logged rather than silently overwritten.
#
# The TTL must NOT be read as "how long a release takes" -- it is "how long since
# the holder last proved it was alive". A real release routinely outlives any
# sane TTL: the CI matrix alone has run 57 minutes, and release 1.20.77 took 186
# minutes wall clock. So a live release RENEWS (release.sh runs a renewer in the
# background for the whole run), and every irreversible step -- merge, tag,
# publish -- calls `verify` first and refuses to proceed if the lease is no
# longer ours. Without both, a long-but-healthy release would have its lease
# reclaimed mid-flight and two releasers would run at once, which is the exact
# failure this script exists to prevent.

set -euo pipefail

LEASE_REF="${RELEASE_LEASE_REF:-refs/release-lock/held}"
DEFAULT_TTL_MIN="${RELEASE_LEASE_TTL:-30}"

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
gray()  { printf '\033[2m%s\033[0m\n'  "$*"; }
die()   { red "error: $*"; exit 2; }

# Describe the holder for a human reading a stuck lease: a real box and, when the
# releaser is an agent, a real session. This is DIAGNOSTIC text only -- ownership
# is decided by the lease token below, never by matching this string. A release
# spans several invocations (claim, then a resumed run that finishes a merged PR),
# so anything process-scoped like $$ would make a lease undroppable by its own
# owner on the second invocation.
holder_desc() {
  local host
  if [[ "$(uname)" == "Darwin" ]]; then
    host="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
  else
    host="$(hostname -s 2>/dev/null || hostname)"
  fi
  printf '%s/pid-%s%s' "$host" "$$" \
    "${AGENTS_SESSION_ID:+/session-$AGENTS_SESSION_ID}"
}

# Ownership token: the sha of the lease commit WE pushed. Whoever can name the
# exact commit the remote ref points at is its owner -- that is what makes
# `release` safe to run from a different process than `claim`, and what stops a
# third agent from dropping a lease it never held.
token_path()   { printf '%s/release-lease.token' "$(git rev-parse --git-common-dir)"; }
# Every sha this run has ever pushed for the CURRENT lease. `renew` rotates the
# lease commit, and the rotation is not atomic with updating the token file: the
# renewer pushes sha2, and only then writes it. A concurrent `release` reading
# just the current token would see sha1, find sha2 on origin, conclude the lease
# was reclaimed, and leave it alone -- orphaning our own lease until its TTL.
# Checking membership in the history closes that window: any sha in here is one
# WE authored, so it is ours to drop.
history_path() { printf '%s/release-lease.history' "$(git rev-parse --git-common-dir)"; }
read_token()   { cat "$(token_path)" 2>/dev/null || true; }
write_token()  { printf '%s\n' "$1" >> "$(history_path)"; printf '%s\n' "$1" > "$(token_path)"; }
clear_token()  { rm -f "$(token_path)" "$(history_path)"; }
# A fresh claim starts a fresh history -- shas from a previous, already-released
# lease must never make us think we own someone else's current one.
reset_token()  { clear_token; }
owned_token() { # $1 = a sha seen on origin
  [[ -n "${1:-}" ]] || return 1
  grep -qxF "$1" "$(history_path)" 2>/dev/null
}

# Read the remote lease, if any. Echoes the sha; empty when unheld.
remote_lease_sha() {
  git ls-remote origin "$LEASE_REF" 2>/dev/null | awk '{print $1; exit}'
}

# Fetch the lease commit so we can read its message + timestamp locally.
fetch_lease() {
  git fetch --quiet --force origin "$LEASE_REF:refs/lease-cache/held" 2>/dev/null || return 1
}

lease_field() { # $1 = sha, $2 = field name
  git log -1 --format=%B "$1" 2>/dev/null | awk -F': ' -v k="$2" '$1==k {print $2; exit}'
}

lease_age_min() { # $1 = sha
  local when now
  when="$(git log -1 --format=%ct "$1" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  [[ "$when" -gt 0 ]] || { echo 999999; return; }
  echo $(( (now - when) / 60 ))
}

describe_lease() { # $1 = sha
  local v h a
  v="$(lease_field "$1" version)"; h="$(lease_field "$1" holder)"; a="$(lease_age_min "$1")"
  printf 'version=%s holder=%s age=%smin' "${v:-?}" "${h:-?}" "$a"
}

# Build the orphan lease commit. No parents is what makes every claim a
# non-fast-forward against any existing lease, which is the whole mechanism.
make_lease_commit() { # $1 = version
  local tree msg
  tree="$(git hash-object -t tree /dev/null)"
  msg="release lease

version: $1
holder: $(holder_desc)
claimed: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git commit-tree "$tree" -m "$msg"
}

cmd_claim() {
  local version="${1:-}" ttl="$DEFAULT_TTL_MIN"
  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ttl-min) ttl="${2:?--ttl-min needs a value}"; shift 2 ;;
      *) die "unknown flag: $1" ;;
    esac
  done
  [[ -n "$version" ]] || die "claim needs a version"

  local sha
  sha="$(make_lease_commit "$version")"
  reset_token   # a new claim starts a new ownership history

  # First attempt: create the ref. Succeeds only when nobody holds it.
  if git push --quiet origin "$sha:$LEASE_REF" 2>/dev/null; then
    write_token "$sha"
    green "release lease acquired for $version ($(holder_desc))"
    return 0
  fi

  # Held. Decide between "someone is actively releasing" and "a dead run left
  # this behind" -- never guess, read the lease.
  local held age
  held="$(remote_lease_sha)"
  if [[ -z "$held" ]]; then
    # The ref vanished between our push and this read (the holder finished).
    # One retry, then report contention rather than spinning.
    if git push --quiet origin "$sha:$LEASE_REF" 2>/dev/null; then
      write_token "$sha"
      green "release lease acquired for $version ($(holder_desc))"
      return 0
    fi
    red "release lease is contended; another releaser claimed it first"
    return 1
  fi

  fetch_lease || true
  age="$(lease_age_min "$held")"
  if [[ "$age" -lt "$ttl" ]]; then
    red "release already in flight -- not starting a competing one"
    gray "  lease: $(describe_lease "$held")"
    gray "  it expires (becomes reclaimable) after ${ttl}min; watch that release instead of racing it"
    return 1
  fi

  yellow "reclaiming a stale release lease (${age}min old, TTL ${ttl}min)"
  yellow "  stale holder: $(describe_lease "$held")"
  # CAS the delete against the exact sha we inspected, so two agents reclaiming
  # the same stale lease still produce one winner.
  if ! git push --quiet --force-with-lease="$LEASE_REF:$held" origin ":$LEASE_REF" 2>/dev/null; then
    red "another releaser reclaimed the stale lease first"
    return 1
  fi
  if git push --quiet origin "$sha:$LEASE_REF" 2>/dev/null; then
    write_token "$sha"
    green "release lease reclaimed for $version ($(holder_desc))"
    return 0
  fi
  red "lost the race to re-claim after reclaiming"
  return 1
}

cmd_renew() {
  local mine held sha
  mine="$(read_token)"
  [[ -n "$mine" ]] || { red "no release lease claimed from this checkout"; return 1; }

  held="$(remote_lease_sha)"
  if ! owned_token "$held"; then
    # Reclaimed or dropped while we were working. Fail loudly: the caller must
    # stop before its next irreversible step, not carry on believing it is alone.
    red "release lease is no longer ours -- another releaser holds it"
    [[ -n "$held" ]] && { fetch_lease || true; gray "  now held by: $(describe_lease "$held")"; }
    return 1
  fi

  fetch_lease || true
  sha="$(make_lease_commit "$(lease_field "$held" version)")"
  if git push --quiet --force-with-lease="$LEASE_REF:$held" origin "$sha:$LEASE_REF" 2>/dev/null; then
    write_token "$sha"
    gray "release lease renewed"
    return 0
  fi
  red "could not renew the release lease (it was reclaimed mid-renew)"
  return 1
}

# Fail CLOSED: any error -- no token, no ref, an unreachable origin -- is "we do
# not demonstrably hold it", never "probably fine". A verify that fails open is
# worse than no verify, because the caller would proceed into merge/tag/publish
# believing it had been checked.
cmd_verify() {
  local mine held
  mine="$(read_token)"
  [[ -n "$mine" ]] || { red "release lease: no token in this checkout"; return 1; }
  held="$(remote_lease_sha)" || { red "release lease: could not read origin"; return 1; }
  [[ -n "$held" ]] || { red "release lease: the lease is gone from origin"; return 1; }
  # Any sha this run pushed counts as ours -- a renew that landed between the
  # token write and this check is still us, not a reclaim.
  if ! owned_token "$held"; then
    fetch_lease || true
    red "release lease: no longer ours -- held by $(describe_lease "$held")"
    return 1
  fi
  gray "release lease still ours"
  return 0
}

cmd_release() {
  local mine held
  mine="$(read_token)"
  if [[ -z "$mine" ]]; then
    gray "no release lease to drop"
    return 0
  fi

  held="$(remote_lease_sha)"
  if [[ -z "$held" ]]; then
    clear_token
    gray "release lease already gone"
    return 0
  fi
  # Match against every sha this run pushed, not just the latest token. A renew
  # that pushed but had not yet written its token would otherwise look like a
  # reclaim by someone else, and we would orphan our own lease until its TTL.
  if ! owned_token "$held"; then
    # Genuinely reclaimed (our run outlived the TTL). Dropping it now would hand
    # the pipeline to a third agent while the real holder is publishing.
    fetch_lease || true
    yellow "release lease is no longer ours -- leaving it alone"
    gray "  now held by: $(describe_lease "$held")"
    clear_token
    return 0
  fi

  git push --quiet --force-with-lease="$LEASE_REF:$held" origin ":$LEASE_REF" 2>/dev/null \
    || { yellow "could not drop the release lease (already gone or reclaimed)"; clear_token; return 0; }
  clear_token
  gray "release lease dropped"
}

cmd_status() {
  local held
  held="$(remote_lease_sha)"
  if [[ -z "$held" ]]; then
    echo "unheld"
    return 0
  fi
  fetch_lease || true
  echo "held $(describe_lease "$held")"
}

case "${1:-}" in
  claim)   shift; cmd_claim "$@" ;;
  renew)   shift; cmd_renew "$@" ;;
  verify)  shift; cmd_verify "$@" ;;
  release) shift; cmd_release "$@" ;;
  status)  shift; cmd_status "$@" ;;
  -h|--help|"") sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "unknown subcommand: $1" ;;
esac
