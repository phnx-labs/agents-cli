- **`agents output` and the session index no longer under-count Windows hosts
  (RUSH-2286).** A Windows box could report zero token burn / zero sessions even
  when it was actively used, because two per-harness scanners in
  `session/discover.ts` failed on Windows: the OpenClaw scan gated on `which
  openclaw`, which is POSIX-only (`which` throws ENOENT on Windows, so the whole
  OpenClaw scan silently returned before indexing anything), and the Grok scanner
  recovered a session's version from `summary.grok_home` with a `/`-only regex
  that never matched a backslash-separated Windows path. The OpenClaw presence
  check now uses the cross-platform `hasCommand`, its `openclaw` invocations route
  through `execFileShellSpec` so a Windows `.cmd`/`.ps1` shim actually launches,
  and the Grok version regex normalizes separators first. Separately, JSON relayed
  from a Windows peer over SSH (`agents output --host <win> --json`,
  `agents sessions … --json`) is now stripped of any PowerShell `#< CLIXML`
  banner before parsing (`stripClixml` in `hosts/remote-cmd.ts`), so a fleet-wide
  rollup that folds in a Windows box no longer drops it on a `JSON.parse` failure.
  The banner strip is applied at every remote-`--json` boundary a Windows peer's
  output flows through: the `remote-agents-json` fan-out, the session
  `remote-list` list/payload/tool-search parsers, the `--host` fleet passthrough
  (`agents view --host all`), and `agents output`'s per-device fetch.
  Source: `apps/cli/src/lib/session/discover.ts`,
  `apps/cli/src/lib/hosts/remote-cmd.ts`, `apps/cli/src/lib/hosts/passthrough.ts`,
  `apps/cli/src/lib/remote-agents-json.ts`,
  `apps/cli/src/lib/session/remote-list.ts`, `apps/cli/src/commands/output.ts`.
