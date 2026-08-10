### Fixed

- **Menu bar NEW DEVICES no longer lists already-registered or ignored boxes.**
  The daemon's pending-device sentinel writer (`reconcilePendingSentinels`) now
  re-subtracts the registered roster as well as the ignore-list, so a hermetic
  run that empties the registry view while writing the live `devices-pending/`
  dir cannot surface every fleet box as "new". Soft-fail probe ticks (no
  tailscale) still prune dismissed sentinels, and the probe fires once on
  daemon start so leftover pollution clears without waiting for the 3-minute
  interval.
