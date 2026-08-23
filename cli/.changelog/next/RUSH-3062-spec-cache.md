---
type: fix
---

A device-stats row cached by a CLI that predates disk collection is no longer treated as fresh specs. The static-spec tier has a 7-day TTL, so after upgrading, `agents devices list` served those pre-disk rows and rendered the new `disk` column as `—` on every run until something forced a live probe — the feature looking broken rather than being broken. A reachable row with no `diskTotalBytes` is now stale by definition, since the probe it came from could not have produced one. An unreachable row is unaffected: it legitimately has no disk and re-probing cannot help.
