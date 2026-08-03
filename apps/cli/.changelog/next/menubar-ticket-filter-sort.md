- **Quick-dispatch ticket list: one-row filter + sort, and a scrollable list.**
  The ticket controls sit on a single row of popups next to the Linear project
  (project · filter · sort) — not a chip matrix or two-column block. Quick filter
  options: All open, Todo, Doing, Backlog, P1 only, P2 only, Overdue. Quick sort
  options: Urgent first, Newest, Oldest, Due date, Priority (flat list, no
  status grouping). Filter and sort picks are remembered across summons. Ticket
  rows scroll inside a fixed viewport so more than five matches stay reachable
  without growing the panel. Source:
  `apps/cli/menubar/Sources/MenubarHelper/LinearTickets.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`.
