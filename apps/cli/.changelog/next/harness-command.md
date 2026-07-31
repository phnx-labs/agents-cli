- **`agents harness` — name a (host CLI + model) combo and run it like a native agent
  type.** `agents harness add spark --host opencode --model meta/muse-spark-1.1` writes
  `~/.agents/profiles/spark.yml`, and `agents run spark` then dispatches OpenCode pinned to
  that model; `--model` at run time still overrides it. A harness is a profile under the
  hood (same YAML, same run resolution, same `agents repo push user` device sync), so
  `agents profiles` is unchanged; `harness` adds the host+model one-shot (no preset
  required), owns its own `--host` (never remote-routed, unlike `profiles --host`), and
  `agents harness list` shows custom harnesses, addable presets, and the native harness
  registry in one view. The model lands on the host's model env var
  (`OPENCODE_MODEL`/`ANTHROPIC_MODEL`/`GROK_MODEL`/`GEMINI_MODEL`). Source:
  `apps/cli/src/commands/harness.ts`, `apps/cli/src/lib/profiles.ts`,
  `apps/cli/src/lib/hosts/passthrough.ts`.
- **Fixed the Spark presets, which never ran.** `claude-spark`, `opencode-spark`, and the
  `opencode` preset help all named `meta/claude-spark-1.1` — a model neither OpenRouter nor
  OpenCode serves; the live id is `meta/muse-spark-1.1`. Separately, an `authOptional`
  preset (opencode) still wrote a keychain `auth` block that `resolveProfileEnv` always
  read, so `agents run opencode-spark` died with "Keychain item not found" even though
  OpenCode uses its own login. `resolveProfileEnv` now skips optional auth when no token is
  stored, so those presets run on the host's own credentials. Source:
  `apps/cli/src/lib/profiles-presets.ts`, `apps/cli/src/lib/profiles.ts`.
