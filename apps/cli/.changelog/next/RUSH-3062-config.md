- **New device config key `description` — a one-line, fleet-synced answer to
  "what is this box FOR".** `agents devices config <name> description "gpu box
  — cuda 12.4"` stores a single-line summary in the device's tracked
  `~/.agents/devices/<name>/agents.yaml` under `config.description`, so it
  syncs to every machine via `agents repo push/pull` exactly as `role` does,
  and any box may set it for any device (`shared` visibility). Because it
  will be shown by the device-list renderer it is validated: a newline is rejected outright and
  the value is capped at 80 characters — over-long input fails with a readable
  error naming the cap, never a silent truncation. `notes` is unchanged: it
  stays the appended list of long-form operator scratch, and both key
  descriptions now state the distinction. Source:
  `apps/cli/src/lib/device-config.ts`.
