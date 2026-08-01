- **A Linux-driven release now auto-discovers its macOS sign host instead of
  hardcoding `mac-mini`.** `scripts/remote-sign-mac.sh` previously defaulted
  `SIGN_HOST` to `mac-mini`, so a release from a Linux box failed outright whenever
  that one appliance was offline — the recurring reason a release stalled and a
  human had to finish it by hand. With `SIGN_HOST` unset the script now reads
  `agents devices list --json`, keeps the reachable/online macOS devices, and picks
  the first that answers `ssh` in preference order `mac-mini` → `zion` → any other
  online Mac. `mac-mini` stays first because it signs headlessly (no Touch ID);
  `zion` (the interactive Mac) is the fallback. An explicit `SIGN_HOST=<host>` still
  pins one and skips discovery, and when no reachable Mac qualifies the script fails
  with the ordered list it tried rather than hanging on a dead host. Source:
  `apps/cli/scripts/remote-sign-mac.sh`.
