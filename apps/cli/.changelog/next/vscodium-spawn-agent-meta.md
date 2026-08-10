- **VSCodium agent tabs get the right chip on focus/resume (#2478).** The
  `vscodium-agent` spawn URI now carries `agent` / `sessionId` / `title` from
  `sessions focus` and `sessions resume`, so remote `ssh … tmux attach` tabs open
  with the harness icon and status bar instead of a generic shell. The terminal
  engine's `SurfaceItem` / `LaunchRequest` plumb the optional identity through;
  other backends ignore it.
