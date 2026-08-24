---
type: fix
---

- **`agents sessions trace` steps read by what the command DID, not their `cd`
  prefix.** A shell step's label now strips the leading throwaway statements —
  `cd <repo> &&`, `export X=Y;`, `set -e`, `source …`, and bare `VAR=val`
  assignments — so `cd /long/path && git fetch origin` renders as
  `git fetch origin`, and a multi-line script whose first line is `cd <repo>`
  shows its real command instead. Before this, most rows in a coding session
  rendered an identical `cd [HOME]/…/<repo>` and the trajectory was unreadable;
  now every row is distinct and agrees with its program badge. Pipelines are left
  intact and a command that is nothing but `cd` is shown as-is. Fixed at the
  model (`buildTrajectory`), so the HTML, text, and `--json` renderings all
  benefit. Source: `apps/cli/src/lib/session/trajectory.ts`.
- **Trace durations roll into hours past 60 minutes.** An overnight idle gap now
  reads `24h01m` instead of `1441m18s`, in both the HTML and the compact text
  renderings. Source: `apps/cli/src/lib/session/trajectory-html.ts`,
  `trajectory-text.ts`.
