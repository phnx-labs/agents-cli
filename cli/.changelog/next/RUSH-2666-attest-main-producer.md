- **Auto-produce the origin/main release attestation on merge (RUSH-2666).** A new
  `attest-main.yml` workflow runs the full suite on every push to `main` and uploads
  the exact-tree attestation + pretested tarball to a rolling `main-attestations`
  GitHub Release, keyed by tree hash. `release.sh` now prefetches that proof into the
  local store before waiting, so an ordinary release promotes without running the
  suite inline — no more human running the suite by hand to unwedge a release. Purely
  additive and fail-safe: on any fetch miss or error it falls back to exactly the
  prior poll-then-`require` behavior, and a fetched proof is trusted only because the
  existing exact-tree `require` re-verifies it. Source: `cli/scripts/release.sh`,
  `.github/workflows/attest-main.yml`.
