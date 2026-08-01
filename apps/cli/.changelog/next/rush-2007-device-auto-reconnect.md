- **`agents run --device`/`--host` now auto-reconnects when the network drops.** A
  remote interactive agent runs in a detached tmux session on the peer, so an SSH
  blink kills only the local client — the agent keeps running. Previously the local
  side exited with ssh's connection-layer code (255) and you had to notice, find the
  session id, and `agents sessions focus` by hand. Now, when a tmux-hosted run with a
  known session id drops (exit 255), the client re-attaches the live remote pane
  automatically over SSH — reusing the peer's own `agents sessions focus <id> --local
  --attach-only` (a live join, not a resumed copy) — with bounded exponential backoff
  (2s→30s, up to 6 attempts, and the budget refills after a genuinely live
  reconnection). A clean detach (Ctrl-b d, exit 0) or a real agent exit (any non-255
  code) is left alone; `--raw`/no-tmux runs, which don't survive a drop, are not
  retried. This covers Claude and resumed runs today; capturing a resumable id for
  other agents on the `--device` path is tracked in RUSH-2007. Source:
  `apps/cli/src/lib/hosts/reconnect.ts`, `apps/cli/src/commands/exec.ts`.
