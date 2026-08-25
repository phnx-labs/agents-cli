- **The attestation producer skips the helper manifest by default too (RUSH-3216).**
  `release.sh` gained `--with-helpers` so an ordinary release does no helper work, but
  `release-attestation-produce.sh` kept the same unconditional
  `release-manifest.sh` verification — so the coupling survived one step upstream. Found
  live: a one-line **comment** fix in `native/computer-mac/scripts/build.sh` (an
  `apps/cli/` → `cli/` path in prose) changed that helper's input digest and aborted an
  otherwise-clean 1.22.49 attestation, for a helper the tarball no longer ships and the
  CLI resolves from its own tag. The producer now takes the same `--with-helpers` flag,
  default off. Source: `cli/scripts/release-attestation-produce.sh`.
