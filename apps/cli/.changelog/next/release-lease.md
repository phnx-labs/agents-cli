- **`release.sh` now takes a release lease, and refuses to bump past an
  unpublished tag.** Releases run from whichever fleet box an agent happens to be
  on, so two agents could enter the pipeline at once; the collision only surfaced
  at the publish gate (`merged tree != built tree -- refusing to publish`), after
  one run had already merged and tagged, leaving the version merged but unshipped.
  A new `scripts/release-lease.sh` holds mutual exclusion on `origin` as an orphan
  commit at `refs/release-lock/held` — a second claimant's push can never be a
  fast-forward, so git's rejection *is* the failed lock acquisition. The lease is
  claimed before the first mutation and dropped by the existing cleanup trap on
  every exit path. Because a healthy release routinely outlives any sane
  expiry — the CI matrix alone has run 57 minutes and release 1.20.77 took 186
  minutes — the lease is **renewed** by a background renewer for the whole run,
  and the squash-merge, the tag, and the publish each **verify** ownership first,
  failing closed if it can no longer be proven. A lease that stops being renewed
  is reclaimable after 30 minutes, and reclaiming names the dead holder instead
  of silently overwriting it. Separately,
  `release.sh` now refuses to cut a new version while an older `v*` tag exists
  that npm never received, and points at the re-run that finishes it — bumping
  past an unpublished tag is what turned a one-version gap into npm 1.20.78 vs
  main 1.20.81. Source: `apps/cli/scripts/release-lease.sh`,
  `apps/cli/scripts/release.sh`.
