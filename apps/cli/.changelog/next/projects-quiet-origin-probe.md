- **`agents projects import --from-factory` stops printing raw git errors.** Reading each
  checkout's real remote is done per registry row, and a checkout with no `origin` makes git
  write `error: No such remote 'origin'` straight to the terminal — its own stderr, which the
  surrounding try/catch never sees. Importing 12 rows printed two of them between the progress
  lines. The probe now discards git's stderr; an absent remote is an expected answer, not
  something to report. Source: `apps/cli/src/commands/projects.ts`.
