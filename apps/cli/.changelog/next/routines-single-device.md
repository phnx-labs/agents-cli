- **A routine now runs on exactly one device, instead of once per device listed.** `devices:`
  was an allowlist where *every* listed device fired independently, so a routine pinned to two
  boxes ran twice on every schedule — two full agent sessions doing identical work and burning
  double the agent quota. On one live fleet seven routines were in that state: `security-sweep`
  ran at 15:30:02 on one box and 15:30:03 on the other, both completing. Ownership is now a pure
  function of the config (the first device in normalized sort order), so every daemon reaches the
  same answer with no lease, no cross-device coordination, and no split brain when the fleet
  partitions. Omitting `devices` still means fleet-wide, which is what `watchdog` and
  `check-updates` want.
- **`agents routines add --devices a,b` and `devices --set a,b` are now rejected.** A routine
  belongs to one machine; the error names the fix. Routines already on disk with a multi-device
  pin keep running — on their owner only — rather than being dropped.
- **`agents doctor` lists any routine still carrying a multi-device pin**, with the devices it
  names, the one that now fires, and the command to make it explicit. Also in `doctor --json` as
  `ambiguousDevicePins`. The remediation deliberately offers the candidates rather than
  prescribing the owner: the lowest-sorted name can be a registry alias that matches no live
  machine, and cementing that would keep the routine dead.
