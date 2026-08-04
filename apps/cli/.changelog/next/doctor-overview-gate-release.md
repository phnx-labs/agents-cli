- **`doctor --json` releases its singleflight lock before it returns.** The overview gate
  fired the lock release without awaiting it on the path where a waiter serves the winner's
  fresh snapshot, so the call returned with the lockfile still on disk. The next caller then
  retried against a lock that was already logically free — the pile-up the gate exists to
  prevent, narrowed to the window between return and unlink. The release is now awaited.
  The existing coalescing test failed 5 times in 15 runs before this and 0 in 15 after.
  Source: `apps/cli/src/lib/devices/doctor-overview-cache.ts`.
