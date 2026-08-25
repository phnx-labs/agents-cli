- `agents traces sync --dry-run --out <dir>` computes the derived trace shards
  from your local `sessions.db` and writes them to a directory — no Phoenix
  sign-in, no worker, no upload — so you can verify your real trajectories
  before the hosted path is wired.
- The per-session drill-down (`sessions/<id>.json`) now emits a `SessionDetail`
  (a `meta` summary — spanMs/turns/tools/errorCount/tokens/cost/outcome/repo —
  plus a plain-language `whereItWentWrong`) that the Phoenix Evals console
  consumes directly, instead of the raw internal trajectory shape.
