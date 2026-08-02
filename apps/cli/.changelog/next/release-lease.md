- **`release.sh` now takes a release lease, and refuses to bump past an
  unpublished tag.** Releases run from whichever fleet box an agent happens to be
  on, so two agents could enter the pipeline at once; the collision only surfaced
  at the publish gate (`merged tree != built tree -- refusing to publish`), after
  one run had already merged and tagged, leaving the version merged but unshipped.
  A new `scripts/release-lease.sh` holds mutual exclusion on `origin` as an orphan
  commit at `refs/release-lock/held` — a second claimant's push can never be a
  fast-forward, so git's rejection *is* the failed lock acquisition. The lease is
  claimed before the first mutation and dropped by the existing cleanup trap on
  every exit path; one abandoned more than 45 minutes is reclaimable, and
  reclaiming names the dead holder instead of silently overwriting it. Separately,
  `release.sh` now refuses to cut a new version while an older `v*` tag exists
  that npm never received, and points at the re-run that finishes it — bumping
  past an unpublished tag is what turned a one-version gap into npm 1.20.78 vs
  main 1.20.81. Source: `apps/cli/scripts/release-lease.sh`,
  `apps/cli/scripts/release.sh`.
