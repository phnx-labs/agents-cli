- **`agents feed watch` is cheap enough to leave running (PHNX-3939).** The watcher
  cost ~42% of a core steadily on a box with 1,437 activity logs / 64 MB, because
  every 500 ms tick re-read and re-parsed the whole activity corpus and re-read
  every row's block, resolution, and PR status. It now keeps a per-file cursor and
  reads only the bytes appended since the last tick (`ActivityStream`), and
  reconciles attention only when something announced a change — a block or
  resolution written under the feed dir, watched directly — or when the 45 s
  PR-status TTL has expired. Measured on the same box over 5 minutes, steady
  state: `--local` **41.9% → 0.31% CPU** (RSS 313 MB → 140 MB) and the full
  13-peer fleet fan-out **50.0% → 0.37% CPU** (RSS 606 MB → 143 MB), with an
  identical envelope stream. Source: `cli/src/lib/feed/activity-stream.ts`,
  `cli/src/lib/feed/watch.ts`.

- **A fleet peer that cannot be reached no longer gets a fresh `ssh` every few
  seconds (PHNX-3939).** `agents feed watch` and `agents sessions watch` respawned
  each peer's `--local` subscription on a bare 2 s timer with the child's stderr
  discarded, so an offline box burned a ConnectTimeout-plus-2s cycle for the whole
  life of the watcher and reported only `ssh exited 255`. Both fan-outs now share
  one implementation with per-peer exponential backoff (2 s doubling to a 60 s
  cap, reset on a healthy protocol event), the peer's own stderr surfaced as the
  `unavailable` reason, and a peer parked after three consecutive failed spawns
  until the device registry changes or the capped delay elapses. Source:
  `cli/src/lib/session/remote/peer-stream.ts`.
