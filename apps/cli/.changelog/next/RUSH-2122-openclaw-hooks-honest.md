- **OpenClaw's capability table no longer claims `hooks: true` with zero hooks
  ever installed (RUSH-2122).** `registerHooksToSettings` has no `openclaw`
  branch and silently returned `{ registered: [], errors: [] }` for it, so
  `agents sync openclaw` reported success while installing nothing, and
  `agents doctor` treated the agent as hooks-capable with no way to detect the
  gap. OpenClaw only exposes a fixed set of internal, named hooks (e.g.
  `boot-md`, which runs `BOOT.md` on gateway restart) — there is no general
  event->shell-command registration surface an agents-cli `hooks.yaml`
  manifest could target — so `capabilities.hooks` and `supportsHooks` now read
  `false`, matching what the CLI can actually do. A new completeness test
  (`hooks-capability-completeness.test.ts`) pins every `hooks: true` agent to a
  real branch in `registerHooksToSettings` so a capability flip can never ship
  again without a registrar behind it. Source: `apps/cli/src/lib/agents.ts`,
  `apps/cli/src/lib/hooks-capability-completeness.test.ts`.
