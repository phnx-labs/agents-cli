- **Coexisting agents-cli installs no longer fight over the menu-bar helper.** The
  helper lives at one path in Application Support, but every install on the box runs
  the startup self-heal, and both the version stamp and the plist's baked
  `AGENTS_ENTRY` record whichever copy acted last — so each copy read the others'
  marks as drift and recopied the app bundle over them. Recopying replaces the
  executable under the running helper and kills it, launchd `KeepAlive` restarts it,
  and the next copy repeats it: a new pid every 5-15 seconds, 578 launches in one
  observed helper log, and a status item that never stayed visible while
  `agents menubar status` still reported `running: yes` (a pid always existed). The
  plist's `AGENTS_ENTRY` is now treated as the owner and only the owner reinstalls
  freely; a same-install upgrade keeps its entry path, so `npm update` still installs
  the new helper normally. Another install still gets there — immediately if the
  recorded owner is gone from disk, otherwise at most once an hour — so a stale copy
  that merely still sits on disk can't freeze the menu bar for whichever install the
  user actually upgrades. Repairs (a missing helper executable, a Developer-ID heal)
  are never gated, and `agents menubar setup` bypasses the gate as the immediate
  manual fix. `agents menubar status` no longer promises that a stale helper "runs on
  next `agents` startup", which is not guaranteed on a multi-install box. Fixes #2109.
  Source: `apps/cli/src/lib/menubar/install-menubar.ts`.
