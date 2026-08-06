- **OpenCode timeout-sample spool dir is Windows-safe (#1869).** The generated
  `agents-cli-hooks.ts` plugin used `PERF_SPOOL.slice(0, PERF_SPOOL.lastIndexOf("/"))`
  to mkdir the perf spool parent. On Windows `getPerfDir()` is backslash-separated,
  so `lastIndexOf("/")` returned -1 and the slice dropped one character — the
  sample write was fail-silent and never landed. The plugin now imports
  `node:path` and uses `path.dirname(PERF_SPOOL)`. Source: `apps/cli/src/lib/hooks.ts`.
