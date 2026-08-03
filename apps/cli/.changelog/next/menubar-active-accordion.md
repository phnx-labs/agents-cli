- **Menu bar ACTIVE: project accordion + session detail submenu.** Projects are
  collapsed by default as a status strip (`▶ agents-cli  ●8 ◐1  zion`); click
  `▶`/`▼` to fold agents open under the project. Focusing an agent opens a side
  submenu with linkable detail (work title URL, cwd, Linear ticket, GitHub PR,
  duration, copy session id) from the warm `sessions --active` cache — expand
  never re-runs the CLI. Agent rows also chip ticket/PR at a glance. Source:
  `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`,
  `LocalState.swift`, `Models.swift`.
