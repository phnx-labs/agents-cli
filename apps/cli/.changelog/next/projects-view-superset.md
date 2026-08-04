- **`agents projects view <name>` now shows more than `status`, not less.** The command you
  open to learn everything about one project built its own short list — root, repos, a raw
  Linear project id, an issue count, milestones — and never called the card renderer, so it
  omitted the agents roster, merged PRs and release, focus areas, the schedule verdict,
  tickets, and artifacts that `status` had shown all along. `view` and `status` now gather
  through one function and render through one card; `view` adds every milestone (instead of
  just the next) and the stored definition in full underneath — each repo with its subpath and
  checkout, each context with its purpose, each integration with its URL. It also takes
  `--window <days>` to match `status`. Source: `apps/cli/src/commands/projects.ts`.
- **The `agents` roster on the card lists live sessions only.** It included every matched
  session, so a card headed `23 live` went on to print `claude · crashed ×25` — the corpses the
  `dead` row already reports, counted twice and contradicting the headline. Both now derive
  from one `isDeadStatus` predicate, pinned by a test across every `ActiveStatus`. Source:
  `apps/cli/src/lib/project-status.ts`.
