- **No more CLIXML blobs from Windows hosts.** A remote `agents …` invocation
  routed to a Windows box (`--host win-mini`, `agents doctor --devices`,
  `agents fleet status`) no longer comes back wrapped in a raw `#< CLIXML <Objs …>`
  envelope. PowerShell 5.1 serializes its progress stream ("Preparing modules for
  first use.") to CLIXML when stderr is a captured pipe rather than a console; the
  Windows command builder now silences that stream (`$ProgressPreference =
  'SilentlyContinue'`) so failures read as plain text for humans and the JSON
  parsers that consume the output. Source: `apps/cli/src/lib/hosts/remote-cmd.ts`.
