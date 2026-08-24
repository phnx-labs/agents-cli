---
type: fix
---

- **An offline device keeps its spec cell (RUSH-3096).** `agents devices list`
  rendered a down box as a bare `ci-runner-fsn1  linux  offline`, because a failed
  probe wrote a row with no hardware facts over the cached one. Cores, total RAM,
  and root-disk capacity now survive an unreachable probe and render beside the
  offline marker — `ci-runner-fsn1  linux  8c 16G 500G  offline`. Load, memory, and
  disk-used stay blank (there is no current reading for a box that did not answer),
  and the Fleet capacity footer still counts only reachable devices.
  Source: `apps/cli/src/lib/devices/stats-cache.ts`, `apps/cli/src/commands/ssh.ts`.
