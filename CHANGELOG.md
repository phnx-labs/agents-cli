# Changelog

## Unreleased

**`agents secrets unlock`: a secrets-agent that ends Touch ID prompt spam (macOS)**

- macOS pops a Touch ID prompt **per bundle, per process** — the biometry assertion is process-local and macOS refuses to cache `kSecAccessControl`+biometry items, so running several agents at once (`agents teams`, parallel `agents run --secrets`) re-prompts once per process. New `agents secrets unlock <bundle>` reads the bundle once (one prompt) and holds the resolved env in a local broker; every later resolution — `agents run`, teammates, browser profiles, the routines daemon — is served from memory over a user-only Unix socket (`~/.agents/.cache/helpers/secrets-agent/`, `0700`) with no prompt. `agents secrets lock` wipes it; `agents secrets status` shows what's held and when it locks. The hold also ends on TTL expiry (default 24h, `--ttl`) and on screen-lock / sleep.
- **Opt-in by construction:** if you never `unlock`, resolution is byte-for-byte the existing keychain path — guarded behind a single `agentSocketExists()` stat. The single integration point is `readAndResolveBundleEnv`, so every consumer benefits without per-call-site changes. Broker-served reads are tagged `"source":"agent"` in the audit log.
- **Security trade-off (documented in `docs/secrets.md`):** while unlocked, a same-user process that can reach the socket reads the bundle silently — the same trust boundary the keychain already concedes (the ACL is user-presence, not code-identity), minus the visible prompt. Bounded by explicit per-bundle opt-in, TTL, screen-lock/sleep auto-lock, and `lock`.
- Snapshot semantics: `unlock` freezes a bundle's dynamic `exec:`/`env:`/`file:` refs at unlock time; keychain and literal values are unaffected.
- **Release note:** auto-lock on screen-lock/sleep adds a `watch-lock` subcommand to `keychain-helper.swift`. The signed helper must be rebuilt + re-notarized and its sha re-pinned (`scripts/build-keychain-helper.sh`, `scripts/Agents CLI.app.sha256`) for that path to ship; until then the agent degrades gracefully to TTL-only locking. Source: `src/lib/secrets/agent.ts`.

**Per-bundle tiers + opt-in auto-cache for the secrets-agent**

- Bundles now carry a tier (`agents secrets tier <bundle> [biometry|session]`, or `--tier` on `create`). `biometry` (default) is today's behavior — only an explicit `unlock` puts it in the agent. `session` makes a bundle agent-eligible.
- New `secrets.agent.auto: true` in `agents.yaml` (default off): the first real keychain read of a **`session`**-tier bundle auto-loads it into the broker in the background (no added latency, secret passed over stdin not argv), so the next concurrent run reads it silently — no manual `unlock`. A `biometry`-tier bundle is never auto-held.
- A `none` tier (items without the biometry ACL, fully silent, no agent) is intentionally **not** offered yet — it needs a separate signed-helper change and is the global downgrade the agent exists to avoid.
- Default secrets-agent TTL is 24h.

**Headless Linux: `agents secrets` works out of the box when the keyring is locked**

