- **`agents routines add`, `run`, and `runs` now support `--json`.** Previously only
  `list`/`status` emitted JSON, so an agent creating a routine or triggering a run
  had to scrape human strings for the job name / run id. `add` emits
  `{ ok, added, job }`, `run` emits `{ ok, job, runId, logDir }`, and `runs` emits an
  array of run records — all on stdout, with the scheduler-start banner suppressed so
  it never pollutes the JSON stream. Source: `apps/cli/src/commands/routines.ts`.
  (RUSH-1833)
