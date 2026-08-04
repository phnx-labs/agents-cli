- **Menu bar recovers from a stale single-instance lock instead of staying dead.**
  The helper's lock fd is now opened `O_CLOEXEC`, so a spawned `doctor` child can
  never inherit it and hold the `menubar.lock` flock after the helper crashes; and
  `SingleInstance.acquire` now self-heals — when the flock is held but no live
  `MenubarHelper` owns it (a leaked orphan / dead pid), it reaps the orphan and
  retries rather than exiting as "already running". Previously a leaked orphan
  bricked the menu bar until reboot. The headless Swift self-tests (single-instance
  + child-process) now run as a build gate (`menubar/scripts/test-menubar.sh`),
  which nothing invoked before. Source: `apps/cli/menubar/Sources/MenubarHelper/SingleInstance.swift`.
