- **An offloaded editor tab no longer displays another session's id.** A Factory
  tab launched with `agents run --host <device>` has no local agent process, but
  the extension still resolved its "live" session id by reading the SessionStart
  hook's `~/.agents/.cache/state/sessions/<pid>.json` for the local pid tree —
  the pid of the ssh client. Those files are keyed by pid alone and are only
  pruned when the pid is dead, so once the OS recycled a pid the tab adopted
  whatever session had last held it: one remote tab showed the id and version of
  an unrelated synthetic run from 20 days earlier while `/status` inside it
  reported the truth. An offloaded tab now takes its identity from the device
  instead of local disk, and a local tab rejects any state record whose
  SessionStart timestamp predates the tab itself.
- **`AGENT_TERMINAL_ID` now rides the SSH hop.** `agents run --host` forwarded
  actor provenance but not the launching tab's terminal id, so the remote pid
  registry recorded no terminal — leaving `agents sessions --active --host
  <device>` unable to answer "which session is this tab running?" once the agent
  moved on (a `/clear`, or an exit and rerun in the same tab).
- **`agents sessions --active --json` now carries `terminalId`.** The pid registry
  has always recorded it; the emitted row dropped it, so no consumer could join a
  live session back to the editor tab that launched it.
