- **Webhook handlers gain `run.env` and `host` placement.** A handler can now
  inject environment variables into the process it spawns (`run.env`), and choose
  where that run executes (`host`). `host` takes a device name (`yosemite-s0`), or
  `fleet` to pick any eligible online worker, or `fleet/<platform>` /
  `<platform>/fleet` (also a bare `linux` / `macos` / `windows`) to restrict that
  pick to one platform. A fleet expression that matches no eligible device fails
  loudly rather than silently falling back to the local machine, so `fleet/linux`
  can never land on a macOS box. Omitting `host` runs locally, as before.
  Source: `apps/cli/src/lib/triggers/handlers.ts` (`resolveHandlerHost`),
  `apps/cli/src/lib/routines-placement.ts` (`pickFleetDevice` platform filter),
  `apps/cli/src/lib/routines.ts` (`JobConfig.env`), `apps/cli/src/lib/runner.ts`.
