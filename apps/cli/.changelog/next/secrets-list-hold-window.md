- **`agents secrets list` now states the hold window instead of the bare word
  `hold`.** The `hold` tier is a duration — prompt once, then stay silent for
  `secrets.agent.holdMs` (7 days by default) — but the POLICY column printed only
  the tier name, so a reader could not tell it meant a window, let alone which
  one; finding out meant running `agents secrets status`. The column now reads
  `hold 7d`, and `hold 7d · held 6d` while the broker is actually caching the
  bundle. It follows the configured window, so a 24-hour hold reads `hold 1d`.
  `always` and `never` are unchanged — neither has a window, and annotating one
  would repeat the mistake the `daily` rename fixed. Two adjacent bugs go with
  it: `agents secrets view` printed "7d by default" as a string literal and so
  misstated the window for anyone who had configured `holdMs`, and a stale broker
  entry past its expiry rendered as `hold · held expired` because the column
  tested the entry for presence rather than liveness. `secrets list --json` and
  `secrets view --json` gain an additive `holdMs` field (null on `always`/`never`)
  so a machine caller gets the window too. Source:
  `apps/cli/src/commands/secrets.ts`.
