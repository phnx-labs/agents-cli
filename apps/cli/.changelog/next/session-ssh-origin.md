- **`agents sessions --active` attributes the initiating device for SSH-launched
  sessions.** A session started by ssh'ing into a box (common for tmux-hosted
  runs) used to render as `local` with no origin, because the tmux discovery path
  stamped a `transport:'local'` placeholder that made provenance enrichment skip
  it. Enrichment now probes the pane process's env and upgrades the row to `ssh`
  with the real origin, then resolves the SSH client IP against the device
  registry into `provenance.origin` (`{ device, user? }`). Both the flat listing
  and the interactive browser read `ssh←<device>` (e.g. `ssh←zion`); an
  unregistered IP stays bare `ssh`. Answers "which box launched this session"
  without scraping `ps`/`who`/`tailscale`. Source:
  `apps/cli/src/lib/session/active.ts`, `apps/cli/src/lib/session/provenance.ts`,
  `apps/cli/src/commands/sessions.ts`, `apps/cli/src/commands/sessions-browser.ts`.
