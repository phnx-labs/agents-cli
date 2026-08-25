- **`scripts/publish-computer-win.sh` — a publish path for the Windows helper (RUSH-3228).**
  Its release now triggers on `computer-win/v<x.y.z>` rather than the CLI's `v*` tag, but
  nothing in the repo cut such a tag, so the trigger would have been dead — trading a
  wasteful 165 MB rebuild on every CLI release for no rebuild at all. The tag *is* the
  publish action (`release-exe` builds, smokes on a real windows-latest runner, and
  uploads the exe + sha256), so a mis-shaped tag is a silent no-op: the script refuses a
  `v`-prefixed or non-semver version, refuses an existing tag because the upload uses
  `--clobber` and an installed CLI may already pin it, and is dry-run by default.
  Symmetric with `publish-computer-helper-mac.sh`. Source: `cli/scripts/publish-computer-win.sh`.
