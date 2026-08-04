- **A blocked menu-bar row now takes you to the session (RUSH-2110).** A NEEDS-YOU row
  exists because an agent is waiting on you, but its only action was "Reveal working
  dir", which unblocks nothing — you still had to go find the session by hand. Blocked
  rows now lead with **Focus session**, which runs `agents focus <id>`: attach the live
  terminal, or open a new tab and resume, cross-host. Reveal stays underneath. Both
  render paths are covered — the single inline row and each entry inside a collapsed
  multi-waiter group. A row the engine could not identify (a cloud task, a stale
  sentinel) simply omits the item rather than offering an action that would do nothing.
  Source: `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`,
  `AgentsCLI.swift`.
