- **Security: the remote browser-control consent gate no longer has a hole.**
  `agents browser remote-control off` (the default) was only enforced on the
  `browser start` command, but `navigate`, `click`, `screenshot`, `evaluate` and
  the other page verbs open a browser implicitly when the caller has no live
  task. A `browser navigate --device <box>` therefore opened a browser on a
  machine whose owner never opted in, while `browser start --device <box>` was
  correctly refused. The gate now sits in the daemon at the two points that can
  open a browser (`BrowserService.start` and the create branch of
  `resolveOrCreateTask`), so every implicit-create verb is covered. The consent
  marker rides the IPC request rather than the daemon's environment: a daemon
  auto-started by a fleet-remote CLI inherits `AGENTS_FLEET_REMOTE=1`
  permanently, and reading that would have refused every later local drive.
  Source: `src/lib/browser/service.ts`, `src/lib/browser/remote-control.ts`,
  `src/lib/browser/ipc.ts`, `src/lib/browser/types.ts`.
