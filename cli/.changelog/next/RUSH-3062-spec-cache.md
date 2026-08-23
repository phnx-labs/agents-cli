---
type: fix
---

A device-stats row cached by a CLI that predates disk collection is no longer treated as fresh specs. The static-spec tier has a 7-day TTL, so after upgrading, `agents devices list` served those pre-disk rows and rendered the new `disk` column as `—` on every run until something forced a live probe — the feature looking broken rather than being broken. Staleness keys off `specsFetchedAt`, which both probe parsers set unconditionally and which arrived with disk collection, rather than off disk being absent: a probe can legitimately succeed without measuring disk (`df -Pk /` failing on an odd mount, `Win32_LogicalDisk` returning null for `C:`), and treating that as stale would re-probe those boxes on every `devices list` forever, since the next probe cannot produce the field either.
