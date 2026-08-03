- **A custom harness is now its own agent type in `agents view`.** A harness created
  with `agents harness add` (or `agents profiles add`) used to render as an indented
  `profile` row under whichever host CLI executes it. It now gets its own block beside
  Claude and Codex — a bold name header, then one row carrying the pinned model, the
  account/auth state, and `via <host> <version>` naming the native harness underneath.
  That matches how it is already launched: `agents run <name>` treats a custom harness
  exactly like a native agent id. A harness whose host CLI has no install is flagged
  `(host <id> not installed)` rather than listed as runnable, and the separate
  "Profile-only Agents" section is gone — those harnesses now render in the main list
  like every other one. Source: `apps/cli/src/commands/view.ts`.
- **`agents view <harness>` describes a custom harness** — host, model, provider, auth,
  fork lineage, YAML path — instead of failing with "unknown agent";
  `agents view <harness> --json` emits its summary. Source:
  `apps/cli/src/commands/harness.ts` (`renderHarnessDetail`).
- **New `agents harness fork <source> <name>`.** One verb over both starting points:
  fork a native harness (`agents harness fork opencode deepseek --model
  deepseek/deepseek-v4-flash-0731 --auth-provider openrouter`) or copy a custom one you
  already tuned and change only what you name (`agents harness fork deepseek
  deepseek-chat --model deepseek/deepseek-chat-v3`). Forking a custom harness is a full
  copy — env, endpoint, auth binding, `fallback_model`, host version pin — so the two
  diverge and deleting the source never affects the fork; forking a native harness
  requires `--model` because there is no model to inherit. Flags: `--model`,
  `--base-url`, `--auth-provider`, `--version`, `--label`, `--description`,
  `--key-stdin`, `--force`. Source: `apps/cli/src/lib/profiles.ts` (`forkProfile`).
- **Profile YAML gains optional `label:` and `forkedFrom:`.** `label` sets the name
  `agents view` prints for the harness (defaults to the file name); `forkedFrom` records
  the parent as display-only lineage. Existing profiles keep working untouched. Source:
  `apps/cli/src/lib/profiles.ts`.
- **Breaking (`--json`):** in `agents view <agent> --json`, the per-agent `profiles` key
  is now `harnesses`, and each entry carries new `label`, `hostVersion`, `description`,
  and `forkedFrom` fields alongside the existing ones. Source:
  `apps/cli/src/commands/view.ts` (`ViewJsonAgent`).
