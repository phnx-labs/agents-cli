- **`agents sessions --active` now shows one row per agent, not one per directory.**
  A live tmux agent pane whose durable identity records were missing (the common case
  once meta/pid-registry entries age out) was dropped, then re-surfaced by the ps-scan
  under the newest transcript in its cwd — so many distinct sessions collapsed onto one
  stranger's id with an inflated `×N` badge, and `agents sessions focus <id>` could not
  find them. The scanner now recovers the session id straight from the `ag-<agent>-<shortid>`
  tmux pane name (resolved to the full UUID via the short-id index in one batched query),
  and refuses to borrow a co-located sibling's transcript when no id is known — so every
  live session surfaces as its own row and is focus-able again. Also adds a `runTmux`
  timeout so a wedged tmux server can't hang the scan. Source: `apps/cli/src/lib/session/active.ts`.
