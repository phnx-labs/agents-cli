- **Host and cloud runs are now mappable in `agents sessions` for every agent, not
  just Claude.** A `--host` dispatch forced a session id only for Claude (the sole
  agent that accepts `--session-id`); every other agent's remote run coined its own
  id that the launcher never learned, so the run was orphaned in `agents sessions`
  and couldn't be resumed by id. The remote run now prints its resolved session id
  as a one-line stdout sentinel (via a new internal `--emit-session-id` flag the
  dispatch forwards); the launcher parses it out of the followed log and stamps it
  on the host task, so `agents sessions`/resume-by-id work for Codex, Gemini, and
  the rest. Source: `apps/cli/src/lib/hosts/session-marker.ts`,
  `apps/cli/src/lib/hosts/session-index.ts`, `apps/cli/src/lib/hosts/run-target.ts`,
  `apps/cli/src/lib/exec.ts`.

- **`agents cloud run` reconciles into the session index at dispatch.** The cloud
  task store (`tasks.db`) and the session index were disjoint: a cloud run wrote only
  the store, and `agents sessions` learned of it only later, via a proxy discovery.
  Now every cloud dispatch (and every status poll) registers a session row keyed by
  the real execution id with a `[cloud/<status>]` label, so a launch is mappable to a
  session immediately. Source: `apps/cli/src/lib/cloud/session-index.ts`,
  `apps/cli/src/lib/cloud/store.ts`.

- **Codex Cloud dispatch no longer fabricates a task id.** When `codex cloud exec`
  didn't print a parseable id, the provider minted a synthetic `codex-<timestamp>` —
  an id that could never match the real execution, silently breaking status, list,
  and session reconcile. It now also scans stderr for the id and, on a genuine miss,
  fails loud pointing at `agents cloud list` rather than persisting a bogus id.
  Source: `apps/cli/src/lib/cloud/codex.ts`.
