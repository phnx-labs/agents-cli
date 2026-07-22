## Features

- Added `agents login`, `agents logout`, and `agents whoami` plus `agents secrets create --synced` for age-encrypted synced secrets stored in `~/.agents/vault.age`.
- Protected synced secrets vaults from accidental replacement: `agents login --create` and `agents login --join <path>` now require `--force` before replacing an existing `vault.age`, and synced bundle writes batch metadata plus stored keys into one vault update.
