---
type: fix
---

`agents devices capture` no longer wipes `fleet.ignored` — the captured manifest carries device dismissals forward instead of rebuilding the fleet block without them.
