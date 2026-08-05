- **`agents fork` is now `agents sessions fork`.** Forking is a session operation, so
  it lives under the `sessions` group next to `resume`/`focus` — `agents sessions fork
  <id>` branches a conversation into a new, independent copy you can continue separately,
  leaving the original untouched. The old top-level `agents fork` keeps working as a
  hidden alias, so nothing that scripted it breaks. For a harness without a native copy
  (anything but Claude today), the command now fails loud and names the manual branch —
  start a fresh agent and seed it with `/continue <id>` — instead of only saying
  "unsupported". Source: `apps/cli/src/commands/fork.ts`,
  `apps/cli/src/commands/sessions.ts`.
