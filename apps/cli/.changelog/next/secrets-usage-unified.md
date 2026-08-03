- **`agents secrets` now tracks per-bundle usage and surfaces it.** Every secret
  lifecycle/access event — create, import, export, view, access (a value read for
  injection), unlock — funnels through the one `emitSecretAudit` chokepoint, which
  writes to BOTH the append-only `~/.agents/events.jsonl` audit log AND a derived,
  value-free read-model at `~/.agents/secrets/secrets.db` (never a secret value —
  bundle name, event kind, key count, resolving agent/host, status only).
  `agents secrets view <bundle>` now shows whether the bundle is currently
  **unlocked** (held by the secrets-agent, so reads are prompt-free), a **usage**
  summary ("accessed 42× (last 2h ago) · exported 3× (last 1d ago)"), and
  **per-agent** attribution, and nudges when a bundle has no description (also at
  `create` time). `agents secrets list` gains **`--sort uses`** (most frequently
  accessed) alongside the existing `--sort used`, and the `--json` payloads carry
  `uses`, `usage`, and `heldExpiresAt`. A new **`agents secrets activity [bundle]`**
  prints the recent value-free event timeline (bounded to 90 days). Naming guidance
  is taught in the help and skill: name a website bundle after its domain
  (`stripe.com`, `openai.ai`), a desktop-app bundle after its binary suffix
  (`slack.app`, `photoshop.exe`). Recording is best-effort and
  `AGENTS_NO_USAGE_TRACK=1` disables it. Source:
  `apps/cli/src/lib/secrets/usage-db.ts`, `apps/cli/src/lib/secrets/audit.ts`,
  `apps/cli/src/commands/secrets.ts`, `apps/cli/src/lib/secrets/list-filter.ts`.
