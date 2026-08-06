- **Coexisting agents-cli installs no longer fight over the menu-bar helper.** The
  helper lives at one path in Application Support, but every install on the box runs
  the startup self-heal, and both the version stamp and the plist's baked
  `AGENTS_ENTRY` record whichever copy acted last — so each copy read the others'
  marks as drift and recopied the app bundle over them. Recopying replaces the
  executable under the running helper and kills it, launchd `KeepAlive` restarts it,
  and the next copy repeats it: a new pid every 5-15 seconds, 578 launches in one
  observed helper log, and a status item that never stayed visible while
  `agents menubar status` still reported `running: yes` (a pid always existed). The
  plist's `AGENTS_ENTRY` is now treated as the owner: only that install reinstalls
  the helper, and another install takes over only once the recorded owner is gone
  from disk. A same-install upgrade keeps its entry path, so `npm update` still
  installs the new helper normally. Fixes #2109. Source:
  `apps/cli/src/lib/menubar/install-menubar.ts`.
