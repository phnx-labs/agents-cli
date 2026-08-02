- **`agents.yaml` no longer churns on every meta write.** `writeMetaUnlocked` wrote
  the central config with `yaml.stringify`, which strips all comments — so the
  freshly-serialized bytes never matched the comment-annotated file on disk,
  `writeIfChanged` rewrote it on every meta write, and the perpetually-dirty tree
  wedged `agents sync` ("Blocked by local changes") across the fleet. It now
  serializes via a `yaml.Document` round-trip (`serializeCentral`) that edits only
  the keys that actually changed, so comments, key ordering, and untouched
  top-level blocks (e.g. `hosts:`) are byte-stable — and a write that changes no
  central field leaves `agents.yaml` untouched. Source: `apps/cli/src/lib/state.ts`.