- On a headless server the libsecret/GNOME-keyring collection is locked, so the encrypted-file fallback is the only option — but it previously hard-failed unless `AGENTS_SECRETS_PASSPHRASE` was set, leaving `agents secrets` silently unusable. Now, on a headless run with no passphrase set, a random machine-local passphrase is auto-provisioned once at `~/.agents/.cache/secrets/.passphrase` (mode 0600) so the encrypted-file store just works. `AGENTS_SECRETS_PASSPHRASE` still takes precedence (off-disk key), an existing `.passphrase` is reused for stable interactive/headless behavior, and interactive TTY sessions are still prompted. Security model + resolution order documented in `docs/secrets.md`. (#371)

**`agents secrets get/set <item>`: raw, cross-platform keychain access for hooks**

- New `agents secrets get <item>` / `agents secrets set <item>` read and write a single keychain item **by bare name** (outside the bundle namespace), so shell hooks and automation have one platform-agnostic credential primitive to call instead of hardcoding `/usr/bin/security` (macOS-only) or `secret-tool` (Linux-only). `get` prints the value to stdout (newline-terminated for clean `$(…)` capture), sends diagnostics to stderr, and exits 1 with empty stdout when the item is missing — exactly what a `SessionStart` hook needs to probe-and-fallback quietly. Routing goes through the existing cross-platform keychain layer: macOS via `/usr/bin/security`, Linux via `secret-tool` with the encrypted-file fallback.
- `setKeychainToken` now writes bare (non-`agents-cli.`) items on macOS **without** the biometry ACL, mirroring the existing no-prompt read path for such items. This is what lets a hook read e.g. `linear-api-key` silently on every launch — routing it through the Touch ID helper would attach an ACL the `/usr/bin/security` read can't satisfy without popping the legacy password sheet. The change is purely additive: every existing caller passes an `agents-cli.`-namespaced item and is unaffected (still biometry-gated via the signed helper).

**`agents inspect` summary: expanded detail for hooks, plugins, and MCP**

- The bare `agents inspect <agent>` / `agents inspect <repo>` summary no longer collapses everything to a count table. Simple kinds (commands, skills, rules, subagents, workflows) keep a count line but now preview a few names; the rich kinds get their own expanded sections: **hooks** show their events + `matches:` predicates + cache (`PreToolUse(Bash) · git_dirty · prompt~"deploy" (5m cache)`), **plugins** show version + bundle contents (`v2.1.0  skills:6 commands:5 hooks:2 mcp:1`), and **MCP** show transport + url/command. Drill-down flags (`--hooks`, `--plugins`, `--mcp`) and `--brief` are unchanged; `--json` gains the structured detail additively (existing keys retained).
- Hook detail joins installed hooks to the manifest by **script basename** (installed hooks are named after their script file while the manifest keys on the logical name), and the repo Hooks section uses the grouped hook reader so a script + its data file collapse to one clean entry.

**Plugin hooks were misreported — fixed**

- `discoverPluginHooks` read the **top-level** keys of a plugin's `hooks/hooks.json`, so the official `{ description, hooks: { SessionStart: [...] } }` format surfaced as `description, hooks` instead of the real events. It now reads the `hooks` wrapper when present (falling back to top-level keys for the flat format), so `agents inspect --plugin <name>` and the plugin row show the actual lifecycle events (e.g. `SessionStart, PreToolUse, …`).

**`agents doctor` / `agents prune`: precise orphan-hooks detection**

- Orphan-hook detection now flags hook scripts present in a version home that **no `agents.yaml`/`hooks.yaml` entry registers** — i.e. scripts that sync to disk but are never wired to a lifecycle event, so they never fire. This replaces the source-diff heuristic, which compared only against the user hooks dir and so **false-flagged valid system-sourced, registered hooks** (e.g. `03-linear-inject`, `04-capture`) as orphans — meaning `agents prune cleanup` could have deleted live hooks. Doctor's Orphans section and `prune cleanup hooks` now share this single manifest-based definition. `parseHookManifest` gained a silent (`{ warn: false }`) option so the diagnostic doesn't emit shadow/override warnings.

**Regression coverage: resource sync from extras repos**

- Added end-to-end regression tests (`src/lib/__tests__/extras-sync.test.ts`) locking in two behaviors for repos registered via `agents repo add` (`~/.agents-<alias>/`): a top-level `commands/<name>.md` is written into the agent's version home on `agents sync`, and plugins under `plugins/<name>/` are synthesized into a registered `agents-<alias>` marketplace on launch. Both already work in `main`; the tests exercise the real sync path (no mocking, isolated `$HOME`) so the extras-repo behavior can't silently regress (#313, #314).

**Windows: `agents` is discoverable right after `npm i -g`**

- On a global Windows install, postinstall now prepends npm's global-bin dir (where `agents.cmd`/`agents.ps1` live) to the **User PATH** via the .NET environment API. Node's installer normally adds it, but winget / portable / nvm-windows setups often don't — and then `npm i -g @phnx-labs/agents-cli` succeeds yet `agents` is "not recognized". The shims dir (claude/codex/…) is still left to `agents setup`, which the user can now run because `agents` resolves.
- Postinstall also detects a `Restricted`/`AllSigned` PowerShell execution policy (which blocks the generated `.ps1` launchers, so even an on-PATH `agents` fails in PowerShell) and prints the one-line fix (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`). The policy is a security setting, so it is never changed silently — only surfaced.
- Refactor: the Windows User-PATH prepend logic moved from `shims.ts` into a new `src/lib/platform/winpath.ts` leaf module (`prependToWindowsUserPath`, `getEffectiveExecutionPolicy`, `blocksLocalScripts`, `npmGlobalBinFromEntry`); `addShimsToWindowsUserPath` now delegates to it. Pure helpers are unit-tested.

**Factory AI Droid (first-class support)**

- Add `droid` as a first-class supported agent (AgentId + full registry entry for Factory AI's `droid` CLI, config in `~/.factory/`). Installs via the official script (`curl -fsSL https://app.factory.ai/cli | sh`); the binary is resolved through the standard install-script path and isolated per version via the `~/.factory` config symlink (Droid has no `*_HOME` override).
- Resource sync wired for the four resource types Droid supports natively: **MCP** (`~/.factory/mcp.json`), **rules** (native `AGENTS.md`), **subagents** (custom droids flattened to `~/.factory/droids/*.md`, with the unsupported `color` frontmatter key stripped), and **commands** (`~/.factory/commands/`). Skills/plugins/workflows have no Droid equivalent and are disabled; hooks/permissions are deferred.
- `agents run droid` and `agents teams add … droid` work end-to-end: headless `droid exec` with mode mapping (plan → read-only, edit → `--auto low`, auto → `--auto high`, skip → `--skip-permissions-unsafe`), `-o stream-json` output, `-m` model selection, and `-r` reasoning effort. Routine/daemon jobs (`buildJobCommand`) support Droid too.
- Known limitation: `agents teams` renders Droid events through the generic normalizer pending a verified `droid exec -o stream-json` event schema; structured tool/file categorization will follow. Session reading and Factory cloud dispatch remain follow-ups.

**`agents upgrade` now refreshes the macOS Keychain helper**

- Upgrading runs `npm install -g … --ignore-scripts`, so the postinstall that installs the signed Keychain helper never fired — a user upgrading away from a broken build (e.g. the entitlement-less 1.20.4 helper that failed `SecItemAdd` with `errSecMissingEntitlement -34018`) kept the broken helper until the lazy staleness check in `getKeychainHelperPath()` happened to repair it on their next secret operation. `installResolvedPackage` now force-refreshes the helper (`ensureKeychainHelperInstalled({ forceReinstall: true })`) on darwin after the install, so both the explicit `agents upgrade` and the auto-update prompt land the fixed helper immediately. Best-effort and non-fatal: an upgrade never fails because the helper could not be reinstalled, and `agents helper install --force` remains the manual path.

**`agents inspect <repo>` summary now shows what's actually inside, not just counts**

- The bare repo summary gained four enrichments so it reads as an inventory instead of a tally: (1) **resource name previews** — each kind lists its first few names with a `…(+N)` tail; (2) **manifest summary** — `agents.yaml` is parsed for its `run.<agent>.strategy` and any `agents.<agent>` version pins, shown under `manifests` instead of just the filename; (3) **git detail** — last commit (sha, subject, relative time), ahead/behind upstream when non-zero, and the names of dirty files; (4) **size + file counts** — total repo size and a per-kind byte size. `--json` carries all of it (`git.lastCommit`, `git.ahead/behind`, `manifest`, `size`, and per-kind `{count, bytes, files, names}`); `--brief` still skips resources and size.
- Fixed a path-parse bug surfaced by the dirty-files list: the shared git helper trimmed leading whitespace, which clipped the first character off the first `git status --porcelain` path; status is now read untrimmed.

**`agents inspect .` reads the project `.agents/`, and plugin drill-down shows bundled skills**

- `agents inspect .` (and any path to a repo root) now resolves to the project's nested `.agents/` tree when that tree is a populated DotAgents root, instead of the project root itself. Previously a top-level `agents.yaml` version-pin or an unrelated source `skills/` dir at the repo root was mistaken for a DotAgents root, so `inspect .` reported the wrong directory's resources (e.g. `plugins 0` while the real `.agents/plugins/` held a plugin). A bare `.agents`-named dir still resolves to itself, and standalone clones / extra repos that keep resources at the top level (using `.agents/` only for worktrees) are unaffected — their nested `.agents/` is not a DotAgents root, so the top level still wins.
- `agents inspect <repo> --plugins` now reads plugin bundles through the plugin discoverer: the list shows each plugin's manifest description, and drilling into one (`--plugins <name>`) reports its bundled skills, commands, subagents, hooks, MCP servers, and version. Previously plugins were treated as opaque directories with no description and no view into what they ship.

**Single-typo agent names auto-correct everywhere, not just `agents run`**

- `agents view cladue` used to print `Unknown agent 'cladue'` even though `agents run cladue` auto-corrected. `resolveAgentName` — the canonical resolver behind `view`, `usage`, `inspect`, `doctor`, `sync`, `models`, `skills`, `hooks`, `import`, `sessions --agent`, and every `agent@version` spec (`agents add claud@latest`, `agents use codx@2.1.170`) — now falls back to Damerau-Levenshtein distance-1 matching against canonical ids and multi-letter aliases: `cladue` -> `claude` (transposition), `kim` -> `kimi`, `codx` -> `codex`, `gemni` -> `gemini`.
- Corrections apply only when unambiguous: every distance-1 candidate must agree on one agent. `kiri` (one edit from both `kiro` and `kimi`) and inputs under 3 characters still error. `agents run` keeps its existing exact -> profile -> workflow -> fuzzy precedence, so a profile named `claud` still beats the typo correction.
- Fixes `kimi` being listed as a valid agent but missing from the alias map — `agents view kimi` previously errored. Added `kimi` / `kimi-code` entries.

## 1.20.7

**`agents inspect` — DotAgents repo targets (#256)**

- `agents inspect` now accepts a DotAgents repo as the target, not just an installed agent: `user` (~/.agents/), `system` (~/.agents/.system/), `project` (nearest `.agents/` from cwd), any extra-repo alias registered via `agents repo add`, or a filesystem path. Paths accept either a repo containing a `.agents/` dir or a DotAgents root directly.
- Repo summary shows the root (OSC-8 linked), git branch / dirty count / origin URL, manifest files (`agents.yaml`, `hooks.yaml`), and per-kind resource counts. All existing drill-down flags (`--commands`, `--skills`, `--plugins`, ... with fuzzy queries and `--json`) work against the single repo root — what is physically in that repo, with no layered resolution or same-name overrides.
- Resolution precedence: a directory that is itself a DotAgents root wins over its nested `.agents/`, so extra repos that keep resources at the top level and use `.agents/` only for worktrees resolve to their real resources.
- Unknown targets now error with both halves of the namespace: the known agent ids and the available repo targets (built-in layers plus registered aliases).

**`scripts/install.sh` — bash 3.2 fix (#256)**

- `set -u` plus `"${BUILD_ARGS[@]}"` on an empty array aborted the dev install with `BUILD_ARGS[@]: unbound variable` under macOS system bash; the expansion is now guarded with `${BUILD_ARGS[@]+...}`.

## 1.20.5

**`agents inspect` — per-agent+version detail view with drill-down (#217)**

- New top-level command `agents inspect <agent>[@version]`. Summary mode shows install path, config symlink target, shim path, versioned alias, run strategy, capability table (`hooks`/`mcp`/`skills`/`commands`/`subagents`/`plugins`/`workflows`/`rules`/`allowlist`), resource counts with project/user/system scope breakdown, and session total. Replaces the awkward `agents view <agent>@<version>` deep-detail mode as a dedicated verb; `view` itself is unchanged.
- Drill-down flags for every resource kind — `--commands`, `--skills`, `--hooks`, `--mcp`, `--rules`, `--plugins`, `--workflows`, `--subagents`. Bare flag lists every entry; passing a positional query fuzzy-searches that kind, ranking exact > substring > Damerau-Levenshtein. Zero matches exit 1 with the three closest names as suggestions. One drill-down at a time (validation error otherwise). `--json` works with summary and every drill-down for scriptable consumption.
- Resource names render as OSC-8 terminal hyperlinks to the marker file (`SKILL.md` / `WORKFLOW.md` / `AGENT.md`) for clickable navigation in modern terminals (Ghostty, iTerm2, WezTerm) — no inline path noise. Plain text on terminals without OSC-8 support.
- MCP detail intentionally suppresses path and env values to avoid leaking secrets — only the server name, scope, and version reach the output.
- Removes the deprecated `agents status` alias for `view @default`. Top-level help text updated; no consumers referenced it.

**Headless Linux: encrypted-file fallback when libsecret collection is locked (#183)**

- On server-class Linux (Ubuntu 24.04 over SSH on the reporter's box), `agents secrets create x` failed with `secret-tool: Cannot create an item in a locked collection`. Diagnosis in the issue: `gnome-keyring-daemon` is running and D-Bus is reachable, but the default `login` collection is locked because no graphical login has fed the daemon the passphrase, and `secret-tool` from `libsecret-tools` has no `--collection` flag so it can't target the unlocked `session` collection. This made `agents secrets` effectively macOS-only on any headless box.
- `src/lib/secrets/linux.ts` now transparently falls back to a file-based AES-256-GCM encrypted store at `~/.agents/.cache/secrets/<item>.enc` (mode 0600, per-file random scrypt salt + 96-bit IV, GCM auth tag). The encryption key is scrypt-derived from a passphrase read from `AGENTS_SECRETS_PASSPHRASE` (preferred) or a TTY prompt via `/dev/tty` with `stty -echo` for non-echoing input. The fallback also activates when `libsecret-tools` is not installed at all but `AGENTS_SECRETS_PASSPHRASE` is set, so a fresh install can store secrets without any apt-get step.
- The decision is cached per process; on first activation we emit one stderr line: `[agents] secret-service collection locked, using file-based store at <dir>`. The `KeychainBackend` interface in `src/lib/secrets/index.ts` is unchanged — `has`/`get`/`set`/`delete`/`list` work identically against either backend, so `bundles.ts`, `sync.ts`, and every consumer above it sees no API change.
- Items written into the file store before the fallback was added remain accessible only via libsecret if/when the collection is later unlocked; this PR does not migrate stranded items in either direction — the user simply re-creates them on a freshly headless box.

## 1.20.4

**Plugin marketplace sync (skip outside-pointing symlinks)**

- `copyPluginToMarketplace` used `fs.cpSync(plugin.root, dest, { recursive: true, dereference: false })`, which faithfully preserved every symlink — including the ones plugin authors put at the top of their plugin source for prompt-side references (the rush plugin's `app -> ../../../rush/app`, `web -> rush/web`, `widgets -> rush/widgets`). Those targets resolve to the rush monorepo (~8.7 GB of `app/` including node_modules + .next builds, 782 MB of `web/`, plus 463 MB brand-assets). Every claude version got a full set of those symlinks in `~/.claude/plugins/marketplaces/agents-cli/plugins/rush/`. When the consumer (Claude Code, OpenClaw) discovers plugins, it walks the marketplace tree and follows those symlinks — producing multi-minute startup hangs.
- The copy now walks the source tree and drops symlinks whose `realpath` escapes the plugin root, leaving internal symlinks intact (cpSync rewrites internal targets to absolute paths into the source tree, which the consumer still resolves correctly). One informational line per plugin lists the skipped names so plugin authors notice.
- Existing per-version marketplace directories still hold the bloat from prior syncs; clean up with `rm` against `~/.claude/plugins/marketplaces/agents-cli/plugins/*/{app,web,widgets,*-symlinks-that-escaped}` then re-run `agents pull` or any plugin sync to re-copy with the filter.

## 1.20.3

**`agents run` startup latency (stale-while-revalidate the usage probe + memoize agents.yaml)**

- The default `agents run` strategy is `available`, which calls `getUsageInfoForIdentity` to skip rate-limited accounts. With a 2-minute cache, every cold invocation past that window made a blocking `fetch` to `api.anthropic.com/api/oauth/usage` (5 s timeout, plus an optional 15 s OAuth token refresh) before `spawn(claude)` — so `agents run claude` regularly stalled 5–8 s with nothing on screen after the rotation banner.
- The cache is now stale-while-revalidate: fresh (<2 min) returns instantly with no network, stale-but-recent (<24 h) returns the cached snapshot instantly and refreshes in the background, and only a fully cold / >24 h cache blocks on the live fetch. The background refresh defers its first await past `setImmediate` so the synchronous Keychain CLI call (`security find-generic-password`, invoked by `loadClaudeOauth`) cannot block the foreground caller — that's how an SWR returns "instantly" even while the refresh is technically still on its first sync step.
- `readMeta()` had a `metaCache` module global plus `writeMetaUnlocked` cache-invalidation logic wired in years ago — but no read path ever consulted the cache. So every call did 2x `fs.readFileSync` + 2x `yaml.parse` on system + user `agents.yaml`, and hot callers (`getConfiguredRunStrategy`, `getGlobalDefault`, `getVersionResources`, `ensureVersionResourcePatterns`) fire it multiple times per `agents run`. The read path now consults the cache, keyed on the combined mtime of both source files — out-of-band edits still invalidate on the next stat, and in-process writers already clear it.

## 1.20.2

**Grok and Antigravity Support & Documentation**

- **Grok CLI Integration**: Added support for installing Grok via `agents add grok@<version>`, which invokes the official xAI installer with the specified version. Grok MCP server configuration paths (via `config.toml`) and memory file mapping are now correctly documented.
- **Antigravity (AGY) CLI Integration**: Added support for the Google Antigravity CLI. Since the AGY installer doesn't support version-pinned installs currently, `agents add agy` uses the `latest` version. Documented the canonical config path `~/.gemini/antigravity-cli/` and its `mcp_config.json`.
- **Documentation**: Updated `02-resource-sync.md` to reflect accurate MCP mappings and memory file symlinks for both Grok and Antigravity.
- **Profiles**: Hardened presets with verified 2026 model IDs and added generic proxy configuration. Show custom profiles in agents view.

## 1.20.1

**Agents selector (auto-install missing versions + unified `@all` everywhere)**

- `--agents claude@2.1.999` used to hard-error when 2.1.999 wasn't installed. Now the CLI prompts to install it inline and continues (auto-install with `--yes`). No more breaking flow to run `agents add` first.
- `--agents claude@all` and the bare `all` literal now work across every callsite that takes `--agents` — previously `agents install gh:...`, `mcp register`, `mcp remove`, and inline `mcp add` had diverged from the canonical syntax and threw "Version all is not installed" despite the help text advertising it. Selector is unified end-to-end.

**Prompt (fail loud on non-TTY + `@all` syntax in picker)**

- Scripts that called `agents <resource> add` with no `--agents` and no `--yes` used to silently auto-pick a default version. That hid scripted misuse behind unpredictable picks. The non-TTY path now throws with a clear pointer at the new syntax: `--agents claude@all` (every installed version of Claude), `--agents all` (every capable agent at all versions), or `--agents claude@2.1.141` (one specific version).
- `--agents` parsing in `<resource> add` understands `@all` and the bare `all` literal; `promptAgentVersionSelection`'s picker surfaces version counts when there's more than one installed, mirroring what `@all` would target.

**Resources / install (`gh:` form sniffs every type, `mcp add gh:`, `--names` + `@all` unified across resource add)**

- `agents install gh:<owner>/<repo>` now sniffs every resource type in the source repo (commands, skills, hooks, MCP, permissions, profiles, subagents, workflows) instead of requiring one `--types` per kind. Pass `--types skills,workflows` to narrow.
- New `agents mcp add gh:<owner>/<repo>` form — install MCP servers directly from a git source, parallel to the other `<resource> add gh:` paths.
- `<resource> add` accepts `--names` and `@all` uniformly across commands, skills, hooks, MCP, permissions, profiles, rules, subagents, workflows — same flags, same semantics, regardless of resource kind.

**Profiles (interactive `create` wizard, gateway + self-hosted presets)**

- New `agents profiles create` command — interactive wizard to assemble a profile from gateway or self-hosted presets (OpenRouter, OpenAI-compatible) without hand-writing YAML.
- `--smoke-test` exercises the resolved env block against the configured endpoint before writing the profile.

**Feedback (in-CLI bug / idea / question routing)**

- New `agents feedback` command — collects a short description + optional category (bug, idea, question) and routes to the project's tracker without leaving the terminal.

**Routines (real exit codes for detached scheduled runs)**

- `monitorRunningJobs` used to hardcode `status: 'failed'` whenever it detected that a detached child had exited — `executeJobDetached` fires-and-forgets, so the real exit code was unreachable. Every scheduler-driven routine ended up labeled `failed/exitCode: null`, even when the agent completed cleanly.
- Fix: when finalizing a vanished child, scan the tail of its stream-json `stdout.log` for Claude's `type: result` terminator (which carries `is_error`). If found, set `status` and `exitCode` from it. Only fall back to `failed` when no result marker exists (process was killed mid-run).
- Routines list cell rendering hardened around 7-day retention boundaries.
- Codex/Gemini run finalization continues to fall back to `failed` until their stream tail parsers are added.

**Security**

- `security(cli)`: eliminated `shell: true` from manifest-driven installs — closes a command-injection vector in `install`/`add` paths that took git URLs or shell-interpolated metadata.
- `security(logs)`: prompts and tokens are redacted before `events.jsonl` is written, and event retention is shortened from 30d to 7d. Reduces blast radius on accidental disclosure.
- `security(exec)`: strip loader env vars (`DYLD_*`, `LD_*`, `NODE_OPTIONS`) from environments propagated to child agents — avoids passing host-process loader state into spawned binaries.
- `security(browser)`: CDP origin allowlist replaces the previous wildcard — only `localhost` and explicitly configured browser hosts can speak CDP into a session.
- `security(ci)`: keychain helper SHA is verified at publish time, so a tampered helper binary cannot ride a release.

**Copilot (fix user-scoped MCP path)**

- Copilot's user-scoped MCP path now correctly resolves to `mcp-config.json` (the path the IDE actually reads) instead of the legacy filename. Fixes user-level MCP registrations not appearing in Copilot sessions.

**Docs**

- Full docs site IA shipped: browser, cloud, computer, hooks, plugins, profiles, pty, secrets, subagents, teams, workflows.
- Brand identity block: `agents-cli` is Phoenix Labs OSS, not part of the Rush brand — guards downstream agents against pulling Rush styling into this project.

**Build / install**

- Staged dev install tarball strips `prepack` and `prepare` hooks so side-by-side dev installs don't accidentally re-run the full publish pipeline locally.
- `test(jobs)`: un-break 3 stale assertions on main.

## 1.20.0

**Routines (overdue detection + catchup)**

- Detect routines whose most recent scheduled fire was missed (laptop off, daemon crashed, reboot). The daemon logs them on startup and pops a native desktop notification (`osascript` on macOS, `notify-send` on Linux).
- `agents routines list` annotates overdue rows with `(overdue)` and prints a footer pointing at the catchup command.
- New `agents routines catchup` command: lists overdue routines and fires them in the background under the scheduler. `--dry-run` lists without triggering.
- `JobScheduler.schedule` now sets croner's `catch: true` and forwards `timezone` defensively, so a synchronous throw in one job's callback can't kill the whole cron loop.

**Landing page (agents-cli.sh)**

- Expanded the homepage with seven new sections: rotate accounts (`--rotate`), parallel teams (`agents teams`), browser automation, cross-agent session search, routines/cron, keychain secrets, and machine-to-machine sync (`agents drive`).
- Rewrote meta description + lede to spell out the actual feature set (pin versions, swap models, rotate accounts, drive a browser, spawn parallel teams, schedule on cron) instead of just "same interface, on your machine."

**Codex (commands-as-skills sync fix)**

- Fix recurring "N commands new" prompt on `agents view codex` for Codex >= 0.117.0. `getActuallySyncedResources` now detects converted command-skills via the `agents_command` marker in `~/.codex/skills/<name>/SKILL.md` instead of only scanning the empty legacy `prompts/` directory.
- Summary and selection prompts are version-aware: the static `COMMANDS_CAPABLE_AGENTS` gate is replaced by `supports(agent, 'commands', version)` so the "X commands" line only appears for versions that can actually take them.
- Generalize `shouldInstallCommandAsSkill` beyond Codex — any agent where commands are gated off and skills are on (e.g. Grok) now gets the same automatic slash-command → skill conversion at install/sync time.

**Grok Build (first-class support)**

- Add `grok` as a first-class supported agent (AgentId + full registry entry using official `~/.grok/README.md` paths).
- Implement proper binary resolution from `~/.grok/downloads/`.
- Add `GROK_HOME` isolation to generated shims for true versioned config (skills, hooks, plugins, agents/, MCP, memory, etc.).
- Extend `installVersion` to support Grok via its official installer script (`curl ... -s <version>`).
- Update shims, exec templates, MCP path helpers, session helpers, unmanaged detection, and docs.
- `agents add grok@<ver>`, `agents use grok@<ver>`, resource sync, and shims now work end-to-end for Grok Build.

**Browser**

- `agents browser start --record` convenience flag for one-shot recording sessions.
- Auto-discover per-site `SKILL.md` on `browser start` so skills appear under the active task without manual wiring.
- Auto-pick a Chromium-family browser when `--profile` is omitted; the limitation is surfaced in `--help` and the auto-pick error.
- No more stacktraces when the daemon is down or CDP is unreachable — error paths print a single human-readable line.
- Drop the Playwright `bundled-chromium` devdependency.

**Secrets / Keychain**

- `agents secrets list` and `agents run --secrets <bundle>` collapse to one Touch ID prompt per bundle instead of one per key. Previously every secret in a bundle would re-prompt for keychain unlock.

**Sessions**

- Extract `groupActiveSessions` into a tested helper for `--active` window grouping.
- Propagate `windowid` from live-terminals into the active session record.

**Copilot**

- Emit `COPILOT_HOME` in the shim and exec env builder for versioned isolation.
- Wire the Copilot session dir and `.jsonl` extension into the sessions reader.

**OpenClaw**

- Carry OpenClaw user data forward on version switch.

**Teams**

- Warn loudly when `--after` teammates reference a name whose watch process never launched, instead of silently sitting in pending state.

**Plugins**

- Use `'directory'` source discriminator (not `'local'`) for marketplace registration so plugins reload correctly.

**Dependencies**

- Bump `@inquirer/prompts` 7.10.1 → 8.5.1, `diff` 8.0.4 → 9.0.0, `tsx` 4.22.2 → 4.22.3, `actions/setup-node` 4.4.0 → 6.4.0.

## 1.18.6

**Claude**

- Add auto permission mode support for Claude runs.
- Remove a dead automatic mode flag from the Claude command template.

**Teams**

- Fix the cycle-detection test to accept running or failed teammate status.

## 1.18.5

**Browser**

- **Breaking:** action commands no longer accept a leading `<task>` positional.
  Bind the task once per shell via `AGENTS_BROWSER_TASK`, or pass `--task <name>`
  for a per-call override:
  ```bash
  export AGENTS_BROWSER_TASK=$(agents browser start --profile work)
  agents browser navigate --url https://example.com
  agents browser click 42
  agents browser screenshot
  ```
  Env vars are per-process, so parallel agents in different shells never collide.
- **Breaking:** URL/text/expression/scroll arguments are now flag-only — positional forms removed:
  - `navigate --url <url>` (was `navigate <url>`)
  - `tab add --url <url>` (was `tab add <url>`)
  - `type <ref> --text "..."` (was `type <ref> "..."`)
  - `evaluate --expression "..."` or `--file <path>` (was `evaluate "..."`)
  - `scroll --dx <n> --dy <n>` (was `scroll <dx> <dy>` — fixes negative-value parser collision)
- `screenshot` prints a one-line auto-save tip on stderr when `--output` is not passed,
  so agents see the directory without having to dirname() the path.

## 1.18.4

**Browser**

- `agents browser start` writes the resolved task name to **stdout** as a
  single line (e.g. `swift-crab-falcon-a3f92b1c`), and routes the human
  commentary ("Started task ... with tab ...", "Tip: export
  AGENTS_BROWSER_TASK=...") to **stderr**. This makes
  `T=$(agents browser start --profile X)` Just Work — no `--quiet` flag needed.
- Auto-generated task names are now three English words plus an 8-char hex
  suffix, e.g. `swift-crab-falcon-a3f92b1c`. Memorable, distinct, 32 bits of
  entropy so parallel agents never collide. Daemon retries on the (vanishingly
  rare) name clash and rejects explicit `--task <name>` values that already
  exist.
- `agents browser start --profile <name>` now pre-validates the profile
  locally before touching the daemon. Missing profile prints the list of
  available profiles plus the create-command hint instead of a generic error.
- `agents browser tab list` is now `agents browser tabs` (top-level), pairing
  cleanly with `agents browser tab focus <id>`. The old `tab list` form is
  removed.
- `agents browser --help` is reorganized by mental model — *Session lifecycle*,
  *Drive the page*, *Capture evidence* — instead of an alphabetical dump.
  Rare commands stay under a trailing *Commands* section.
- BREAKING: `agents browser profiles prime` and `agents browser profiles launch`
  are removed. Both were thin duplicates of `start`. For first-run
  onboarding, just `agents browser start --profile <name>` and complete the
  interactive screens in the browser; the user-data-dir persists across
  runs. The daemon's `launch-profile` IPC action is also gone.
- Named endpoint presets per profile. One profile can now cover the local
  and remote variants of the same app instead of forcing two parallel
  profiles. YAML supports both the legacy `endpoints: [url]` shape and the
  new map form:
  ```yaml
  name: rush
  browser: custom
  electron: true
  endpoints:
    local:
      target: cdp://127.0.0.1:9223
      binary: /Applications/Rush.app/Contents/MacOS/Rush
    mac-mini:
      target: ssh://mac-mini?port=9223
      # no binary — daemon attaches only
  defaultEndpoint: local
  ```
  `agents browser start --profile rush --endpoint mac-mini` picks a specific
  preset; `--endpoint` falls back to `defaultEndpoint` or the first preset.
  Pre-validated client-side so a typo doesn't waste an IPC round-trip.
  Per-endpoint `binary` and `targetFilter` override the profile-level
  fields. `agents browser profiles show` lists every preset, marks the
  default, and shows per-endpoint overrides.
- The daemon's runtime identity is now `<profile>@<endpoint>` so the same
  profile can run at multiple endpoints concurrently without colliding on
  pid/port files. `agents browser status` and `tasks` show the composite
  name, so you can tell at a glance which variant a task is using.
- `agents browser screenshot --quality raw` captures pixel-faithful PNG
  (no downscale) for archived QA evidence. Default stays `compressed`
  (JPEG, capped near 100 KB) for chat-injected screenshots.
- New `agents browser record start` / `agents browser record stop`
  recording verbs. Captures via CDP `Page.startScreencast`, pipes frames
  into ffmpeg (image2pipe → libvpx-vp9) and writes a webm under
  `sessions/<task>/recordings/`. Bounded three ways — `--fps` (default
  5), `--duration` (hard cap, default 60s), `--max-mb` (default 25);
  whichever fires first auto-finalizes the file. Requires ffmpeg on
  PATH (`brew install ffmpeg`).

## 1.18.3

**Plugins** ([#22](https://github.com/phnx-labs/agents-cli/issues/22))

- `agents plugins sync` now installs plugins via Claude Code's native marketplace path — `<versionHome>/.{claude,openclaw}/plugins/marketplaces/agents-cli/plugins/<name>/` — instead of flattening contents into `~/.claude/skills/<plugin>--<skill>/`. Skills resolve as `/plugin:skill` (the documented form) instead of `/plugin--skill`. Plugins appear in Claude's `/plugins` UI under Installed and respond to `/plugin enable`, `/plugin disable`.
- A synthetic `agents-cli` marketplace is materialized per version: `.claude-plugin/marketplace.json` is synthesized from discovered plugins, an entry is added to `<versionHome>/.claude/plugins/known_marketplaces.json`, and `settings.json#enabledPlugins["<plugin>@agents-cli"]` is flipped to `true`. Removal is symmetric — last plugin out drops the marketplace dir and the known_marketplaces entry.
- The sync now copies the whole plugin tree verbatim (single `fs.cpSync`) instead of re-implementing per-feature merges into `settings.json`. Every Claude plugin feature — skills, commands, subagents, hooks, `.mcp.json`, `.lsp.json`, `monitors/monitors.json`, `bin/`, `settings.json` — is preserved end-to-end. `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are left intact so Claude can expand them at runtime; only `${user_config.*}` (agents-cli-specific) is pre-expanded in copied text files.
- Legacy dual-dash layout from prior versions is auto-migrated at sync time — `~/.claude/skills/<plugin>--*`, `~/.claude/commands/<plugin>--*.md`, `~/.claude/agents/<plugin>--*.md`, `plugin-bin/<plugin>/`, and namespaced `mcpServers["<plugin>--*"]` entries are removed after the marketplace install succeeds.
- `agents plugins view <name>` surfaces every feature the plugin ships: Skills, Commands, Subagents, Hooks, MCP Servers, LSP Servers, Monitors, Bin, Scripts, Settings. The `agents view <agent>@<version>` Plugins section gains MCP/LSP/Monitor/Bin/Settings counts. New `discoverPluginMcpServers`, `discoverPluginLspServers`, `discoverPluginMonitors` helpers parse `.mcp.json`, `.lsp.json`, and `monitors/monitors.json`.

## 1.18.2

**Teams**

- Dropped `~/.agents/teams/config.json` entirely. It duplicated information agents-cli already has — agent commands, enabled flags, model defaults, provider endpoints — none of which the team runner was actually reading. Teams now discover agents via `listInstalledVersions()` (the same source `agents view` uses) and invoke them via the canonical `agents run` subcommand. One spawn path, one canonical exec module (`src/lib/exec.ts`). The deprecated `AGENT_COMMANDS`, `applyEditMode`, `applyFullMode`, `readConfig`, `writeConfig`, `setAgentEnabled`, `AgentConfig`, `SwarmConfig`, `ProviderConfig`, `ModelOverrides`, `ReadConfigResult`, and `EffortLevel` (the persistence-module copy) exports are removed from `@phnx-labs/agents-cli/teams`. Migration deletes both `~/.agents/teams/config.json` and the legacy `~/.agents/config.json`.
- `~/.agents/teams/registry.json` moves to `~/.agents/.history/teams/registry.json` — it's per-machine runtime state (timestamps + absolute worktree paths) and shouldn't be synced across machines via `agents repo push`.
- New `agents run --quiet` flag suppresses the rotation banner and `Running: …` preamble lines. Used by the team runner so stream-json events reach the parser without non-JSON preamble.

**Dev builds**

- The CLI auto-detects dev builds (version stamped `0.0.0-dev.<sha>` by `scripts/install.sh`, or invoked from a working tree where `<cli-dir>/../.git/` exists) and defaults `AGENTS_NO_AUTOPULL=1`, `AGENTS_SKIP_MIGRATION=1`, and `AGENTS_CLI_DISABLE_AUTO_UPDATE=1`. No more typing those three env vars on every iteration. Production installs (registry global, no `.git/` at package root) are unaffected.

## 1.18.1

**Fixes**

- `scripts/build.sh` now sets mode `0o755` on every file declared in `package.json#bin` after `tsc` emits dist/. Newer npm versions preserve file mode from the published tarball and do NOT auto-chmod the bin target during `npm install -g`, so 1.18.0 shipped with mode-644 entrypoints. Users hit `zsh: permission denied: agents` after auto-update. Re-install to recover: `npm install -g @phnx-labs/agents-cli@latest`.
- New `scripts/install.sh` builds the working tree as a side-by-side dev install at `$HOME/.local/agents-cli-dev/`, symlinked into `$HOME/.local/bin/agents`. The registry install is never touched — `agents --version` shows `0.0.0-dev.<sha>[-dirty]` when the dev build is on PATH.

## 1.18.0

**Plugins**

- `~/.agents/plugins/` is now a first-class user-resource location, alongside `skills/`, `commands/`, `hooks/`, etc. — git-tracked as source of truth. Previously, `migrateRuntimeToCache` moved `~/.agents/plugins/` into `~/.agents/.cache/plugins/` on every CLI version bump, silently destroying user-authored plugins in the working tree. Fixed by (1) removing the destructive move, (2) restoring discovery to the user-root, (3) a one-shot reverse migration that moves any cached plugins back to the user-root without overwriting an existing user-root copy, and (4) decoupling the migration sentinel from the binary version so migrations only re-run on real schema bumps. ([#20](https://github.com/phnx-labs/agents-cli/issues/20))
- `agents view <agent>@<version>` gains a `Plugins` section listing each plugin that supports the agent, with a `(N skills, N commands, …)` content summary and an OSC 8 hyperlink to the plugin source.

**Hooks**

- `getAvailableResources` and the version-home sync now treat only executable files in `hooks/` as hooks. Docs (`README.md`) and data files (`promptcuts.yaml`) that live alongside hooks no longer get synced into version homes as hooks, and the orphan-pruner trusts the manifest's declared hook list rather than re-scanning every source dir.

## 1.17.6

**Workflows**

- New `workflows` skill — author-and-run guide for workflow bundles (`WORKFLOW.md` frontmatter, `subagents/` directory for multi-agent pipelines, scoped `skills/` and `plugins/`, sharing via `agents repo push` or GitHub install). Calls out the `--mode plan` deadlock that bites workflows which need to post comments or edit files.
- `agents workflows --help` rewritten with a structure diagram, project > user > system resolution order, and an explicit note that workflows mutating state need `--mode edit` or `--mode full` to avoid a headless deadlock at `ExitPlanMode`.
- README gains a `Workflows` section between Teams and Browser covering the bundle layout, frontmatter, subagents/skills/plugins, and the `--mode` requirement.

## 1.17.4

**Browser**

- `agents browser type` now detects rich-text editor frameworks (Lexical, ProseMirror, Slate, Draft.js, Quill, CKEditor5, Trix) by walking up to 5 ancestor levels from each textbox and tagging refs with `[editor=<framework>]`. Editor-tagged refs route through the WHATWG `beforeinput` dispatch (`InputEvent('beforeinput', { inputType: 'insertText', ... })`) for Lexical/ProseMirror/Slate/Quill/CKEditor5/Draft and `el.editor.insertString()` for Trix. `agents browser refs --json` surfaces the new `editor` field, and `type --clear` prepends a select-all + `deleteContentBackward` dispatch before inserting.
- Plain-input reliability also improved: `typeText` now issues a single CDP `Input.insertText` instead of per-character `dispatchKeyEvent`, so framework-controlled inputs (React, Vue, Solid, MUI/Chakra/Mantine `TextField`, masked-number fields, Canva-style pickers) actually receive `beforeinput`/`input`/`textInput` events. `focusNode` falls back to the first focusable descendant when `DOM.focus` throws "Element is not focusable" — fixes wrapper-ref UIs like Slack composer, Linear comments, Notion blocks, and every MUI/Chakra/Mantine `TextField`. ([#12](https://github.com/phnx-labs/agents-cli/pull/12))

## 1.17.3

**Browser**

- `agents browser profiles create` gains `--electron`, `--binary`, and `--target-filter` for driving Electron desktop apps (Canva, Slack, etc.) that expose multiple CDP page targets. The picker matches by `url:<substring>` or `title:<substring>` (case-insensitive) and falls back to a skip-invisible heuristic when no filter is set; misses against an explicit filter throw with the full candidate list. `BrowserService.evaluate` now uses `awaitPromise: true` and surfaces `exceptionDetails` so async script errors propagate as thrown errors. ([#14](https://github.com/phnx-labs/agents-cli/pull/14))

**Secrets**

- `agents secrets list` rework — drop the misleading `SENSITIVE` column and add `SYNC` (iCloud yes/no) plus `CREATED` / `UPDATED` / `USED` relative-age columns. Timestamps live inside the keychain bundle JSON, are stamped on write (created sticky, updated always advances), and on resolve via a 60s throttle. Set `AGENTS_NO_USAGE_TRACK=1` to disable the usage stamp. `agents secrets view` shows the matching absolute ISO + relative age fields. ([#18](https://github.com/phnx-labs/agents-cli/pull/18))

## 1.17.2

**Fixes**

- Auto-update prompt no longer hangs in non-interactive environments (CI, k8s pods, cloud sandbox factories). The TTY check now requires both stdin and stdout to be terminals before prompting, and `AGENTS_CLI_DISABLE_AUTO_UPDATE=1` forces the check off entirely for headless deploys. ([#15](https://github.com/phnx-labs/agents-cli/issues/15))

## 1.17.1

**Agent management**

- `agents import <agent>` — adopt an existing global npm/homebrew install into agents-cli management without reinstalling. Supports `--version`, `--from-path`, `--yes`. The imported version is wired in as the global default with shim + versioned alias so it behaves the same as a freshly `agents add`'d install.

## 1.17.0

**Workflows: a new first-class resource**

- `agents workflows list / add / remove / view` — WORKFLOW.md bundles (with optional `subagents/`, `skills/`, `plugins/`) install from GitHub or a local path and resolve through the same system → user → project layer model as every other resource.
- `agents run <name>` resolves a workflow or named subagent as an orchestrator: prepends WORKFLOW.md / AGENT.md body to the prompt, copies `subagents/*` into `~/.claude/agents/` for Agent-tool discovery, and syncs workflow-scoped `skills/` and `plugins/` at run time.
- `agents view` now has a workflows section.

**Browser**

- Port-per-profile with auto-allocation and viewport enforcement — concurrent browser profiles no longer collide on CDP ports.
- `agents browser scroll` plus new `profiles launch`, `profiles doctor`, `profiles prime`, viewport position, and port diagnostics commands.
- `agents browser profiles list` now shows a description column when any profile has one.
- `isProcessRunning` treats EPERM as process-alive (fixes false-negative on sandboxed processes).

**Cloud dispatch**

- `--balanced` strategy and `--upload-account-tokens` flag on cloud dispatch.
- Remote account API client; `--balanced` skips the client manifest path.

**Plugin system extension**

- Plugins now ship with `commands/`, `agents/`, `bin/`, MCP configs, settings, and `install` / `update` hooks. Discovery and sync extended end-to-end.

**Secrets**

- `agents secrets import <bundle> --from-1password` / `export <bundle> --to-1password` with vault picker, skip-empty-fields on import, overwrite-only-with-`--force` on export. Wires the existing 1Password library into the CLI.

**Sandbox**

- `scripts/sandbox.sh --pr` — author real PRs from a Crabbox-isolated box via a bare-mirror clone off main.
- `sandbox.sh --linear` and `--post-file` post run output to Linear tickets.
- Dynamic GitHub App token, `gh` CLI installed, stale git credentials cleaned.

**Sessions / SQLite concurrency**

- Scan coordinator prevents concurrent session indexing.
- SQLite concurrency hardened with `BEGIN IMMEDIATE` and ledger recheck on contention.
- Session discovery uses `getHistoryDir` for version roots and backup paths.

**Run / shims / hooks**

- Versioned alias shims regenerate on startup if missing.
- Hooks prefer version-home scripts to prevent path breakage when the source dir moves.
- Linux: claude shim sources `CLAUDE_CODE_OAUTH_TOKEN` from the per-version `.oauth_token` file when unset.

**Resource UI**

- `agents view` replaces path columns with OSC 8 hyperlinks for commands, skills, and rules.
- Flat version resource lists replaced with source-pattern selection.

**CI / security**

- Gitleaks secret-scanning workflow on every push (switched to the free CLI, no org license needed).

**Postinstall**

- Correct shims dir, expanded aliases, prints changelog on install.

**Dev**

- Test isolation via vitest `pool: 'forks'`; mock state paths instead of hitting real `~/.agents/`.
- Concurrent-writes benchmark for the session indexer.
- Dead code + phantom deps removed: `src/commands/fork.ts`, `@aws-sdk/client-s3`, `@modelcontextprotocol/sdk`, `semver`.

## 1.16.0

**System-repo sweep: ~/.agents-system reduced to npm-shipped defaults only**

- New migrators move every form of operational state out of ~/.agents-system into user-side buckets: sessions, teams (live + per-run), trash, repos (→ ~/.agents-<alias>/ peer dirs), legacy swarm/, cache/, cloud/.
- SQLite DBs merge row-level (INSERT OR IGNORE) into the user-side DB; filesystem dirs merge dir-by-dir with user-side winning on collision.
- Dead artifacts dropped automatically: bin/agents-keychain-*, empty shims/, .DS_Store-only versions/ skeletons.
- Unrecognized leftover dirs print a one-line stderr warning so future drift surfaces immediately.
- Migration diagnostics moved to stderr — `eval "$(agents secrets export …)"` stops being polluted by log lines.
- DB merge now skips FTS5 virtual + shadow tables (previously corrupted the session_text index). Indexer re-populates FTS on the next scan.
- Stale ~/.agents-system/agents.yaml is now dropped when a user copy exists.

**~/.agents split into .history/ and .cache/ buckets**

- Durable runtime state (sessions, versions, runs, teams/agents, trash, backups) moves to ~/.agents/.history/.
- Regenerable runtime state (shims, packages, cloud, logs, companion, helpers, browser runtime, fetch cache, dot-files) moves to ~/.agents/.cache/.
- Single-line gitignore for backing up ~/.agents/ — no more per-subdir cherry-picking.

**Browser: profiles fold into agents.yaml + many new automation commands**

- Profile YAMLs at ~/.agents/browser/profiles/*.yaml now live as a `browser:` section in agents.yaml. Single user-facing file, single sync.
- Single window per profile; `start` renamed to `open`; new tab subcommands; session history with profile picker; viewport piped through to the launched browser.
- New commands: `agents browser set viewport`, `set device`, `devices`, `console`, `errors`, `requests`, `responsebody`, `wait`, `download`, `waitdownload`.

**Hooks: hooks.yaml folded into agents.yaml `hooks:` section**

- ~/.agents/hooks.yaml is migrated into agents.yaml on first run; the standalone file is removed.
- System repo ships the same shape — one config file, layered project > user > system.

**Sessions & secrets**

- `agents secrets exec <bundle> -- <command>` injects a bundle's env vars into a one-shot subprocess (no shell-state leakage).
- `agents sessions` now groups active sessions by workspace and surfaces session topics in the picker.
- Session discovery scans both version repos; migrator merges overlapping versions instead of leaving duplicates.

**Renames**

- `agents init` → `agents setup`.
- `permissions/sets/` → `permissions/presets/` (resource directory + on-disk migration to match rules/presets convention).

**Dev**

- Crabbox remote-test profile (~$0.14/hr) + `scripts/sandbox.sh` documented in README and CLAUDE.md. Tests run remotely to avoid freezing the local machine.

## 1.15.0

**Secrets: Linux support via libsecret/GNOME Keyring**

- `agents secrets` now works on Linux backed by libsecret/GNOME Keyring with the same UX as macOS Keychain. Headless workarounds documented.
- New `agents password generate` subcommand.
- Lifecycle events emitted for secrets and other subsystems; richer metadata (timing helpers) on the events system.

**Browser**

- HTTP and WebSocket endpoint support for remote browsers.
- Concurrent Electron profile forks no longer step on each other; cleanup hardened.
- Remote browser restart works; SSH port handling improved; page target created when none exists for Electron apps.
- Events emitted for navigation and screenshots.

**First-run UX**

- Improved new-user experience: clearer CLI help, better defaults, audit-log opt-out, better run-timing display.

**Prune**

- `agents prune` learned `trash`, `sessions`, and `runs` cleanup targets.

**Fixes**

- Command-injection hole in daemon + secrets closed.
- Layered permission resolution corrected; daemon tests isolated from real user state.
- `.tmp-bun` gitignore pattern fixed.
- `codex` interactive mode no longer routes through `exec` subcommand.

**Docs**

- Security/privacy section in README, browser skill + automation guide, FAQ updated with audit-log transparency.

## 1.14.6

**Fix: OAuth token refresh now persists to Keychain**

- Fixed bug where refreshed Claude OAuth tokens were used but never saved back to macOS Keychain
- Previously, agents-cli would refresh expired tokens on each run but discard them, eventually exhausting the refresh token
- Now refreshed `accessToken`, `refreshToken`, and `expiresAt` are written back to Keychain after successful refresh
- Accounts will stay healthy across runs without requiring re-login

## 1.14.5

**Browser: custom binary and Electron app support**

- Added `binary` field to browser profiles for specifying custom executable paths (e.g., Electron apps like Rush)
- Added `electron` field to browser profiles — when true, uses existing windows instead of creating new ones (Electron doesn't support `Target.createTarget`)
- New `custom` browser type that requires a binary path
- Works with both local and SSH-based browser connections
- Example profile for Rush: `agents browser profiles edit rush --browser custom --binary "/Applications/Rush.app/Contents/MacOS/Rush" --electron`

## 1.12.0

**JSON output for sessions list**

- Added `--json` flag to `agents sessions list` and `agents sessions` for programmatic use
- Output is a JSON array of session metadata (id, shortId, agent, version, account, project, cwd, filePath, topic, messageCount, tokenCount, timestamp)
- Enables the Companion VS Code extension's "Agents: Session Resume" and "Agents: Session Trace" pickers

**OpenClaw workspace-aware sessions**

- Fixed `agents sessions --agent openclaw` so synthetic OpenClaw rows now use the configured agent workspace from `~/.openclaw/openclaw.json`
- When no per-agent workspace is available, OpenClaw session discovery now falls back to `~/.openclaw` instead of leaving `cwd` empty or filling it with status text
- Added a regression test covering managed OpenClaw homes symlinked through `~/.agents/versions/openclaw/...`

## 1.11.1

**Session search and version labeling**

- `agents sessions view` now opens a live-search picker by default in interactive terminals
- `agents sessions --agent ...` and `agents sessions --project ...` now open the same live-search picker before falling back to the table view
- `agents sessions view <query>` now resolves prompt text, not just exact session IDs
- Fixed `--project` search so it scans across directories instead of intersecting with the current working directory
- Session topics now skip injected scaffolding and use the first human prompt
- Codex session rows now show the real CLI build from `cli_version` (for example `codex@0.113.0`)
- Gemini, OpenCode, and OpenClaw session rows now resolve and display agent versions consistently in the shared `Agent` column
- Claude usage lookup now falls back across scoped and legacy Keychain services when loading OAuth credentials

## 1.11.0

**PTY -- interactive terminal sessions for AI agents**

- New `agents pty` command suite for persistent, interactive PTY sessions
- Sidecar server architecture -- lightweight daemon on `~/.agents/pty.sock`, auto-starts on first use
- `agents pty start` -- spawn a session with configurable rows, cols, shell, and working directory
- `agents pty exec <id> <command>` -- submit commands (non-blocking, sentinel-based completion detection)
- `agents pty screen <id>` -- render the terminal as clean text (no ANSI codes), powered by xterm-headless
- `agents pty write <id> <input>` -- send keystrokes with escape sequence support (`\n`, `\t`, `\e`, `\xHH`)
- `agents pty read <id>` -- read raw PTY output with configurable timeout
- `agents pty signal <id> [INT|TERM|KILL]` -- send signals to the PTY process
- `agents pty list` -- show active sessions with status, PID, age, and active command
- `agents pty server start|stop|status` -- manage the sidecar server directly
- Session idle cleanup (30 min) and server auto-exit (1 hour with no sessions)
- `--json` output on all commands for scripting
- Auto-fixes node-pty spawn-helper permissions on startup (bun install workaround)

## 1.10.0

**Drive -- sync agent sessions across machines**

- New `agents drive` command for syncing agent state between machines via rsync over SSH
- `agents drive remote <user@host>` -- set sync target (syncs to `~/.agents/drive/` on remote)
- `agents drive pull` / `push` -- additive rsync (no data loss, both sides accumulate)
- `agents drive attach` -- swap `~/.claude` symlinks to the drive, so Claude reads/writes there
- `agents drive detach` -- restore symlinks to the version home
- `agents drive status` -- show remote, attached state, symlink targets, last sync times

## 1.9.1

**Better sessions**

- Sessions list and picker show `Agent@Version` combined column (e.g., `claude@2.1.85`)
- Added `Topic` column showing first user message of each session
- Account shows email instead of display name

## 1.9.0

**New agents, routines, and better sessions**

Agents:
- Added support for 5 new agents: Copilot, Amp, Kiro, Goose, and Roo Code
- Agent type expanded to 11 agents total

Routines (renamed from cron):
- `agents cron` is now `agents routines` -- aligns with Claude Code Routines naming
- `agents cron` and `agents jobs` still work as deprecated aliases
- `~/.agents/cron/` directory renamed to `~/.agents/routines/`

Sessions:
- Sessions list now shows `Agent@Version` in a combined column (e.g., `claude@2.1.85`)
- Added `Topic` column showing the first message of each session
- Account column now shows email instead of display name
- Session picker uses the same columns as the list view

Other:
- Account email preferred over display name across the CLI
- Rewritten help text for all top-level commands

## 1.6.12

**"memory" is now "rules"**

The `agents memory` command has been renamed to `agents rules`. This better reflects what these files actually are -- instruction files like AGENTS.md, CLAUDE.md, and .cursorrules that tell your agents how to behave.

- `agents rules list` -- see your instruction files across all agents
- `agents rules add` -- install and sync rule files from a repo or local path
- `agents rules view` -- view rule file content for any agent
- `agents rules remove` -- remove a rule file

If you run `agents memory`, you'll see a message pointing you to the new command.

The files themselves haven't changed -- AGENTS.md is still AGENTS.md. Only the CLI command name changed.

## 1.6.8

**Bug fix**

- Skip commands and memory sync for agents that don't support file-based commands (openclaw)
- Added `commands` capability flag to agent configs
- `agents use openclaw` and `agents view openclaw` no longer show or sync slash commands or memory files
- Fixed `hasNewResources` to filter by agent capabilities (was triggering prompt even when no applicable resources existed)

## 1.6.5

**Bug fix**

- Fixed memory file detection counting symlinks as separate files (CLAUDE.md/GEMINI.md -> AGENTS.md)

## 1.6.4

**Bug fixes**

- Fixed Claude email not showing in `agents view` (was reading from version home instead of real ~/.claude.json)
- Fixed memory file updates not being detected in `agents use` (now compares content, not just existence)

## 1.6.3

**Bug fix**

- Fixed infinite "new resources available" loop in `agents view`
- Partial resource syncs no longer wipe out previously synced resources

## 1.5.82

**MCP & Permission improvements**

- MCP configs now stored as YAML in `~/.agents/mcp/` (was JSON)
- Permissions now use groups from `~/.agents/permissions/groups/`
- Resource selection shows proper counts: "Permissions (19 groups, 3132 rules)"
- When selecting "specific" permissions, shows individual groups with rule counts
- Added MCP support for cursor and opencode agents
- Removed `agents` filter from MCP configs - selection tracked in agents.yaml
- Added capability checks for MCPs (consistent with hooks/permissions)

## 1.5.81

**Cron jobs & unified execution**

- Renamed `jobs` command to `cron` (`jobs` still works with deprecation warning)
- New `agents exec <agent> <prompt>` for unified agent execution across all CLIs
- Inline job creation: `agents cron add my-job --schedule "..." --agent claude --prompt "..."`
- One-shot jobs with `--at`: `agents cron add reminder --at "14:30" -a claude -p "..."`
- New `agents cron edit [name]` opens job in `$EDITOR`
- Timezone support: `--timezone America/Los_Angeles`
- Custom variables in prompts: define `variables:` block, use `{var_name}` in prompt
- Interactive pickers for all cron subcommands when name is omitted
- Smart filtering: `resume` shows only paused jobs, `pause` shows only enabled jobs
- Effort-based model mapping: `--effort fast|default|detailed` maps to agent-specific models

**Resource command cleanup**

- Added `view` command to commands, mcp, hooks, and permissions
- Removed `push` commands from all resources (commands, skills, mcp, memory, hooks)
- Deprecated `perms` alias for `permissions` (shows warning but still works)
- Deprecated `info` alias for `skills view`, `show` alias for `memory view`

## 1.5.68

- Upgrade prompt now shows on ALL command flows (--version, --help, bare `agents`)

## 1.5.67

**Unified view command**

- New `agents view` command replaces `list` and `status`
- `agents view` / `agents view claude` shows installed versions
- `agents view claude@2.0.65` shows full resources (commands, skills, mcp, hooks, memory)
- Old commands show deprecation warning but continue to work

## 1.5.48

**Simplified repo structure**

- Flattened repo structure: removed `shared/` prefix
- Resources now live at top level: `commands/`, `skills/`, `hooks/`, `memory/`, `permissions/`
- Removed agent-specific override directories (no more `claude/commands/`, etc.)
- Simplified discovery functions

## 1.5.29

**Version-aware resource installation**

- `agents pull` now prompts for version selection per agent when multiple versions are installed
- Resources (commands, skills, hooks, memory) are linked into version homes at pull time via `syncResourcesToVersion()`
- Simplified shims: HOME overlay + exec only (~80 lines, down from ~160). No more runtime sync logic.
- MCP registration uses direct binary path for version-managed agents (bypasses shim)

## 1.5.7

- Remove trailing newlines from command output

## 1.5.5

- Update prompt: Interactive menu before command runs (Upgrade now / Later)

## 1.5.4

- `cli list`: Shows spinner while checking installed CLIs

## 1.5.3

- `skills view`: Opens in pager (less) for scrolling, press `q` to quit

## 1.5.2

- `skills view`: Truncate descriptions to fit on one line

## 1.5.1

- Update check: Shows prompt when new version available
- What's new: Displays changelog after upgrade
- `skills view`: Interactive skill selector (renamed from `info`)
- Fixed `--version` showing hardcoded 1.0.0 (now reads from package.json)
- Silent npm/bun output during upgrade

## 1.5.0

**Pull command redesign**

- Agent-specific sync: `agents pull claude` syncs only Claude resources
- Agent aliases: `cc`, `cx`, `gx`, `cr`, `oc` for quick filtering
- Overview display: Shows NEW vs EXISTING resources before installation
- Per-resource prompts: Choose overwrite/skip/cancel for each conflict
- `-y` flag: Auto-confirm and skip conflicts
- `-f` flag: Auto-confirm and overwrite conflicts
- Graceful cancellation: Ctrl+C shows "Cancelled" cleanly

## 1.4.0

- Conflict detection for pull command
- Bulk conflict handling (overwrite all / skip all / cancel)

## 1.3.13

- Enabled skills support for Cursor and OpenCode
- Fixed Cursor MCP config path (now uses mcp.json)

## 1.3.12

- Fixed MCP detection for Codex (TOML config format)
- Fixed MCP detection for OpenCode (JSONC config format)
- Added smol-toml dependency for TOML parsing

## 1.3.11

- Status command shows resource names instead of counts
- Better formatting for installed commands, skills, and MCPs

## 1.3.0

- Added Agent Skills support (SKILL.md + rules/)
- Skills validation with metadata requirements
- Central skills directory at ~/.agents/skills/

## 1.2.0

- Added hooks support for Claude and Gemini
- Hook discovery from hooks/ directory
- Project-scope hooks support

## 1.1.0

- Added MCP server registration
- Support for stdio and http transports
- Per-agent MCP configuration

## 1.0.0

- Initial release
- Pull/push commands for syncing agent configurations
- Slash command management
- Multi-agent support (Claude, Codex, Gemini, Cursor, OpenCode)
