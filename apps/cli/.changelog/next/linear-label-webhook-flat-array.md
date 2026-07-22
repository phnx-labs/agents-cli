- **Fix the Linear `--label` trigger filter matching nothing.** `routines` and
  `monitors` jobs triggered on `linear:Issue` with `--label <name>` never fired:
  the matcher read `data.labels.nodes[].name` (the GraphQL-query connection
  shape), but Linear webhook bodies flatten list relations — `data.labels` is a
  flat array of label objects. The `.nodes` read always yielded `[]`, so every
  label filter silently failed to match. It now reads the flat array. The prior
  unit test fixtured the same wrong shape, so the suite was green while the
  integration was dead; the fixture now uses the real webhook shape and a
  regression test locks it. Source: `apps/cli/src/lib/triggers/webhook.ts`.
