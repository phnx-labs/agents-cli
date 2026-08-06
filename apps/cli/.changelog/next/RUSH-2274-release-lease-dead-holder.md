- **Release lease detects a holder killed from outside (RUSH-2274).** An externally
  killed release (SIGKILL, a severed ssh, a rebooted box) left its lease on `origin`
  and `scripts/release-lease.sh status` read `held` for up to the 30-minute TTL with
  nothing actually releasing. The lease now records the holding `host`, `pid`, and
  that pid's start time, and `status` reports `holder-alive=yes|no|unknown`. A holder
  that is provably gone is reclaimed by the next `claim` immediately instead of
  waiting out the TTL, and a new `release-lease.sh clear` drops such a lease without
  starting a release. A live holder is never taken at any age, an unprobeable one
  (another box, or a lease from an older release) still falls back to the TTL, and a
  reused pid or an unreaped zombie counts as dead rather than as a live release.
  Source: `apps/cli/scripts/release-lease.sh`, `apps/cli/scripts/release.sh`.
