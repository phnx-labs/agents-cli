- **`agents cli install <binary-cli>` no longer hardcodes `/usr/local/bin` (#1103).**
  Binary-method installs downloaded (and extracted archives) straight into
  `/usr/local/bin`, which fails with `EACCES` on Apple Silicon Macs where that
  directory is root-owned and not user-writable. A new `resolveBinDir()` picks
  the install directory instead: honor `AGENTS_CLI_BIN_DIR` if set, else prefer
  `~/.local/bin` (created on demand — the same XDG user-bin dir shims already
  use), else fall back to `/usr/local/bin` with an actionable error pointing at
  `AGENTS_CLI_BIN_DIR` / `~/.local/bin` instead of a bare `EACCES`. Source:
  `apps/cli/src/lib/cli-resources.ts`, `apps/cli/src/lib/cli-resources.test.ts`.
