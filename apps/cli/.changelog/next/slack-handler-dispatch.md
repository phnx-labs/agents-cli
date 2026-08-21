- **Slack/webhook handlers that run an agent actually dispatch now.** A `run.agent` or
  `run.workflow` webhook handler was gated by the *routine* activation manifest
  (`~/.agents/devices/<machine>/agents.yaml`). A handler is not a routine, so its name
  could never be a member — on any box that had materialized that manifest, every
  delivery was recorded `skipped` with an empty allowlist (`can only run on: `) while the
  receiver logged it as `fired`, and `agents routines enable <handler>` refuses the name,
  so there was no way out. Verified live: a real HMAC-signed `/agents` slash command
  reached the public receiver, acked 200, and started no agent. The job now carries
  `dispatchedBy: 'webhook'`, the same escape RUSH-2681 gave monitors; a handler's
  `routine:` delegate still keeps its gate.
- **`{{slack.response_url}}` is now available to handler prompts.** It was parsed off the
  wire but never reached the `{{slack.*}}` namespace. Slack accepts a POST there for 30
  minutes with no token and no channel membership, so it is the only reply that works
  before the app has been invited to a channel — the shipped example handler now uses it.
  Source: `apps/cli/src/lib/triggers/handlers.ts`, `apps/cli/src/lib/scheduling/routines.ts`.
