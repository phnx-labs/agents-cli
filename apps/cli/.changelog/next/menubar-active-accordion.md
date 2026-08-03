- **Menu bar ACTIVE: project accordion + session detail submenu.** Projects are
  collapsed by default as a status strip (`▶ agents-cli  ●8 ◐1  zion`); click
  `▶`/`▼` to fold agents open under the project (idle-row caps removed — collapse
  is the wall protection). Focusing an agent opens a side submenu with linkable
  detail (work title URL, cwd, Linear ticket, GitHub PR, duration, copy session
  id) from the warm `sessions --active` cache. Accordion reopen rebuilds from
  cache only (no teams walk / no CLI schedule). Local/remote uses the same host
  normalize as CLI `machineId()` so local rows are not mislabeled remote. Source:
  `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`,
  `LocalState.swift`, `Models.swift`.
