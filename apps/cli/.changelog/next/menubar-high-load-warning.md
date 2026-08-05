- **Menu bar warns when a device is under high load (local or remote).** The
  agents-cli menu bar now shows a `⚠ <device> — high load N%` row in NEEDS YOU when
  a machine's load or memory crosses the `headroom()` "loaded" threshold (≥75%), and
  a red `✕` when critical. The local machine is probed natively via `getloadavg`
  (zero subprocess); fleet peers come from the daemon-warmed `.fleet-stats.json`
  cache with a freshness guard — never the slow `agents doctor` path. Action-required
  rows are now emphasized so items that need you stand out. Source:
  `apps/cli/menubar/Sources/MenubarHelper/LocalState.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`.
