- **`agents sessions --all` now widens every non-status filter, not just the
  directory (RUSH-2055).** `--all` used to only drop the current-project scope; it
  now also drops the 30-day window cap, so one flag means "all values for every
  non-status filter" — all directories AND all time. `--active` still composes as a
  status filter, and `-a` / `--device` / `--since` still narrow their own axis (an
  explicit `--since` overrides the all-time default). Applies to both the bare
  listing and `--active`. Source: `apps/cli/src/commands/sessions-browser.ts`.
