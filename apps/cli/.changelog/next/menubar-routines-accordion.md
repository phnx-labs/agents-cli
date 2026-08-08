- **Menu bar: the ROUTINES section is now a collapsible project-group accordion.**
  Routines render the same way ACTIVE sessions do — one collapsible header per
  project group (a project name, or the `Operations` / `All projects` /
  `Cross-project` specials the CLI derives from each routine's `projects:` field),
  collapsed by default, click `▶` to fold every routine in that group inline. Each
  header carries per-state glyph counts (`◔` upcoming, `✕` failing, `⃠` missed,
  `⏸` not-ready) and a paused tail, so a collapsed group still shows what is inside
  it; the header row also names the group count (`ROUTINES · … · N groups`).
  Expanding a group orders it attention-first, then by next run, then paused last.
  This replaces the flat group labels plus the single "All routines…" flyout for a
  CLI that emits `projectGroup`; an older CLI falls back to the previous view.
  Source: `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`.
