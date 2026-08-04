- **`--host <self>` and the fleet-health fan-out now short-circuit ALL of the
  local machine's names, not just its short hostname (RUSH-2114).** A `--host`
  target or fleet probe that referenced this box by its **tailscale dnsName**
  (`zion.tail1a85a1.ts.net`) slipped past a `=== machineId()` check and SSH'd to
  the local box over its own name; on a loaded machine that self-SSH'd `doctor
  --json` orphaned on timeout and piled up until the host was crushed. A new
  `isSelfHost()` matches every identity the box answers to (short id, loopback,
  tailscale dnsName + its short form) and gates the generic `--host` passthrough
  (`maybeRunOnHost`), `remoteFleetTargets`, and `runFleet` so a self-reference
  runs locally instead of self-SSHing. Source:
  `apps/cli/src/lib/devices/self-host.ts`, `apps/cli/src/lib/hosts/passthrough.ts`,
  `apps/cli/src/lib/devices/fleet.ts`.
