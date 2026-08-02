- **Session lists expose the model and richer navigation metadata (RUSH-1981,
  RUSH-1991, RUSH-1992, RUSH-1994).** Static flat rows add a compact model column
  only when the result set has model data, with width sized to that set so an
  80-column terminal does not wrap. Local CWD and ticket/PR cells are clickable
  in supporting terminals, previews identify browser/computer use and sub-agent
  counts, and `agents sessions --active --json` adds an always-present `prLink`
  key. Existing session indexes migrate to schema v20 and rescan transcripts to
  backfill model data.
