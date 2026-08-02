- **`agents funnel down` disables a public Funnel port from the same wrapper used
  to enable ingress.** Webhook ingress now has a complete local receiver runbook:
  keep GitHub/Linear signing keys in `agents secrets`, bind the receiver to
  `127.0.0.1`, expose it with `agents funnel up`, rotate one source secret at a
  time, and turn the public port off with `agents funnel down` before stopping or
  moving the receiver. Source: `apps/cli/src/commands/funnel.ts`,
  `apps/cli/src/lib/funnel.ts`, `apps/cli/docs/03-routines.md`.
