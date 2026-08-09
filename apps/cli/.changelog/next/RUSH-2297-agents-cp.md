- **`agents cp <src> <dst>` — first-class fleet file transfer (RUSH-2297).** New
  top-level command that copies files and directories between fleet hosts
  (local-to-remote, remote-to-local, and remote-to-remote) using the same
  SSH/device fabric as `agents ssh`. Either endpoint is `host:path` (remote) or
  an absolute local path. Remote `~` and literal `$HOME` in a path are resolved
  **on the remote host** before transfer — never in the caller's shell —
  preventing the silent-failure class where a shell variable expands to the
  local user's home directory instead of the remote one. Unknown devices fail
  loudly with a human-readable error before any SSH connection is attempted.
  Recursive directory copies use `-r`; two-remote transfers route through the
  local machine (`-3`) so no direct SSH trust between fleet boxes is required.
  Source: `apps/cli/src/commands/cp.ts`.
