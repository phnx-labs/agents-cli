- **`agents secrets list` can be filtered.** It had no filtering at all —
  `--host` picks a machine and `--json` picks a format, but nothing selected over
  the bundles themselves, so "which of these read with no Touch ID?", "which
  still store a raw value inline?", "what have I not touched in three months?"
  meant piping the table through `grep` or went unanswered. There is now an axis
  per question: a `[query]` positional over name and description, `--policy`,
  `--backend`, `--type`, `--kind`, `--held`/`--not-held`, `--expired`,
  `--expiring [days]`, `--unused <duration>`, plus `--sort` and `-n/--limit`.
  Every axis narrows independently, so they compose. Following the `agents
  sessions` house style, an unknown value is a loud error naming the valid set
  rather than an empty list, filters apply before `--json` so the payload is the
  exact twin of the table, and they are forwarded over `--host` so a remote list
  narrows the same way. `--held`/`--not-held` read live broker state and so
  refuse to run off macOS instead of reporting every bundle as unheld. An empty
  result names the filters that emptied it and the total it started from. Source:
  `apps/cli/src/lib/secrets/list-filter.ts`, `apps/cli/src/commands/secrets.ts`.

- **The EXPIRING column no longer hides keys that have already expired.**
  `countExpiringSoon` counted only keys due in the next 30 days — the guard is
  `d >= 0` — so a bundle whose token died last month rendered `-`, identical to
  one with no expiry at all. The only places a lapsed key surfaced were
  `agents secrets view` and a hard abort at inject time, i.e. after it had already
  broken a run. The column now counts lapsed and upcoming together and turns red
  once anything has lapsed, and `secrets list --json` gains an `expired` count
  alongside the existing `expiringSoon`. Source: `apps/cli/src/commands/secrets.ts`.
