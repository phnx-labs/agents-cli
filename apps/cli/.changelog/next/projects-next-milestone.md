- **`agents projects status` shows the next Linear milestone.** A new `next` line names
  the project's earliest unfinished milestone with its progress and a human due date
  (`Beta cut · 3/8 · due in 6 days`, `overdue by 3 days`, `due Aug 21`) — a percentage
  says how far along a project is, the milestone says what it is due to hit next. The
  milestone list comes from the project rather than from issue assignments, so a
  milestone with nothing filed under it yet still shows; it rides along on the first
  page of the existing issue fetch, costing no extra request. Source:
  `apps/cli/src/lib/linear-project-counts.ts`.
