- **Fix `agents setup computer` / `agents computer setup` refusing to install a
  valid downloaded helper.** The signature check read `codesign -dv` from stdout,
  but that command writes its details to **stderr** on success — so the Team-ID
  check saw an empty string, found no `TeamIdentifier`, and rejected every
  validly-signed, notarized helper with "signed by unexpected Team (none)". It now
  reads both streams via `spawnSync`. Verified end-to-end against the real
  published `v1.20.69` release asset (download → sha256 → extract → codesign +
  Team `2HTP252L87` + `spctl` notarization → install). Source:
  `apps/cli/src/lib/computer/download.ts`.
