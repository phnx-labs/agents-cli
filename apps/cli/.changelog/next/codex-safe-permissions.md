- **Codex launches now default to safe writable access instead of an offline
  read-only sandbox.** When no configured run default exists, omitting `--mode`
  selects a managed workspace profile with network access, on-request approvals,
  `~/.agents`, and regenerable build caches. Explicit `--mode plan` remains
  filesystem-read-only but now retains network access. The same policy covers
  `agents run`, fallback attempts, resumes, routines, direct `codex` shims,
  versioned aliases, and Windows shim passthrough; only explicit `skip` disables
  the sandbox and approvals.
