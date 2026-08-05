### Fixed

- **`agents sync --local -y` refreshes every installed version, not only the default.**
  Unattended reconcile (`refresh({ skipPrompts })`) previously wrote resources and
  registered hooks into each agent's default version alone, so non-default homes
  kept stale hooks after a system update. Unattended refresh now loops
  `listInstalledVersions` for both resource sync and hook registration.
  Interactive refresh still targets the default only. Source:
  `apps/cli/src/lib/refresh.ts`.
