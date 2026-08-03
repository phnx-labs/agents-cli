- **Menu bar ACTIVE is an accordion: projects collapsed by default, with session
  detail on fold-open.** The dropdown no longer lists every Claude row under
  each repo. Each project is one status strip (`agents-cli  ●8 ◐1  zion`); click
  `▶` to fold it open, click a session to fold open a quick view (work title,
  local/remote + surface, repo/cwd, Linear ticket / PR when known, duration,
  session id) built entirely from the warm `sessions --active` cache — expand
  does not re-run the CLI or re-index transcripts. Source:
  `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`,
  `LocalState.swift`, `Models.swift`.
