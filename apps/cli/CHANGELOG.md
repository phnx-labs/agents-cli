# Changelog

## Unreleased

- **Browser-profile credentials: account identity, `secrets get <bundle> <KEY>`, and `browser type --secret` for leak-free login.** `agents browser profiles logins` now shows, per profile, the account signed into each live service (plaintext username from Chromium `Login Data` — never decrypts the encrypted password) and whether login creds are declared in the profile's secrets bundle (columns `SERVICE | ACCOUNT | CREDS`); `profiles show` gains a `Logins:` block. `agents secrets get <bundle> <KEY>` prints one resolved value from a bundle (arg-count overload of the existing raw `get <item>`; ungated like it, and the `secrets.get` audit event fires inside the resolver). `agents browser type <ref> --secret <bundle>/<KEY>` resolves a credential in-process and types it into the page — the value never crosses stdout or the agent transcript — so an agent can drive a login by composing `profiles logins` → `browser start <loginUrl>` → `refs` → `type --secret` → `screenshot`, handling 2FA/selectors itself (no fragile CLI auto-login engine; Google/X block automation anyway). A profile's `--secrets` bundle is the credential store, keyed by the `<PREFIX>_USERNAME`/`<PREFIX>_PASSWORD` convention (per-service prefixes in `AUTH_SIGNATURES`); `profiles create --secrets` now warns if the bundle doesn't exist yet. Cookie-persistence-first remains the headline (the `browser` skill's credential guidance was corrected — the bundle only injected env vars into the browser process before, inert for web login). Source: `apps/cli/src/lib/browser/login-detection.ts`, `apps/cli/src/lib/browser/secret-ref.ts`, `apps/cli/src/commands/browser.ts`, `apps/cli/src/commands/secrets.ts`.
- **`agents logs audit` / `agents logs stats` / `agents logs rotate` — user-facing audit trail viewer.** The local event log (`~/.agents/.cache/logs/events-*.jsonl`) is now a first-class audit surface. `agents logs audit` queries events with filters (`--module`, `--command`, `--event`, `--agent`, `--level`, `--since`, `--limit`, `--json`) and `--follow` for live tailing; `agents logs stats` shows aggregate breakdowns by level, event type, module, and user; `agents logs rotate` force-prunes old log files (`--days`, default 14). Events now carry `level` (audit/warn/info/debug) and `caller` (source file via stack trace). Security-relevant operations (secrets, teams lifecycle, cloud dispatch) auto-classify as `audit`. Files exceeding 10 MB are gzip-compressed in place; `query()` reads `.jsonl.gz` archives transparently. New instrumentation in `cloud.ts`, `factory.ts`, `teams.ts`, `secrets.ts` (pre-existing), `mcp.ts`, and `rotate.ts`. Source: `apps/cli/src/lib/events.ts`, `apps/cli/src/commands/logs.ts`, instrumentation call sites. (RUSH-460)
- **`agents run claude --lease` now runs the box logged-in — the Claude OAuth token ships alongside the config.** The lease copied `~/.claude.json` (config/account-metadata) but never the OAuth token, so Claude booted "Not logged in" on every leased box. The token lives in the macOS Keychain (hash-suffixed service for an agents-cli managed home, bare for a default install) and on Linux at `~/.claude/.credentials.json`. `resolveClaudeCredentialsBlob()` now reads the raw wrapped Keychain payload **silently** (`/usr/bin/security … -w` — Claude's item trusts it, no Touch ID): bare service first, then enumerate installed version homes, preferring the account whose email matches the copied config; off-darwin it reuses the existing `.credentials.json` file branch. `buildCredentialScript` writes that blob to `~/.claude/.credentials.json` (0600) via the same quoted-heredoc that carries every other cred (the box's `~/.claude` is a symlink into the versioned home, so it lands exactly where the shim's `CLAUDE_CONFIG_DIR` reads it); it is shredded after the run **regardless of `--keep-box`**. Resolved in the command layer after the existing per-run consent prompt, whose text now names the token explicitly. Scope is Claude-only — Codex/Grok already ship their token in the copied auth file. Verified live on Hetzner: a leased box ran `agents run claude` and returned a real model reply (`LOGIN_OK`, exit 0), and the token file was absent (shredded) afterward. Source: `apps/cli/src/lib/crabbox/runtimes.ts` (`resolveClaudeCredentialsBlob`, `buildCredentialScript`), `apps/cli/src/lib/crabbox/lease.ts`, `apps/cli/src/commands/exec.ts`.
- **`agents browser profiles set-default <name>` picks the profile a bare `agents browser start` uses — so agents stop opening a logged-out Chrome.** With no `--profile`, `start` used to auto-detect the first installed Chromium-family browser (Chrome first on macOS) and save it as `default`, ignoring a profile you'd actually logged into. Now `start` resolves in order: (1) your configured default, (2) an existing `default` profile, (3) auto-detect. The configured default ALSO re-points an explicit `--profile default`, so an agent that hardcodes `default` still lands on your chosen profile. The setting is **device-local** — stored in `~/.agents/devices/<machine>/agents.yaml`, never synced to other machines (the target profile may hold machine-local logins). `profiles list`/`show` mark it; `set-default --unset` reverts to auto-detect; a missing target warns and falls back rather than hard-failing. Source: `apps/cli/src/lib/browser/profiles.ts` (`ensureDefaultBrowserProfile`, `getConfiguredDefaultProfileName`), `apps/cli/src/lib/state.ts` (`writeMetaUnlocked`, `overlayMachineLocal`), `apps/cli/src/lib/types.ts` (`Meta.defaultBrowserProfile`), `apps/cli/src/commands/browser.ts`.
- **`agents browser` now warns when a task opens a login-gated site on a logged-out profile — grounded in real session state.** New `apps/cli/src/lib/browser/login-detection.ts` reads a profile's Chromium cookie store (presence only — never decrypts the Keychain-encrypted values, and filters expiry in SQL so Chromium's >2^53 microsecond timestamps never trip `node:sqlite`'s integer range) to tell which login-gated services (LinkedIn, Google, X, GitHub, Reddit) have a live session. `agents browser start --url <login-gated>` prints a stderr hint like `profile "default" has no linkedin.com session. logged in elsewhere: comet-local. try: --profile comet-local` when the chosen profile is logged out; it never blocks or slows start. `agents browser profiles logins` shows a profile-by-service table. Source: `apps/cli/src/lib/browser/login-detection.ts`, `apps/cli/src/commands/browser.ts`.
- **Fix: a finished session that signed off with a trailing "?" no longer reads as `input_required` forever (RUSH-1522).** The session state engine's prose-question heuristic (last assistant message ends with a question) now decays after 30 minutes without a session write: an unanswered prose question older than that classifies as `idle`, not `waiting_input` — so `agents sessions --active` and the Factory Floor's NEEDS YOU lane stop surfacing long-finished sessions as needing input. The structural signals are exempt and never decay: a genuinely pending `ExitPlanMode` (plan review) or `AskUserQuestion` still classifies as `waiting_input` at any age. Source: `apps/cli/src/lib/session/state.ts` (`inferActivity`, `PROSE_QUESTION_FRESH_MS`).
- **The post-upgrade "What's new" summary shows the release notes again.** The summary parser only recognized the old changelog format (standalone `**Heading**` lines with sub-bullets); every release since the changelog moved to single-line `- **Title.** prose…` entries rendered as a bare version header with zero bullets, so upgrades looked like they shipped nothing. The parser now extracts the bold heading from both formats (prose still dropped — full notes stay in the changelog). Verified against the real changelog: the 1.20.49 → 1.20.50 range renders all four 1.20.50 entry titles. Source: `apps/cli/src/lib/whats-new.ts`.
- **Fix: daemon no longer crash-loops when started from the bare `browser` or `computer` shim.** Daemon launch resolution now maps installed sibling shims to the `agents` launcher and compiled shims to `index.js` before generating launchd/systemd commands, and fails clearly if that invariant is broken. Headless auto-start reads the long-lived Claude token only from an already-unlocked secrets-agent snapshot, so it cannot hang on a biometric prompt nobody can answer; an interactive start can still prompt normally. Source: `apps/cli/src/lib/daemon.ts` (`getAgentsBinPath`, `readDaemonClaudeOAuthToken`), `apps/cli/src/lib/secrets/bundles.ts` (`agentOnly`). (RUSH-1527)

## 1.20.51

- **Fix: `agents run --lease` bootstraps a fresh crabbox image and no longer leaks the box after the run.** Three failures compounded on a stock Hetzner lease (Ubuntu 24.04, no node preinstalled): (1) the bootstrap's `npm install -g @phnx-labs/agents-cli` ran with no node/npm on the box and swallowed the failure with `|| true`, so every run died deep in the script with `agents: command not found` (exit 127) and no hint why; (2) even with the CLI installed, a fresh install refuses `agents run` with "agents-cli is not set up" until `agents setup` has run; (3) teardown called `crabbox stop --id <slug>`, but crabbox's `stop` takes a positional target (unlike `status`/`run`/`ssh`) and died with `flag provided but not defined: -id` — silently, because `crabboxStop` is best-effort — so every one-shot lease box was **kept, billed, and left carrying the run's working data** until someone noticed (`Box … kept` instead of destroyed). The bootstrap now: exports `~/.local/bin` onto PATH, installs node user-level from the official `latest-v22.x` tarball when missing (arch-aware, satisfies `engines.node >=22.5.0`, no sudo needed), points the npm prefix at `~/.local`, fails loud with exit 96 and a diagnostic when the CLI still isn't runnable, and runs `agents setup` behind the same `[ ! -d ~/.agents/.system ]` first-run guard the hosts bootstrap uses; `crabboxStop` passes the slug positionally. Verified live on a fresh Hetzner cpx62 by the run's own progression across builds: the pre-fix lease exited 127 (`agents: command not found`) with `Box … kept`; after the node/npm fix it reached `agents-cli is not set up`; after the setup fix it reached the agent's login check (`Not logged in`); and every post-fix run ends with `Box <slug> destroyed.` instead of leaking. Source: `apps/cli/src/lib/crabbox/lease.ts` (`ENSURE_AGENTS_CLI`, `buildBootstrapScript`), `apps/cli/src/lib/crabbox/cli.ts` (`crabboxStop`). Known follow-up: leasing a **Claude** runtime from a Mac whose Claude Code credential lives in the login Keychain (the default install, and any agents-cli managed home — service name is hash-suffixed) still lands "Not logged in" on the box, because the picker copies `~/.claude.json` (config/state) but not the OAuth token, and extracting the token from the Keychain needs an interactive ACL approval; tracked separately.
- **`agents repo pull user <git-url>` now git-backs a plain `~/.agents` instead of silently skipping it — fixing config sync on Windows/fresh machines.** Setup only ever git-clones the *system* repo (`~/.agents/.system/`); the user repo is created as a bare directory (`state.ts ensureAgentsDir`), so `~/.agents` is git-backed only where it was cloned by hand as a dotfiles step. On a box where that never happened (a fresh install, or Windows), `agents repo pull` just printed `user: not a git repo, skipping` and the machine silently fell out of config sync — no `rules/`, no `agents sync` of shared resources. Now, passing your config remote once — `agents repo pull user git@github.com:you/.agents.git` — **adopts** the existing directory in place: it clones your remote and moves the `.git` in without deleting anything, materializes the tracked resources it was missing, and **backs up any locally-modified tracked file** (e.g. a machine-specific `agents.yaml`) to a sibling `~/.agents.pre-adopt-backup/` before overwriting it. Untracked runtime state (`.cache/`, `.history/`, `.system/` — all gitignored) is never touched. Every subsequent `agents repo pull` / `agents sync` is plain (the remote is now `origin`). No new command; the URL is only needed the first time. SSH transport is preserved (a `git@…` URL clones over SSH, not a rewritten https that would hang on a private-repo credential prompt), and git never prompts (`GIT_TERMINAL_PROMPT=0`). Source: `apps/cli/src/lib/git.ts` (`adoptRepo`), `apps/cli/src/commands/repo.ts`.
- **`agents run` now warns when a headless run leaves committed-but-unpushed work, instead of stranding it silently.** A headless `agents run` in a writable mode (`edit`/`skip`/`auto`) could end with the agent having committed on a branch but never pushed it — the run's exit path did no git work, so those commits sat invisible in a worktree until someone audited the box (exactly how a batch dispatch loop can quietly lose a verified fix). After a non-interactive, writable run the CLI now inspects the cwd for commits on the current branch that haven't reached any remote (`git log HEAD --not --remotes`, correct even when no upstream is set — work already on an `origin/*` ref is not flagged) and prints a loud stderr warning naming the branch, the unpushed commits, and the exact `git push` / `gh pr create` commands. Advisory only: it never pushes, never mutates the repo, and never throws (a 5s git timeout plus full error-swallowing guarantee it can't delay or break the run's exit). The check is wired into every headless exit path — single run, `--loop`, `--acp`, `--resume-checkpoint`, and the crash/catch path — and gated by `shouldWarnUnpushed(mode, interactive)` so it stays silent for interactive runs (the human sees their shell) and read-only `plan` mode. Source: `apps/cli/src/lib/warn-unpushed.ts`, `apps/cli/src/commands/exec.ts`. (#868)
- **Codex mode flags now match what the mode names promise — only `--mode skip` is yolo.** `--mode edit` used to append `--dangerously-bypass-approvals-and-sandbox` (Codex's `--yolo`) alongside `--sandbox workspace-write`, and the bypass flag wins — so "edit" silently ran Codex with **no sandbox and no approvals**, verified against codex 0.142.5's own session banner (`sandbox: danger-full-access`). And `--mode plan` mapped to `workspace-write` (writable!) because the template predated Codex's `read-only` sandbox. Now: `plan` → `--sandbox read-only`, `edit` → `--sandbox workspace-write -c sandbox_workspace_write.network_access=true` (sandboxed writes, network on so git/gh/installs keep working, no approval bypass), `skip` → `--dangerously-bypass-approvals-and-sandbox` (unchanged — skip IS the gnarly mode, equivalent to `codex --yolo`). Same fix in routine jobs (`runner.ts`) and in headless `codex exec resume`, which used to get the bypass for ANY non-plan resume — it now maps plan/edit through `-c sandbox_mode=…` and reserves the bypass for skip; interactive `codex resume` now carries the mode's sandbox flags instead of none. Verified live per mode against codex 0.142.5 session banners: skip = `approval: never / sandbox: danger-full-access`, edit = `sandbox: workspace-write (network access enabled)`, plan = `sandbox: read-only`. Source: `apps/cli/src/lib/exec.ts` (`AGENT_COMMANDS.codex`, resume block), `apps/cli/src/lib/runner.ts` (`buildJobCommand`).
- **`--add-dir` is now forwarded to Codex (it was silently dropped).** `agents teams` passes `--add-dir ~/.agents` so Codex teammates can run `agents teams add`, but `buildExecCommand` emitted `--add-dir` for Claude only — the grant never reached Codex, masked until now by edit mode's accidental sandbox bypass. Codex takes `--add-dir` natively (widens the workspace-write sandbox); it is now forwarded for fresh runs and skipped on resume (`codex exec resume` rejects it). Source: `apps/cli/src/lib/exec.ts`.
- **Fix: the documented `agents run <agent> [prompt] -- <native flags>` passthrough works again.** commander ≥13 rejects excess operands by default, so any post-`--` token (e.g. `agents run codex -- --yolo`) died with `too many arguments` before the run started. The run command now allows excess operands, re-derives the `--` boundary from argv (a post-`--` token can never be mis-parsed as the prompt — `agents run codex -- --yolo` launches the TUI with `--yolo`, it doesn't headless-run the "prompt" `--yolo`), and still errors, with a hint to quote the prompt, on excess operands NOT behind `--`. Verified live: `agents run codex "…" -- --yolo` forwards `--yolo` and codex reports `sandbox: danger-full-access`. Source: `apps/cli/src/commands/exec.ts`.

- **Fix: grok launch shims resolve the binary from the versioned home before the global `~/.grok/downloads`, so a pinned grok that installed into the versioned home no longer dies with "grok@<version> not installed."** Grok ships a native binary (not an npm package), and it lands in the versioned home's `.grok/downloads` whenever the installer runs with `GROK_HOME` set — via the shim, a correct `agents add grok`, or a grok self-update from within the shim. Both generated shims (the dispatcher in `generateShimScript` and the `grok@<version>` versioned alias in `generateVersionedAliasScript`) checked only `$HOME/.grok/downloads`, which was often empty, so they fell through to the "not installed" error even though the binary existed in the versioned home. `getBinaryPath` already checked the versioned home first, so `agents view` and the shims disagreed. Both shim blocks now check `$VERSION_DIR/home/.grok/downloads` first and fall back to the global `$HOME/.grok/downloads` for pre-fix installs, then the existing adopted-launcher/PATH last resort. Bumps `SHIM_SCHEMA_VERSION` 25→26 and `VERSIONED_ALIAS_SCHEMA_VERSION` 12→13 so existing on-disk grok shims regenerate. Supersedes the pre-monorepo #830. Source: `apps/cli/src/lib/shims.ts` (`generateShimScript` grok dispatcher block, `generateVersionedAliasScript` `binaryResolution`).
- **Fix: `browser stop --host <windows>` tree-kills the remote browser — relaunches never wedge on a stale `SingletonLock`.** The kill script used `Stop-Process` on the CDP port owner only; orphaned Chromium child processes survived, kept the profile's `SingletonLock` held, and the next `browser start --host` against the same profile exited immediately as a second instance. The script now uses `taskkill /PID <owner> /T /F` to take down the whole process tree. Source: `apps/cli/src/lib/browser/drivers/ssh.ts` (`buildWindowsKillScript`). (GitHub #561)
- **Fix: `agents browser start --host <windows>` actually serves CDP now — the remote browser launches in the user's interactive session instead of session 0.** The Windows launch used WMI `Win32_Process.Create` (chosen so the browser outlives the ssh session), but a WMI-created process lands in session 0, where Edge binds the debugging port yet its DevTools server never initializes — every `/json/version` probe hung forever and `DevToolsActivePort` was never written, so `browser start --host` failed with a connection error on every attempt. The launch is now a one-shot scheduled task registered and started by the logged-on user: it survives ssh disconnect the same way, runs in the interactive session where DevTools comes up normally, and is unregistered immediately after start. The launch args also gained the same automation-modal suppressors the local launcher has (`--no-first-run --no-default-browser-check --hide-crash-restore-bubble --disable-session-crashed-bubble`) — without them a relaunch against a previously hard-killed profile triggers session-restore churn that closes the CDP page target mid-command. Verified live against win-mini (Edg/150). Source: `apps/cli/src/lib/browser/drivers/ssh.ts` (`buildWindowsLaunchScript`). (GitHub #561)
- **Fix: remote CDP no longer dies on large payloads — screenshots of content-rich pages over `browser --host` work.** The CDP client rode the platform (undici) WebSocket, which enforces a non-configurable max decompressed message size; a `Page.captureScreenshot` response for a content-rich page blew past it and the socket closed with 1006 ("Max decompressed message size exceeded") while the command was pending, surfacing as "CDP connection closed". The websocket transport now uses the `ws` client (no permessage-deflate offer by default, explicit 256MB `maxPayload`); the local pipe transport is unchanged. Source: `apps/cli/src/lib/browser/cdp.ts`. (GitHub #561)
- **`agents sessions <id> --json` now exposes the ExitPlanMode plan markdown as a top-level field, and the shape changed from a bare event array to `{ session, events }`.** The session-state engine already detected plan-review (`awaitingReason: 'plan_review'`) off a trailing `ExitPlanMode` tool call, but the plan markdown itself was dropped on the floor — forcing every consumer that wanted it (the Factory NEEDS-YOU panel via `parsePlanFromClaudeJsonl`, external dashboards) to re-open the raw JSONL and scan for the same tool call. That "extension re-implements the session engine" gap now closes at the source: the state engine surfaces `state.plan` alongside `awaitingReason`, the Claude scanner captures the plan text at scan time and persists it to `sessions.db` (schema v11, additive, rescan-on-migrate), it's exposed as `plan` on `SessionMeta` in every `agents sessions --json` row, and `agents sessions <id> --json` now emits `{ session: SessionMeta, events: SessionEvent[] }` so the plan is one top-level `output.session.plan` read instead of a needle-in-haystack scan. Verified live against a real Claude session with an ExitPlanMode event: `agents sessions 74464df7 --json` prints the plan markdown at `.session.plan`. Source: `apps/cli/src/lib/session/{state,discover,db,render,types}.ts`, `apps/cli/src/lib/session/active.ts`, `apps/cli/src/commands/sessions.ts`. (issue #743 / RUSH-1505)
- **`agents computer` Windows parity: scoped screenshots, `get-text --max-chars`, `status`/`reload --host`, and honest `--background`/`--require-frontmost` handling (#548).** Four params the CLI already sent were silently ignored by the Windows daemon. (1) **Screenshots are now pid-scoped like macOS** — `screenshot --list` enumerates the target pid's top-level windows (`window_id` is the Win32 HWND, the same id `raise --window-id` takes), the default capture crops to the pid's largest on-screen window, `--window-id` shoots one window, and `--display` captures the display the app is on; previously every capture was the whole virtual desktop. Verified live on win-mini: window capture 2097x984/28KB vs full display 2560x1440/380KB. (2) **`get-text --max-chars` is honored** (default stays 20k, ceiling 200k like macOS) — `--max-chars 100` now returns exactly 100 chars. (3) **`status --host <device>` and `reload --host <device>`** — status reports the recorded tunnel plus a live daemon probe (previously it misreported macOS-local install state for a remote Windows daemon); reload restarts the daemon's scheduled task (the way to pick up a freshly pushed exe) and confirms it answers through the tunnel. (4) **`--require-frontmost` is enforced on Windows** — `SendInput` lands in the *focused* window, so `type-text`/`key` now report `frontmost` (feeding the existing CLI warning) and the flag hard-fails with `not_frontmost` when the target isn't foreground; **`--background` is rejected** with `action_unsupported` instead of silently no-oping (macOS postToPid delivery has no Win32 analogue — element-mode clicks via UIA patterns are the focus-safe path). Source: `native/computer-win/{Screenshot,Automation}.cs`, `apps/cli/src/commands/computer.ts`, `apps/cli/docs/computer.md`.
- **The `never` prompt-policy is now live — the signed keychain helper was rebuilt, re-notarized, and re-pinned.** `agents secrets create --policy never --i-understand` stores bundle values with no biometry ACL (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, device-local, non-synchronizable) so headless automation can read them with zero Touch ID prompts. The Swift `set-no-acl` path shipped in #682 but the pinned helper binary predated it, so the policy failed against the shipped helper; the helper is rebuilt from current source, notarized (Apple submission `a2373c91-7fc2-4894-a801-b37c111597aa`, status Accepted, stapled, Gatekeeper `Notarized Developer ID`), and `scripts/Agents CLI.app.sha256` re-pinned to the new binary. (GitHub #421)
- **Consolidated ~30 copy-pasted terminal-formatting helpers into one shared `apps/cli/src/lib/format.ts`, fixing three user-visible drifts at the source.** `die`, `truncate`, `relTime`, `humanDuration`, `visibleWidth`, `padRight`/`padVisible`, `isJsonMode`, `readStdinSync`, and `termLink` had drifted into per-command copies with different behavior; every consumer now imports the single canonical version. Three normalizations are user-visible: (1) the truncation ellipsis is now the single glyph `…` everywhere — `agents cloud` task lists, `agents sessions` overflow, and session prompt/tool summaries previously showed ASCII `...` or a bare `.`; (2) `agents cloud` relative timestamps switch from the long "5 minutes ago" form to the compact "5m ago" form already used by `agents teams`; (3) the `agents teams` picker duration cell gains a space ("2h5m" → "2h 5m") to match the sessions/browser pickers. It also fixes a latent bug: `agents repo`'s divergence-table column alignment used a `visibleWidth` regex missing its `\x1b` escape, so ANSI-colored cells were mis-measured and columns could misalign — the canonical `visibleWidth` strips the full SGR sequence. `lib/events.ts`'s `truncate` (a distinct nullable, exported helper that truncates persisted event payloads) and the domain-specific `statusColor` copies (different status vocabularies with conflicting color assignments) are deliberately left in place. Internal refactor plus the noted string normalizations; no other behavior change. Source: `apps/cli/src/lib/format.ts` and consumers across `apps/cli/src/commands/` and `apps/cli/src/lib/`. (GitHub #753 / RUSH-1515)
- **`agents computer setup --host` now works from a plain `npm i -g` install — the Windows helper exe downloads on demand from GitHub releases.** The ~157MB `computer-helper-win.exe` never shipped in the npm tarball, so setup died with "Windows helper exe not built. Run: bash scripts/build-win.sh" for anyone without a repo checkout. On `v*` tags the `computer-helper-win.yml` workflow now builds the self-contained exe, smoke-tests it, and uploads it plus a `.sha256` as GitHub release assets; `setup --host` resolves a local build first, then downloads the asset for the exact running CLI version, verifies its sha256 against the published checksum, and caches it under `~/.agents/.cache/computer/win-helper/v<version>/`. A tag with no asset is a hard error naming that tag — never a silent fallback to a different release. (GitHub #547) Source: `apps/cli/src/lib/ssh-tunnel.ts` (`ensureWinHelperExe`, `downloadWinHelperExe`), `.github/workflows/computer-helper-win.yml` (`release-exe`).
- **`registerMcp` HTTP transport now routes through the capability table instead of an inline agent-id allowlist.** MCP-over-HTTP support and MCP-header support were gated by hardcoded `agentId !== 'claude' && agentId !== 'codex' && agentId !== 'gemini'` / `agentId !== 'claude'` checks in `apps/cli/src/lib/agents.ts`, bypassing the `capabilities.ts`/`supports()` table that is the single source of truth for "which agent supports what." A newly-added agent would silently get the wrong HTTP-MCP behavior with no compile-time signal. Two new capabilities land on the `AgentConfig` matrix — `mcpHttp` (Claude/Codex/Gemini today) and `mcpHeaders` (Claude only) — and both inline allowlists are replaced with `supports(agentId, cap)` calls. Pure refactor: `capableAgents('mcpHttp')` is `['claude','codex','gemini']` and `capableAgents('mcpHeaders')` is `['claude']`, matching the pre-change behavior exactly. Source: `apps/cli/src/lib/{agents,capabilities,types}.ts`, `apps/cli/src/lib/{agents,capabilities}.test.ts`, `apps/cli/src/lib/__tests__/capabilities.test.ts`. (issue #742 / RUSH-1504)
- **Hook `matches:` predicates are now enforced at fire time — the documented gating was inert.** A hook manifest entry could declare `matches:` predicates (`prompt_contains` / `prompt_matches` / `tool_name` / `tool_args_match` / `cwd_includes` / `project_has` / `git_dirty`) to gate when it fires, and the docs described the gate ("all predicates AND together; an empty block always fires"), but `shouldFire()` (the evaluator in `src/lib/hooks/match.ts`) had **zero runtime callers**: the agent execs the registered command directly and nothing evaluated `matches:`, so any hook with a `matches:` block fired unconditionally. A hook that declares `matches:` (with or without `cache:`) is now registered as a generated wrapper shim that evaluates the predicates against the event JSON on stdin before running the script — a non-matching event exits 0 without running the hook body (logged as `cache:"skip"`), a matching event runs it. Matches-only hooks (no `cache:`) get a gate-only pass-through shim; cached hooks apply the gate before the cache. The shim gate is a faithful port of `shouldFire()` (same AND semantics, same ReDoS guard) and is pinned to it by a 20-case conformance test so the two can't drift. Gating is fail-open: a garbled predicate runs the hook rather than silently disabling a safety hook (e.g. `git-guard`). No installed or bundled hook currently declares `matches:`, so this changes no existing hook's behavior — it activates a documented feature for authors who add one. Verified end-to-end by generating a shim from a `matches: { tool_name: Bash, tool_args_match: "rm -rf" }` manifest and firing it: a `Read` event and a `Bash`+`ls` event were skipped, a `Bash`+`rm -rf` event ran the body. Source: `apps/cli/src/lib/hooks/cache.ts` (`renderShim` gate + pass-through tail), `apps/cli/src/lib/hooks.ts` (`resolveHookCommand`), `apps/cli/docs/hooks.md`. (RUSH-1506)
- **Browser-over-SSH no longer hangs on an unreachable remote host — it fails fast (~10s).** The raw-`ssh` spawns in the browser SSH driver (`ensureRemoteBrowser`, `runSSHCommand`) passed only `-o BatchMode=yes`, with no `ConnectTimeout`, so a dropped SYN to a down host stalled on the OS default TCP timeout (~127s) instead of erroring. Both call sites now compose the shared hardened baseline `SSH_OPTS` from `ssh-exec.ts` (`BatchMode` + `ConnectTimeout=10` + `ServerAlive` keepalive) rather than re-listing options — the same baseline `sshExec` and the `-L` tunnel already use. The options now also precede the target (matching `sshExec`); on macOS/BSD `getopt` an option placed after the target is swallowed into the remote command instead of applied. Verified against TEST-NET `203.0.113.1` (guaranteed unreachable): `-o BatchMode=yes` alone was still hanging at a 30s cap (en route to ~127s), while the `SSH_OPTS` set failed in `10.04s` with `connect to host 203.0.113.1 port 22: Connection timed out`. Source: `apps/cli/src/lib/browser/drivers/ssh.ts`. (RUSH-1508)
- **Fix: OpenCode sessions now load on Windows.** Reading OpenCode sessions shelled out to the `sqlite3` CLI at three call sites — `parseOpenCode` (transcript parse) plus the session scan and active-account lookup in discovery — and that binary is absent on Windows, so OpenCode sessions silently never appeared in `agents sessions` there. All three now read through the same runtime-aware node/bun `Database` wrapper the Antigravity parser already uses (`bun:sqlite`/`node:sqlite`, no native addon, no CLI), and the OpenCode transcript query binds the session id as a parameter instead of interpolating it. No behavior change on macOS/Linux. Source: `apps/cli/src/lib/session/parse.ts` (`parseOpenCode`), `apps/cli/src/lib/session/discover.ts` (`scanOpenCodeIncremental`, `getOpenCodeAccount`). (RUSH-1513)
- **`agents sessions --active --json` now carries the agent's actual decision, not a truncated status line.** A session waiting on you used to collapse everything to a one-line `preview` — an `AskUserQuestion` became the generic `"Asked you a question"` (throwing away the options that are already in the tool input), and a trailing thinking block masked the real turn as `"thinking…"`. The state engine now emits a structured `question` object (`{ text, reason, options: [{ label, description, key }] }`) for every waiting path — `AskUserQuestion` (with each option's 1-based select key), plan review, permission (Approve=`1` / Deny=`esc`), and a trailing prose question — plus a short assistant `tail` for context, and `preview` no longer degrades to `"thinking…"` when a real turn exists. Every consumer (the Factory NEEDS-YOU panel, teams, cloud) now gets the real "what does it want from me" instead of re-deriving it from prose. Verified live: the blocked session in the screenshot now reports `awaitingReason: question` with the real question text. Source: `apps/cli/src/lib/session/state.ts` (`structuredQuestionFromAsk`, `inferActivity`), `apps/cli/src/lib/session/active.ts`. (RUSH-453)

## 1.20.50

- **Distributed agent teams: teammates can now run on different machines across your fleet, not just the box running `teams start`.** A single team can place the backend teammate on a Linux box and the UI teammate on a Mac while one orchestrator still drives the DAG, polls status, and cleans up. One vocabulary, all optional (omit it and teams stay 100% local as before): `teams create --devices a,b,c` (alias `--hosts`) declares a pool the team may auto-schedule onto, `--repo <url|path>` (defaults to the local checkout's `origin`) says how each device gets the code, and `teams add --device X` (alias `--host`) pins one teammate to a host — which needs **no** pool, so "send just one teammate elsewhere" is zero-setup. Placement resolves top-down at launch: explicit `--device` pin → single-device pool (whole team there) → multi-device pool (least-loaded auto-schedule) → local. Remote teammates dispatch over SSH via the existing `agents devices`/host machinery (a third teammate backend beside local and cloud), are monitored by offset-tailing the remote log + `.exit` sentinel, and get the repo auto-provisioned per device (reuse an existing checkout, else clone into `~/.agents/repos/<team>`) with an optional per-teammate git worktree on the host. `teams status`/`teams logs` show each teammate's host and stream its output back with the local mirror capped (~512KB rolling tail) so a 10+-teammate fleet can't blow up the orchestrator. POSIX hosts only in v1 (Windows rejected with a clear message). Source: `apps/cli/src/lib/teams/{scheduler,remoteWorktree,agents,api,supervisor,registry}.ts`, `apps/cli/src/lib/hosts/{progress,passthrough}.ts`, `apps/cli/src/commands/teams.ts`, `apps/cli/docs/teams.md`.
- **NEW: `agents doctor --devices` shows a cross-device agent-readiness matrix.** `agents doctor` could already run on one remote machine via `--host`, but checking the whole fleet meant running the command once per box. `--devices` fans out `agents teams doctor --json` to every registered device (plus the local machine), renders a device × agent matrix, and emits a stable JSON contract with `--json`. `--device <name>` or `--host <name>` scopes the same matrix to a single machine. The remote probe now bootstraps `PATH` with the canonical shim directories before running, so login shells that haven't sourced interactive rc files no longer report false "not installed" negatives. Source: `apps/cli/src/commands/doctor.ts`, `apps/cli/src/lib/teams/agents.ts`, `apps/cli/src/lib/hosts/{passthrough,remote-cmd}.ts`.
- **`agents run codex` / `agents teams` now honor your configured Codex model instead of silently defaulting to `gpt-5.3-codex`.** Codex runs under a per-version `CODEX_HOME`, and your `model` preference (`~/.codex/config.toml`) lives only in the version-home that was active when you set it. A dispatch pinned to a different version read a home with no top-level `model`, so Codex fell back to its built-in default — which a ChatGPT-tier account isn't entitled to use, so the run died with `400: The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account` before doing any work, even though `ag view` reported Codex "signed in". When no explicit `--model` is passed, the model is now defaulted (for Codex) to the top-level `model` in your active `~/.codex/config.toml` and forwarded via `--model`; it's read-only (no file writes), so fanning out many parallel runs to one version-home can't race. Verified live on a box where Codex was 100% unusable: the request model changed `gpt-5.3-codex` → `gpt-5.5` and codex@0.142.0 returned successfully. Source: `apps/cli/src/lib/exec.ts`, `apps/cli/src/lib/shims.ts` (`readCodexConfiguredModel`).
- **Fix: `agents add claude@<version>` now produces a runnable install — it no longer ships a half-built binary that dies with "claude native binary not installed."** `installVersion` runs `npm install --ignore-scripts` (the right posture for the dependency *tree* — never run arbitrary transitive postinstalls), but that also skipped the agent package's OWN postinstall, which for `@anthropic-ai/claude-code` is a required step: the package ships a ~500-byte stub at `bin/claude.exe` plus per-arch native binaries as optional deps, and its `postinstall` (`node install.cjs`) is what copies the correct ~231 MB native binary over the stub. Skipped, every launch died with `Error: claude native binary not installed`. The existing launch-health self-heal (#764, and its Windows/daemon extension) couldn't save it on two counts: the stub reports its breakage *politely* rather than with a raw `ENOENT`, so the probe's missing-binary signature didn't match and the gutted install read as healthy; and the repair path (`ensureAgentRunnable` → clean reinstall) re-ran the same `--ignore-scripts` install, so it never copied the binary either. `installVersion` now runs the **first-party** package's declared `postinstall` after the npm install (scoped to that one package — never the dependency tree, never claude-code's `exit 1` `prepare` guard), best-effort, before the integrity gate. Because `installVersion` is the single choke point for `agents add`, config refresh, run-time heal, and the daemon's proactive heal, this also revives the repair path for the whole class. `isMissingBinarySignature` was additionally widened to recognize the stub's polite phrases (`native binary not installed`, `postinstall did not run`, `optional dependency was not downloaded`) so the self-heal catches this failure mode if a postinstall ever silently no-ops. Verified end-to-end on linux-arm64: `installVersion('claude','2.1.186')` into a clean HOME runs the postinstall automatically, lands the 231,782,112-byte binary (not the stub), and `claude.exe --version` returns `2.1.186 (Claude Code)` — with no manual `install.cjs` step. Source: `apps/cli/src/lib/versions.ts` (`installVersion`, `isMissingBinarySignature`).

## 1.20.49

- **`agents run --mode plan` no longer hard-fails on agents without a read-only mode (antigravity, cursor, kiro, …).** Those agents have no plan flag, so an explicit or default `--mode plan` used to abort with `does not support 'plan' mode` — breaking multi-agent scripts that pass a uniform plan flag, and diverging from `agents teams add` (default mode `edit`). `resolveMode` now degrades unsupported `plan` to the agent's safest native mode (`capabilities.modes[0]`, typically `edit`), matching the existing `auto` → `edit` degrade. The CLI prints a yellow warning when the user explicitly asked for plan (gray for the implicit default) so the elevation is never silent. `skip` still hard-fails when unsupported. Source: `apps/cli/src/lib/exec.ts`, `apps/cli/src/commands/exec.ts`.
- **`agents cloud cancel` now actually cancels paused runs.** `RushProvider.cancel()` issued `DELETE /api/v1/cloud-runs/{id}`, which the backend doesn't implement — it 404s — so `agents cloud cancel` (and the Factory Floor's cancel affordance) silently failed on any run that wasn't actively running: `queued`, `needs_review`, and `input_required` runs stayed stuck (e.g. a 14-day-old input-required run lingering in the Floor's "NEEDS YOU" bucket forever). Switched to the cancel action endpoint `POST /api/v1/cloud-runs/{id}/cancel`, which the backend implements and which cancels paused runs too. Verified live against `api.prix.dev` (the POST returned `{"ok":true,"status":"cancelled"}` and the stuck run transitioned `needs_review` → `cancelled`). Source: `apps/cli/src/lib/cloud/rush.ts`.

## 1.20.48

- **Menu-bar helper: a RECENT TICKETS section shows the issues you filed via the quick-issue bar, each clickable to open in Linear.** The completion notification is transient, so the tickets the `Cmd-Shift-O` bar creates now also persist to a small local ledger (`~/.agents/.history/menubar/recent-tickets.json`, newest-first, deduped by id, capped at 10) that the menu-bar dropdown surfaces below RECENT sessions — click a row to open the ticket. The dispatch records the id + note + Linear URL on a successful create; the section renders nothing when the ledger is empty. Source: `apps/cli/menubar/Sources/MenubarHelper/{RecentTickets,StatusItemController,AgentsCLI,IssueSelfTest}.swift`.
- **Menu-bar helper: the quick-issue completion notification now deep-links to the created ticket, and the helper self-heals onto the install you actually run.** Two fixes from dogfooding the `Cmd-Shift-O` bar. (1) **Clickable notification** — the "Created RUSH-####" banner carried no click target, so there was no way to open the ticket. The ticket agent now also prints the issue's `URL:` line, the helper parses it, and clicking the notification (or its **Open** button) opens the ticket in Linear (via an `NSUserNotificationCenterDelegate`; the banner is also force-presented so it can't be silently swallowed when the accessory app is frontmost). (2) **Dual-install self-heal** — the helper bakes the node interpreter + CLI entry into its launchd plist so a GUI process can find `agents` without a login PATH, but the staleness check only re-baked on a *version* change. With two installs present (e.g. an nvm copy and a bun copy), the plist kept pointing at whichever copy first wrote it, so the menu data **and** the quick-issue dispatch ran on a stale install even after `agents upgrade`. The startup self-heal now also re-points when the plist's baked `AGENTS_ENTRY`/`AGENTS_NODE` no longer match the install currently running `agents` (a null active entry — a dev/tsx run — never churns the plist). Source: `apps/cli/menubar/Sources/MenubarHelper/{PromptPanel,AgentsCLI,IssueSelfTest}.swift`, `apps/cli/src/lib/menubar/install-menubar.ts`.
- **The npm release can now be driven from a Linux box** by offloading the Mac-only helper signing to a remote sign host. The tarball bundles two signed macOS `.app` helpers a Linux runner can't build — `bin/Agents CLI.app` (the keychain helper: `swiftc` universal → codesign with entitlements + embedded provisioning profile → `notarytool` → staple) and `bin/MenubarHelper.app` (the menu-bar status item: `swift build` → codesign, no notarization) — which is the only reason publishing was macOS-pinned. New `scripts/remote-sign-mac.sh` (invoked automatically by `release.sh` when it runs on a non-macOS host and the signed apps are absent, or on any host with `FORCE_REMOTE_SIGN=1`) rsyncs the build inputs to `${SIGN_HOST:-mac-mini}`, runs both Mac build scripts there under the appliance's headless signing creds (unlocks `rush-signing.keychain-db`, injects Apple notary creds via the `apple.com` secrets bundle), then pulls the signed `bin/*.app` back and re-verifies the keychain sha locally. The `build` script now copies the helpers into `dist/` on a **presence** gate (`[ -d 'bin/…' ]`) instead of `[ "$(uname)" = 'Darwin' ]`, so a Linux box that pulled the pre-signed bundles packages them, and `prepack`'s sha gate uses `shasum` or `sha256sum` (whichever is present) so it works on Linux too. Override the sign host with `SIGN_HOST` and its checkout with `SIGN_HOST_REPO`. Source: `apps/cli/scripts/remote-sign-mac.sh`, `apps/cli/scripts/release.sh`, `apps/cli/scripts/verify-keychain-helper.sh`, `apps/cli/package.json`.

- **The shim self-heal now repairs shims that point at a *removed* install and prunes orphaned command shims.** A dispatch shim bakes its `AGENTS_BIN` (the agents-cli entrypoint it execs) at generation time, so when that install moves or is deleted — a dev build under `~/.local/agents-cli-dev`, an old npm-global under `/opt/homebrew`, a rotated version dir — the shim keeps pointing at the dead path. Agent shims survive it via their runtime self-recovery block, but the previous self-heal only compared the *schema marker*, so a schema-current shim aimed at a removed install read as healthy and was never repaired. Two additions to the `shims` self-heal check (daemon + interactive startup): (1) **drift repair** — an agent shim whose baked `AGENTS_BIN` names a *different, now-missing* install is force-regenerated to the current install (`shimPointsAtLiveInstall`); a shim pointing at another install that still exists is left alone, so two live installs sharing the shims dir can't ping-pong. (2) **orphan prune** — legacy standalone command shims (`browser`/`secrets`/`sessions`/`teams`/`pty`) that a removed install left in the shims dir, which the current source never regenerates and which either die with `exit 127` or shadow the real package bin on PATH, are removed when their baked install is gone (`pruneOrphanedCommandShim`); user `agents alias` shims and any shim whose install still exists are spared. Verified end-to-end against a real machine carrying a deleted dev build + a removed Homebrew install: the agent shims repoint to the live install and five dead command shims are pruned. Source: `apps/cli/src/lib/shims.ts` (`shimPointsAtLiveInstall`, `pruneOrphanedCommandShim`, `listShimFileNames`), `apps/cli/src/lib/self-heal/checks/shims.ts`.
## 1.20.47

- **Quick-issue bar (`Cmd-Shift-O`): `Cmd-V` now pastes into the note field, and double-clicking a screenshot thumbnail opens it in Preview.** Two fixes from dogfooding the new bar. (1) The panel is a borderless `.accessory` window with **no main menu**, so the standard clipboard key-equivalents (`Cmd-V`/`C`/`X`/`A`) were never dispatched to the field editor — paste silently did nothing. `PromptPanel.performKeyEquivalent` now routes them through the responder chain so the text field handles them. (2) Thumbnails are small, so there was no way to confirm which screenshot you were attaching: **single click still toggles selection, double click opens the full image in the default viewer (Preview)**. The single-click toggle is deferred by the double-click interval so a double-click previews without also flipping the selection, and the bar suppresses its own click-outside dismissal while Preview takes focus (so summoning Preview never closes the bar or drops your typed note; it re-arms when the bar regains focus). Source: `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`.
- **Fix: the headless file-store fallback no longer silently shadows the OS keyring; NEW `agents secrets import-keyring` migrates stranded secrets into it.** On headless Linux/Windows the encrypted-file store is *sticky* — once any item is on disk, `preflight()` routed **every** op to the file store and never consulted GNOME Keyring / Windows Credential Manager again, so a secret written earlier into the native store (e.g. while a desktop keyring was unlocked) read back **empty** with no hint. This stranded real Linear CLI credentials in a locked keyring while other bundles lived in the file store, silently breaking the SessionStart hook. Two fixes: (1) `get`/`has` now **read through** to the native store on a file-store *miss* (the fast path and the non-fallback keychain-first path are untouched — the file store is still checked first), emitting a one-time stderr notice pointing at `import-keyring`; once a locked/`1312` error is seen the store is marked unreachable so it stops re-probing a known-dead store. (2) NEW **`agents secrets import-keyring`** — the Linux/Windows analogue of the macOS `migrate-acl`/orphan sweep — enumerates `agents-cli` items in the native store and copies them into the encrypted file store (the durable, passwordless headless backend). Dry-run by default; `--commit` writes; existing file-store items are never overwritten; Windows enumeration is floored to the `agents-cli.` namespace since Credential Manager targets have no service scoping. macOS is unaffected (it has no file fallback and keeps `migrate-acl`). Source: `apps/cli/src/lib/secrets/{fallback,linux,windows,index}.ts`, `apps/cli/src/commands/{secrets-import,secrets}.ts`, `apps/cli/docs/secrets.md`.
- **Launch-health self-heal now covers Windows, and the daemon repairs a gutted install proactively — before your next `agents run`.** #764 gave `agents run` an install/run-time self-heal (probe `<binary> --version`; clean-reinstall in place, else fall back to another installed version that launches), but it **skipped the probe on Windows** — `verifyInstalledBinaryLaunches` returned healthy on `win32` unconditionally, because probing the extensionless `.bin/<cli>` wrapper would ENOENT even on a *healthy* install. So the exact Windows failure the self-heal was built for went unhealed: a vendor auto-update renames the native `claude.exe` to `claude.exe.old.<epochMs>` and never lands the replacement, leaving the shim chain intact but pointing at a missing file, and every launch dies with `'…claude.exe' is not recognized`. The probe now runs on Windows against the **real launch target** — the npm `.cmd` wrapper `agents run` actually execs (`getBinaryPath + '.cmd'`, resolved via `cmd.exe`), which chains to the native `.exe` — so a gutted install trips the existing missing-binary signature (`is not recognized`) and is repaired by the same `ensureAgentRunnable` machinery; a missing `.cmd` (a non-npm/global agent like `droid.exe`) is still treated as healthy so a good install is never destroyed. Separately, the **daemon** now runs a proactive launch-health pass (`healBrokenDefaultLaunches`) ~90s after startup and every ~6h: it probes each agent's default version and, if it won't launch, repairs it in the background — so a gutted install is fixed *before* the next `agents run` hits the ENOENT, not at spawn time (the run-time `ensureAgentRunnable` only fires once a run is already starting). Verified end-to-end on a real Windows host: renaming `claude.exe` to `.old` makes the `.cmd` probe emit `is not recognized`; restoring it returns `2.1.191 (Claude Code)`. Source: `apps/cli/src/lib/versions.ts` (`verifyInstalledBinaryLaunches`, `healBrokenDefaultLaunches`), `apps/cli/src/lib/daemon.ts`.

## 1.20.45

## 1.20.46

- **NEW: `Cmd-Shift-O` opens a Spotlight-style quick-issue bar in the menu-bar helper — type a sentence, attach recent screenshots, and an agent files the Linear ticket for you.** The menu-bar helper already turned a screenshot into a `<host>:<path>` token with `Cmd-Shift-V` (clip capture), but there was no path from "I see a bug" to "a triaged ticket exists." The new chord summons a borderless panel (a thin capture surface, not another form): you type a one-line note, optionally toggle one or more recent screenshots (from the system screencapture folder, CleanShot's export path, or the clip history) as a thumbnail strip (the newest is pre-selected when it's fresh), and hit Return. It then **dispatches a headless agent** (`agents run claude --mode auto`, isolated behind one `AgentsCLI.dispatchTicketAgent` call so a cloud pod is a later swap) that reads the screenshots, runs `agents sessions` to identify which repo/project this concerns, does a brief investigation for real context, and files the ticket via `~/.agents/skills/linear/scripts/linear create` with an honest priority + a `repo:<name>` label — no preview step, the panel closes immediately and a notification reports the created `RUSH-####`. Focus is handled for a no-Dock `.accessory` app (`NSApp.activate` → `makeKeyAndOrderFront` → `makeFirstResponder`, with a borderless `NSPanel` overriding `canBecomeKey`; click-outside dismissal is armed only after the summon settles so the activation race can't self-dismiss the panel). The `Cmd-Shift-V` clip hotkey is unchanged — the Carbon hotkey manager now demultiplexes both chords by `EventHotKeyID.id` through one installed handler. Self-test: `MENUBAR_ISSUE_TEST=1 MenubarHelper` exercises screenshot selection, ticket-id parsing, and the meta-prompt contract; `MENUBAR_PROMPT_PREVIEW=1` renders the panel without the global hotkey for QA. Source: `apps/cli/menubar/Sources/MenubarHelper/{PromptPanel,Hotkey,AgentsCLI,main,IssueSelfTest,Clip}.swift`.
- **NEW: a unified self-heal subsystem — the shim/PATH "repair" notice no longer nags on every terminal, and the daemon now heals shim drift in the background.** agents-cli had accumulated ~37 separate repair routines scattered across the daemon, every CLI startup, and a handful of commands, each hand-rolling its own detect+fix on its own trigger. The most visible symptom: the interactive shim bootstrap (`maybeBootstrapShimIntegration`) regenerated shims, adopted shadowing launchers, and offered to add the shims dir to PATH **in the foreground on every invocation**, suppressed only by a `process.ppid`-keyed temp sentinel — so a new terminal re-ran the whole detect-and-nag, and the underlying condition was never permanently fixed. This lands a single `HealCheck` registry (`lib/self-heal/`) with one runner (`runSelfHeal`) driven by two front doors — the daemon (on its existing ~30s-after-start + ~6h `safe`-mode cycle) and the interactive startup — sharing the same checks: `shims` (regenerate stale shims/aliases), `shadowing` (adopt symlink launchers; report real-binary shadows), `path` (add the shims dir to PATH once), and `resources` (the existing `heal()` engine, wrapped unchanged). The daemon's heal cycle now runs all four in `safe` mode (low-risk fixes silently; risky ones reported), replacing the resource-only `heal()` call — and drops the desktop toast for background heals (the log is the record). The interactive startup now heals **silently** and prints at most a **persistent, once-per-condition** notice (`lib/shim-heal.ts`, keyed to a signature of the actionable state under `~/.agents/.cache/state/shim-notice.json`) for what a machine genuinely can't fix for you — a real native binary shadowing the shim — instead of re-nagging every shell. What changes is *where* the repairs run (background/silent) and *how often* you hear about them (once, not every terminal). Source: `apps/cli/src/lib/self-heal/` (new), `apps/cli/src/lib/shim-heal.ts` (new), `apps/cli/src/lib/daemon.ts`, `apps/cli/src/index.ts`, `apps/cli/src/lib/shims.ts` (`isShimCurrent` exported).
## 1.20.45
- **NEW: `agents run <agent> --host <name>` without a prompt forwards your TTY over SSH and runs the agent interactively on the remote host.** Previously `--host` runs required a prompt and were always headless (`agents run <agent> "<task>" --host <name>`). Now, omitting the prompt takes the interactive path: when local stdin is a TTY, the local CLI SSHes with `-tt`, runs `agents run <agent>` on the host, and lets the remote machine's `agents` start its normal tmux wrapper. The tmux session lives on the remote box, so detaching (`Ctrl-b d`) ends the SSH connection but keeps the agent running; you can reattach from the host or resume by session id. Session ids for Claude are still minted up front so `agents sessions` can surface and resolve the remote run. `--no-follow` is rejected for interactive host runs (it is meaningless for an attached TTY), and `--mode`, `--model`, `--name`, passthrough args after `--`, and `--raw`/`--no-tmux` are forwarded to the remote invocation. Source: `apps/cli/src/commands/exec.ts`, `apps/cli/src/lib/hosts/dispatch.ts`, `apps/cli/src/lib/hosts/session-index.ts`, `apps/cli/docs/hosts.md`.
- **`agents secrets export --host` now works against Windows targets, and a new `agents secrets unlock --host` unlocks a bundle on a remote machine.** The export push was POSIX-only (`bash -lc`, `--from /dev/stdin`, `create … || true`, `IFS= read`), so a Windows remote died with `'true' is not recognized … cannot find the path specified`. Two changes fix it: `agents secrets import` now accepts **`--from -`** (read the `.env` from stdin, replacing the POSIX-only `/dev/stdin`), and the push is **platform-aware** — `bash -lc` on POSIX, `powershell -EncodedCommand` on Windows, with the target's OS taken from the device registry. Because the npm `agents.ps1` shim does **not** forward ssh-piped stdin to the underlying node process (a raw `--from -` read hangs), the Windows keychain push bridges the piped `.env` through PowerShell into a temp file and imports `--from <file>` (deleted afterwards). File-backend export to a Windows target is refused cleanly rather than emitting broken PowerShell. Verified end-to-end: `agents secrets export linear.app --host win-mini` imported all 13 keys. Separately, **`agents secrets unlock --host <machine> <bundle>`** runs the unlock ON the remote over `ssh -tt`, so a **file-backed** bundle's passphrase prompt surfaces on your terminal — the "unlock the Mac from the road with its password" path; keychain/biometry bundles are GUI-only (a local Touch-ID/passcode sheet can't cross SSH) and can't be remote-unlocked. `unlock`'s `--host` is single-valued so it never swallows the positional bundle name. Source: `apps/cli/src/commands/secrets.ts`, `apps/cli/src/lib/hosts/remote-cmd.ts`.
- **A session now has ONE name, not two. `--name` seeds the session label instead of a parallel column.** Shipping `agents run --name` (1.20.43) as a separate immutable `name` column created two look-alike fields — an unshown, frozen `name` and the shown, searchable `label` — that both resolved `agents sessions <ref>` and forced tie-break bookkeeping nobody could keep straight. They unify into one field. `--name` is now the universal way to *seed* the `label` at launch — the same field an agent-generated title (Claude's `/rename`) later refines and `agents sessions` displays and searches — and it works consistently across interactive, headless, `--host`, and teams teammate runs (a teammate's friendly name now seeds its session label; before, teammate sessions had no name at all). Priority is a plain fallback chain resolved at scan time, no stored winner: an agent-generated title wins, else the `--name` seed, else the listing falls back to `topic`. So a Claude run's `--name` shows until Claude titles it (your seed, then refined); a non-Claude run keeps its `--name` as the label (it has no auto-title). The seeded name is now fuzzy-searchable in FTS (the old `name` column was not). `agents hosts logs <name>` is unchanged — it resolves against the host-task sidecar, not the session column. Schema v10 folds any existing `name` into `label` (where the label was empty), mirrors it into the FTS row, then drops the `name` column; the run-name sidecars re-seed every scan (`seedLabelsFromNames`), so no rescan is needed. Reworks the 1.20.43 `--name` design (partly reverts its separate-column approach). Source: `apps/cli/src/lib/session/{db,discover,run-names,types}.ts`, `apps/cli/src/lib/hosts/session-index.ts`, `apps/cli/src/lib/teams/agents.ts`, `apps/cli/src/commands/exec.ts`, `apps/cli/docs/{05-sessions,hosts}.md`.
- **NEW: `agents teams add`/`start` warns when a *version-pinned* teammate is on a throttled or signed-out account.** The 1.20.43 `balanced`-default fix keeps *bare* teammates off rate-limited accounts (they route through bare `agents run`, which rotates), but a **version-pinned** (`claude@2.1.112`) or **profile** teammate spawns `agents run <agent>@<version>` / `agents run <profile>`, and a pin/profile deliberately *bypasses* rotation — so it would launch straight onto a maxed account and 429 on the first request, with no mid-run failover either (that only arms when a non-pinned strategy actually rotated). `agents teams add` (at add time) and `agents teams start` (per staged teammate, deduped by `agent@version`) now pre-check a **version-pinned** teammate's account and print an advisory when it's rate-limited, out of credits, or not signed in — reusing the router's *exact* eligibility gate (`checkRunAccountReadiness` → `hasUsageAvailable`, the same session-inclusive signal the `agents view` badge uses), so the warning can never disagree with what the spawn would actually do. It **warns, never blocks** (mirroring the existing "may not be signed in" advisory); `--force` silences it. Scoped to version-pinned teammates on purpose: bare teammates are already handled by rotation, and a profile injects its own auth (a different account than the version home carries) that isn't locally checkable — so no unreliable profile warning is emitted. Source: `apps/cli/src/lib/rotate.ts` (`readinessFromCandidate`, `checkRunAccountReadiness`, `rotate.test.ts`), `apps/cli/src/commands/teams.ts`.

## 1.20.44
- **Every `logs` command is concise by default; the token-heavy raw dump is now opt-in behind `--full`.** Agents that spin up agents on other machines or add teammates were pulling whole transcripts just to glance at status — `agents logs <session>` printed the full markdown transcript, and `agents hosts logs` / `agents teams logs` / `agents routines logs` each `cat`'d their entire captured stdout, because each subsystem had hand-rolled its own "cat the log" verb over its own storage. All four now default to a bounded, concise view, with `-m/--full` for the raw log: `agents logs <session>` renders the same summary digest as `agents sessions <id>` (a real session shrank 92% — 29.9 KB → 2.6 KB); `agents routines logs <name>` shows a status header + the extracted report (a real run shrank 99.5% — 386 KB → 1.8 KB), falling back to a bounded stdout tail when no report was extracted; `agents teams logs <teammate>` renders the teammate's session summary (its agentId **is** the session id), with `-n <lines>` / `--full` for raw stdout; `agents hosts logs <id>` shows a bounded tail of the captured stdout (`tailLines`, with a "… N earlier lines hidden — pass --full" note) instead of the whole log. `renderSessionLog` now takes a mode and defaults to `'summary'`; `agents sessions <id>` was already summary-by-default and is unchanged. Regression-tested: `tailLines` truncation/elision math (`hosts/logs.test.ts`) and `formatRunDuration` human-time formatting (`routines-logs.test.ts`). Source: `apps/cli/src/commands/{logs,sessions,hosts,teams,routines}.ts`, `apps/cli/src/lib/hosts/logs.ts`. Scoped follow-up (not in this PR): host-task and sandboxed-routine runs write their real transcript on the remote / in an overlay HOME, so `logs` can't yet resolve them to the full `renderSummary` — making those runs discoverable is a separate change; until then the bounded tail / extracted report is the safe concise default.
- **The daemon now self-heals the `pane-died` hook on already-running `agents run` sessions.** The v1.20.42 fix that stops exiting a split from kicking you out of tmux is installed once, at session creation — so sessions already alive under the long-lived shared tmux server keep the old, unconditional `detach-client` hook until they exit or the server is recycled. On a machine that's never "between sessions," that meant hand-repairing live sessions. The daemon now runs `reconcileSessionHooks()` ~20s after startup and every ~5 min: it walks the managed `ag-` sessions on the shared socket and retrofits the `#{hook_pane}`-guarded hook onto any whose hook predates the current schema. It is strictly **non-destructive — `set-hook` only, never a `kill-pane` or `detach-client`** — so it is safe to run against sessions you're attached to; a per-session `@ag_hook_schema` marker makes steady-state a no-op. The hook string is now built in one place (`agentPaneDiedHook`) shared by the spawn-wrap and the reconcile so they can't drift. Source: `apps/cli/src/lib/tmux/session.ts`, `apps/cli/src/lib/daemon.ts`, `apps/cli/src/lib/exec.ts`.
- **NEW: `agents run` self-heals a gutted install instead of crashing with `ENOENT`.** The recurring failure: an npm agent whose native binary ships as an optional per-arch dependency (codex → `@openai/codex-<platform>`) can have that tarball extract **partially** — the platform package's `package.json` lands, its `vendor/<triple>/…/codex` binary does not (an interrupted or concurrently-raced `agents add` into the same version dir). The CLI's wrapper `require.resolve`s the platform package, finds the `package.json`, and sails straight past its own "missing optional dependency" guard into a `spawn(binaryPath)` that dies with a raw `ENOENT`. `agents run` now probes the version it's about to launch and, if the binary can't run, **repairs it in place** (a *clean* reinstall — the partial `node_modules` is wiped first, because npm treats the present-but-gutted platform package as already installed and would otherwise skip re-fetching it), then falls back to another installed version that launches (re-pinning it as the default so the shim path heals too), then to installing `latest` — only erroring if nothing can be made runnable. `installVersion` gained a `{ clean }` option for the wipe-then-reinstall. Source: `apps/cli/src/lib/versions.ts` (`ensureAgentRunnable`), `apps/cli/src/commands/exec.ts`.
- **Fix: a broken agent install no longer launches into a silent `[detached]` — the real crash is surfaced.** When an interactive `ag run <agent>` wrapped the agent in tmux and the agent died the instant it spawned (e.g. a gutted install crashing with `spawn … ENOENT`, a bad flag, a startup crash), the `pane-died` hook detached the client before you could read anything — you got a bare `[detached (from session …)]` with zero indication of why. `runInTmux` now recaps the dead pane's last output (read from scrollback via `capture-pane -S -200`, since the pane's visible screen is just the "Pane is dead" banner) plus the exit code to stderr, and points you at `--no-tmux`. Fast failures (dead before attach) always recap; a post-attach nonzero exit recaps too (a clean exit or a manual detach stays quiet). Source: `apps/cli/src/lib/exec.ts`, `apps/cli/src/lib/tmux/session.test.ts`.
- **NEW: `--no-tmux` / `--disable-tmux` on `agents run`.** The interactive tmux wrapper (which gives `%pane` addressing + re-attach) already had an opt-out, but it was hidden behind the opaquely-named `--raw`. `--no-tmux` (and its alias `--disable-tmux`) spawn the agent directly with full stdio inherited — the fastest way to see an agent's real startup output when a launch is failing. Same effect as `--raw` and `AGENTS_NO_TMUX=1`. Source: `apps/cli/src/commands/exec.ts`.
- **Fix: `agents add <agent>@<version>` no longer records a gutted install as healthy (root cause of the ENOENT crash + a broken default pin).** npm packages that ship their native binary via an optional per-arch dependency (e.g. codex → `@openai/codex-<platform>`) can land the JS wrapper at `node_modules/.bin/<cli>` while the real platform binary is missing (interrupted install, omitted optional dep, `--ignore-scripts`). `getBinaryPath()` only checked the wrapper, so the broken version read as installed, got pinned as the default, and got picked to run — then died with ENOENT. `installVersion` now probes `<binary> --version` (under the version's isolated HOME) after install and **fails the install** if the binary can't launch, so a broken version is never silently pinned. The check is deliberately narrow — only the missing-binary signature (`ENOENT`/"no such file"/"command not found") fails it; a plain nonzero exit or a timeout is treated as healthy, so a well-behaved agent that dislikes `--version` is never false-failed. Source: `apps/cli/src/lib/versions.ts`, `apps/cli/src/lib/versions-integrity.test.ts`.
- **Security fix: the routines daemon log no longer leaks GitHub / AWS / npm tokens.** `daemon.ts` carried its own private `redactSecrets` (used by every `log()` write to `logs.jsonl`) that predated and diverged from the canonical `redact.ts` — it caught `sk-`, `eyJ…`, `Bearer …`, and a narrow `NAME=value` list, but **not** `ghp_` (GitHub PAT), `AKIA…` (AWS access key), or `npm_` (npm token), so any of those appearing in a daemon message (a git push URL, a bundle-env dump, an error string) was written to the log in the clear. The private copy is deleted; `log()` now routes through the canonical `redactSecrets` in `redact.ts`, which covers all of those classes with a stronger quote-aware `NAME=value` pattern. The one pattern the daemon copy had and the canonical lacked — `Bearer <token>` — is added to `redact.ts`, so the shared redactor (also used by session-transcript export in `session/render.ts`) is now a strict superset. New `redact.test.ts` pins every token class as a regression guard. Source: `apps/cli/src/lib/daemon.ts`, `apps/cli/src/lib/redact.ts`, `apps/cli/src/lib/redact.test.ts`.
- **Fix: `agents teams doctor` tells the truth, a version fallback never spawns an unspawnable literal, and shims survive a vanished dispatcher (completing this release's self-heal series).** Three gaps remained after the `agents run` self-heal above. (1) **`agents teams doctor` lied** — it reported `installed: true` whenever a *shim file* existed, never checking the real binary, so a stub or gutted-native install (the exact codex/kimi failure) showed "ready" and then `ENOENT`'d at spawn. `checkCliAvailable` now verifies the resolved default version is actually installed, and doctor additionally **launch-probes** each installed agent (`verifyInstalledBinaryLaunches`) and flips a gutted-native one to not-installed with a repair hint. (2) **A version fallback spawned an unspawnable literal** — when a specific version was requested (`agents run kimi@0.19.2`, the path every version-pinned teammate takes) and no versioned shim existed on disk, the launch left the bare `<agent>@<version>` name as `argv[0]`, which is not on PATH, so it died with `spawn kimi@0.19.2 ENOENT`; it now resolves the version's real binary (`getBinaryPath`) instead, falling back to the literal only when no binary exists at all. (3) **A shim couldn't survive its dispatcher vanishing** — when the baked `AGENTS_BIN` (often a dev build under `~/.local/agents-cli-dev`) was removed, moved, or went stale, the shim exited 127 and bricked *every* managed launch; it now **self-recovers** to whatever `agents` resolves to on PATH before erroring (`SHIM_SCHEMA_VERSION` → 25). Also drops a stale, npm-unrecoverable `codex 0.116.0` pin from the repo's own `agents.yaml` so codex resolves to the machine default instead of self-healing on every run. Source: `apps/cli/src/lib/{exec,shims}.ts`, `apps/cli/src/lib/teams/agents.ts`, `apps/cli/src/commands/teams.ts`, `agents.yaml`.

## 1.20.43

- **NEW: `agents run --name <slug>` — a durable, human/agent-friendly handle for any run.** An agent that dispatches another agent had no cheap status handle: the host-task id was never even printed (the `--no-follow` tip showed a literal `<id>` placeholder), and only Claude's session id is known up front (pre-minted `--session-id`) — every other agent's id is discovered later by scanning transcripts, so callers fell back to `agents logs`, which dumps the raw, token-heavy transcript. `--name` is chosen at launch, agent-agnostic, and stored on the structures that already back these views: a first-class `name` column on `sessions.db` (schema v9, additive, no rescan) parallel to `label` — `agents sessions <ref>` resolves against **both** name and label; the HostTask sidecar (forwarded to the remote run, so `agents hosts ps` gains a NAME column and `agents hosts logs <name>` resolves by name); and a run-name sidecar (`~/.agents/.cache/run-names/`) that joins a local run's name onto the index by id every scan via `syncNames` — the same idempotent pattern as `/rename` label sync. The `name` column is deliberately left out of the upsert `ON CONFLICT … SET` clause, so a discovery rescan can never null an existing name (regression-tested in `db.names.test.ts`). Omitting `--name` is a strict no-op: `name` stays unset and every id-based path is unchanged. The `--no-follow` dispatch tip now prints the real handle and steers to the compact `agents sessions` digest over the raw log. Source: `apps/cli/src/commands/exec.ts`, `apps/cli/src/lib/session/{db,run-names,discover}.ts`, `apps/cli/src/lib/hosts/{dispatch,tasks}.ts`.
- **New terminals (and teammates) no longer launch into a rate-limited account; `balanced` is now the default run strategy.** Two coupled fixes. (1) A bare `agents run <agent>` — every new agent terminal the extension spawns, and every non-version-pinned `agents teams add`/`start` teammate, since both route through bare `agents run` — used to default to the `available` strategy, which *prefers the pinned default version when it looks healthy*. But "healthy" was judged by the router's `getRoutingUsedPercent`, which **excluded the 5-hour session window** and looked at weekly usage only. So a session-maxed account with weekly headroom (e.g. session 100% / week 60%) was deemed eligible and kept getting launched — while `agents view` showed it "rate-limited" (its badge, `deriveUsageStatusFromSnapshot`, *counts* the session window). The router and the badge disagreed. Now `hasUsageAvailable` shares the badge's exact signal: an account maxed on **any** blocking window (session or weekly) is ineligible and skipped by both `available` and `balanced` — you never spin up an agent on an account that can't serve the next request. Capacity *weighting* still ranks eligible accounts by weekly headroom, so a brief session spike doesn't distort long-run routing. (2) The default strategy is now `balanced` (was `available`): a bare run spreads load across all healthy accounts by remaining headroom instead of sticking to the pinned default. Override per-workspace with `run.<agent>.strategy` in `agents.yaml`, or per-invocation with `--strategy` / `-b`. Source: `apps/cli/src/lib/rotate.ts`, `apps/cli/src/lib/usage.ts`, `apps/cli/src/commands/exec.ts`.
- **[browser] Logins survive browser restarts: sandboxed profiles keep memory-only session cookies, without restoring tabs.** Sites that issue login cookies with `expires=-1` (idealista, many banking/classifieds sites) logged the profile out on every browser restart, because Chromium purges memory-only session cookies at startup unless the session-restore preference is set — a constraint that had already leaked into agent designs as "sessions can't survive restarts". Every launch now pins `session.restore_on_startup: 1` ("continue where you left off") in the profile's `Default/Preferences`, which is the switch Chromium's cookie purge actually keys off — and pairs it with `--no-startup-window` so the *visible* side of restore never happens: no window exists at startup for restore to fill, no ghost tabs from the last task reopen, and the task flow creates its own tab over CDP exactly as before. Verified live on Windows/Comet: a memory-only cookie planted pre-restart was still present after a full stop/start, with OS-level window enumeration confirming a single window and zero restored tabs. The Preferences patch runs pre-spawn (browser down, so Chromium can't overwrite it on exit), stamps the profile name only on first launch, skips malformed files untouched, and is a no-op when already set. Electron profiles keep the old name-only seeding — they manage their own storage and need their startup window (the CDP driver binds to it). Bare `agents browser start` (no `--url`) recreates the old startup-window affordance by opening a blank page target when none exists, unregistered on the task like the startup window always was. Server-side session TTLs still apply — this removes the restart logout, not the site's own expiry. Source: `apps/cli/src/lib/browser/chrome.ts` (`ensureProfilePreferences`, launch args), `apps/cli/src/lib/browser/service.ts`.
- **Security fix: `agents sessions --host <target>` no longer accepts a leading-dash target (SSH argv-flag smuggling).** `session/remote.ts` carried its own copy of `assertValidSshTarget` that omitted the `host.startsWith('-')` guard every other SSH path enforces, so a bare flag like `-l` or `-F/path` — which passes the character allowlist — was handed straight to `ssh` as an argument (`-oProxyCommand=…`-class injection) before any connection. The duplicate validator (and its `SSH_TARGET_RE`) is deleted; `runRemoteSessions` now routes through the canonical `assertValidSshTarget` in `ssh-exec.ts`, whose dash guard is already regression-tested (`ssh-exec.test.ts`). Source: `apps/cli/src/lib/session/remote.ts`.

## 1.20.42

- **Fix: exiting a split pane inside an interactive `ag run` session kicked you out of tmux entirely.** When you split the window of an interactive agent session (`ag run claude`) with Ctrl-b `"`/`%` and then `exit`ed *your* split, the whole tmux client detached and dumped you back to the parent shell — even though the agent was still running in the other pane. Cause: `runInTmux` installed a session-wide `pane-died` hook (`detach-client`) meant to fire only when the AGENT pane exits (so the attach returns and the exit status is read), but with no `#{hook_pane}` guard it fired for *any* pane's death. The hook is now scoped to the agent pane; a user split that exits is closed in place (`kill-pane`, no lingering dead husk) and the agent keeps running full-window. Source: `apps/cli/src/lib/exec.ts`, `apps/cli/src/lib/tmux/session.test.ts`.
- **Every secret-value read is now audited, not just the ones that flowed through the resolver.** `agents events --module secrets` (or `--event secrets.get`) is meant to show "every secret accessed or revealed", but several paths read plaintext values without going through `readAndResolveBundleEnv` (the only place that emitted `secrets.get`), so they were invisible: `secrets push` (which reads the whole bundle to upload it — the most sensitive silent read), `secrets view --reveal`, the raw `secrets get <item>`, `secrets set <item>` (a raw write, no `secrets.set`), and the *initiating* side of `secrets exec --host` / `run --secrets bundle@host` (only the remote host logged it). Each now emits with a `source` telling you HOW it was read — `keychain`, `agent` (served from the unlocked broker), `reveal`, `raw-item`, `sync-push`, or `remote` (with the target `host`) — alongside the bundle, caller, keyCount, and OS-user/host/transport. The resolved **value is never written to the log**, only names and counts. All `secrets.*` events are now tagged `module: 'secrets'` so `--module secrets` actually surfaces the value reads (previously it matched only the coarse command events). Note: the event log has a 7-day retention, so export what you need for long-term records. Source: `src/lib/secrets/bundles.ts`, `src/lib/secrets/sync.ts`, `src/lib/secrets/remote.ts`, `src/commands/secrets.ts`, `docs/06-observability.md`.
- **Fix: `sessions --active` showed the SAME preview + topic for every co-located session.** Multiple Claude sessions in one cwd (e.g. several editor tabs, or two worktree siblings) all rendered identical activity — they looked like duplicate cards. `findClaudeSessionFile` fell back to the newest `.jsonl` in the cwd whenever a session's `<id>.jsonl` wasn't found, so every distinct session collapsed onto ONE file's preview/topic. The stale-id trigger: an editor caches the launch uuid in `live-terminals.json`, but Claude rotates its transcript uuid on resume/compact, so the cached id no longer matches any file. Now the terminal path resolves each tab's EXACT id from the pid registry (mirroring the headless path), the newest-file fallback is gated to the no-id case (`pickSessionFile`), and an unresolvable file reads as `idle` rather than `running`. Source: `apps/cli/src/lib/session/active.ts`.
- **Fix: one malformed Kimi session blanked the WHOLE `agents sessions` listing.** A Kimi `state.json` with neither `createdAt` nor `updatedAt` made `readKimiMeta` return an `undefined` timestamp, which binds `NULL` into the `timestamp TEXT NOT NULL` column and aborts the entire batch index — so a single bad session took down the listing for every session, not just itself. Two layers: `readKimiMeta` now coerces the timestamp to never-null, falling back to the `state.json` mtime (matching how the listing already ranks Kimi via `last_activity`, like every other parser); and `upsertSessionsBatch` wraps each row in a per-row guard so a future constraint-violating row skips itself (ledger deliberately not stamped, so the next scan re-tries it) instead of rolling back the whole batch. Source: `apps/cli/src/lib/session/discover.ts`, `apps/cli/src/lib/session/db.ts`.

## 1.20.41

- **NEW: `agents sessions focus [id]`** — one command to get back to a session, however it's reachable. It **attaches** a live session in place (tmux `switch-client`/`attach-session`, a remote tmux over `ssh -tt`, or a Ghostty tab — joining the live process without forking); where there's **no live terminal to attach**, it **opens a new tab and resumes** the session — locally, or on the remote peer over SSH (`runOnPeer`, so the peer resolves the version-pinned binary). No id opens the rich live-session picker (this-machine first). Reuses the live-session detection and the terminal launch engine (`openSurfaces`), and folds `go`'s attach paths in. Source: `src/commands/focus.ts`, `src/commands/go.ts`.
- **`--device` is now a first-class alias of `--host`** on every host-routable command (`sessions`, `run`, …), registered centrally on `addHostOption` so a local fall-through no longer errors. Source: `src/lib/hosts/`.
- **`agents computer` steers Electron/webview targets over CDP** instead of reporting a fake success when the native-automation path can't reach them (#716).
- **Secrets: the "remember" policy hold now lasts 7 days and survives screen-lock**, instead of re-prompting after every lock/sleep; stale copies are evicted when a policy is tightened. Source: `src/lib/secrets/`.
- **Fixes:** shim `machine_id()` normalizes to match `normalizeHost()`, and shim resolution honors the per-device default pin (not just the central `agents.yaml`).
- **`agents sessions go` is retired as a deprecated alias for `agents sessions focus --attach-only`.** `go` was already a strict subset of `focus` — its only unique behavior was "attach the live terminal or refuse, never fork/resume." That behavior is now a first-class `--attach-only` flag on `focus` (`focus.ts`: `selectFallback()` picks `refuseFallback` under `--attach-only`, else the resume-in-a-new-tab fallback). `go` now prints a one-line deprecation notice and delegates to `focusAction(id, { attachOnly: true })`; the shared reach engine (`jumpTo`/`gatherLiveTargets`/`pickLiveTarget`/`refuseFallback`) still lives in `go.ts` and is imported by `focus.ts`. Source: `src/commands/go.ts`, `src/commands/focus.ts`.
- **`agents sessions --json --host <h>` now emits a clean JSON array** of recent (non-active) sessions instead of the legacy per-host raw banner stream, so a UI can fetch a remote device's recent sessions when it has no live agents. `serializeSessionsJson()` is shared by the local and remote `--json` paths; `runRemoteSessionsJson()` reuses the existing `gatherRemoteList` SSH fan-out. The non-JSON banner path and `--active` are unchanged (#711).

## 1.20.36

**[windows] `agents sessions --active` detects sessions on Windows, and shim launches carry cwd + session identity everywhere**

- The active listing found nothing on Windows: the headless scan shelled out to `ps -A` and per-pid `lsof` — both POSIX-only, both failing silently into "No active agent sessions" with a dozen live `claude.exe` processes running. The process table now comes from one CIM query on win32 (`powershell.exe Get-CimInstance Win32_Process`; `wmic` is removed on current Windows 11) parsed into the same pid/ppid/comm rows, agent-kind matching strips the `.exe` image suffix case-insensitively (POSIX comms stay exact-match — macOS's Claude *desktop app* process is named `Claude` and must not be listed), and the ancestry walk recognizes Windows terminal hosts (`Code.exe`, `Cursor.exe`, `VSCodium.exe`, `Windsurf.exe`, `WindowsTerminal.exe`). Where no cwd can be recovered (no `lsof` on Windows), same-kind child agent processes — Claude runs subagents and its bundled ripgrep as child `claude` processes — fold onto their root candidate (`foldSubordinateAgents`) instead of printing one row per fork; on POSIX those children collapsed via shared-cwd session dedupe, which now accumulates pre-folded pid counts instead of resetting them. Verified live: 6 root `claude.exe` processes render as 6 rows (previously zero). Source: `src/lib/session/active.ts`.
- Those Windows rows grouped under `unknown` with no topic because only `ag run` recorded a pid → session/cwd registry entry. The transparent shim delegate (`execShimPassthrough`) — the path every `claude`/`codex` typed into a terminal actually takes — now writes the same `by-pid` registry entry at spawn: agent, launch cwd, and the exact session id when the caller passed `--session-id` (`extractSessionIdArg`; whole-arg match only, a uuid inside a prompt never counts). On the win32 `.cmd` shell path the recorded pid is the cmd.exe intermediary rather than the agent binary, so the active scan resolves entries by walking a candidate's ancestors (`readAncestorSessionEntry`), accepting only a matching agent kind — a claude session shelling out to codex can't hand codex its identity — and the fork-fold keeps a descendant with a wrapper entry below its fold target as its own row (a claude launched from inside another claude session is a real second session, not a fork). Net effect: Windows shim launches list with their project directory, exact session id, and topic instead of `unknown`. (POSIX bash shims `exec` the binary directly without the delegate, so they are unchanged and keep relying on lsof-recovered cwd + newest-jsonl.) Source: `src/lib/exec.ts`, `src/lib/session/pid-registry.ts`, `src/lib/session/active.ts`.
**[windows] `browser profiles create` no longer hands out a port an already-running browser is listening on**

- `findFreeProfilePort` probed candidate ports by shelling out to `lsof`, which doesn't exist on Windows — the ENOENT was swallowed by the "assume free" catch, so **every** port in 9222–9399 scanned as free. The first profile created without `--endpoint` was assigned `cdp://127.0.0.1:9222`, and if the user's own browser was running with `--remote-debugging-port=9222` (a common Comet/Chrome setup), the new profile silently *attached* to that browser instead of launching its own sandboxed instance — tabs then opened in whatever profile the user had on screen. The scan now routes through `isPortInUse` (`chrome.ts`, newly exported), the same platform-aware probe the launcher already used: `lsof` on POSIX, `netstat -ano` on Windows. Regression-tested with a real bound socket, no mocks, so the probe is exercised per-platform in CI (`src/lib/browser/chrome.test.ts`). Source: `src/lib/browser/profiles.ts`, `src/lib/browser/chrome.ts`.

**[windows] Background spawns no longer flash console windows while agents run**

- Every background chain root — the scheduler daemon, the auto-pull worker, the PTY sidecar server, the routine runner's job spawns, detached ssh tunnels — was spawned `detached: true` without `windowsHide`. On Windows `detached` maps to `DETACHED_PROCESS`, under which CreateProcess ignores `CREATE_NO_WINDOW` and the child runs console-less, so every console-subsystem descendant (powershell.exe for a Credential Manager read, git, node, a `.cmd` shim's cmd.exe wrapper) allocated its own **visible** console window — the "PowerShell windows popping up and closing while I type" bug. The worst repeat offender: the console-less daemon resolves secrets bundles through `powershell.exe` on every session-sync cycle (90s). The new `backgroundSpawnOptions()` (`src/lib/platform/process.ts`) is the single place that decides the pattern: POSIX keeps `detached: true` (own process group, group-kill still works); Windows switches to `windowsHide: true` with no detach — the child owns a *hidden* console that all descendants inherit (nothing down the tree can flash) and that no launcher console-close event can reach, preserving the #556 daemon-teardown fix. Verified with a live Win32 probe (`GetConsoleWindow` + `IsWindowVisible`): the old pattern yields `VISIBLE=True`, the new pattern allocates no console window at all. Leaf spawns of console tools reachable from a console-less parent (powershell in `secrets/windows.ts` + `platform/winpath.ts`, tasklist/netstat/taskkill in the browser runtime probes, `tailscale status`, ssh, ffmpeg) now pass `windowsHide: true` as defense in depth for callers this release can't re-parent (e.g. an already-running daemon). Source: `src/lib/platform/process.ts`, `src/lib/daemon.ts`, `src/lib/auto-pull.ts`, `src/lib/pty-client.ts`, `src/lib/runner.ts`, `src/lib/ssh-tunnel.ts`, plus the leaf call sites.
- Fallout the hidden console surfaced (caught by the real-advapi32 round-trip test): the Credential Manager driver's `set` read the secret from stdin as *text* via `[Console]::In.ReadToEnd()`, decoded with the console codepage — correct only when the caller's console happened to be UTF-8 (Windows Terminal). Under a fresh hidden console (OEM cp437), or any console-less caller like the daemon, non-ASCII secrets corrupted on write (`café ☕` stored as `caf├⌐ Γÿò`). The static PS script now reads stdin as raw bytes (`[Console]::OpenStandardInput()` → `MemoryStream`) and pins `[Console]::OutputEncoding` to UTF-8, so the round-trip is codepage-independent in every calling context. Source: `src/lib/secrets/windows.ts`.
- Correction for the fd-redirected roots (daemon, runner, PTY server): `windowsHide` is inert whenever a stdio slot is redirected to an fd — libuv skips `CREATE_NO_WINDOW` if any stdio fd is inherited, and log-file redirection counts. A non-detached daemon therefore shared its launcher's console and died on the launcher's console-close event the moment `agents daemon start` returned (the #556 failure, reproduced live: child `alive-after-launcher-exit=false` under `{detached:false, windowsHide:true}` with fd stdio, `true` under `{detached:true, …}`). `backgroundSpawnOptions({ fdStdio: true })` now keeps `DETACHED_PROCESS` for these roots — the child runs console-less and windowless, and its console-tool spawns stay invisible via the leaf `windowsHide` fixes above. Fully-piped/`'ignore'` roots (auto-pull, detached ssh tunnels) keep the hidden-console pattern, which the Win32 probe validated. Regression-tested: a hidden-console launcher spawns an fd-redirected child and exits; the child must survive (`src/lib/platform/process.test.ts`).

**[teams] `agents teams pr-watch <team>` — autonomous PR lifecycle: CI-fix waves + review-comment routing (Closes #338)**

- A team's teammates open PRs; `pr-watch` watches them and reacts without a human in the loop. Each poll it resolves the PRs the team opened (from each teammate's `pr_url`, else the `gh pr create` detected in the session it ran), snapshots CI + review comments via the `gh` CLI (`gh pr checks --json`, `gh api …/pulls/{n}/comments`), and decides follow-ups: **RED CI** spawns a fix teammate `--after` the one that failed, with the failing-run logs (`gh run view --log-failed`) injected so it pushes a follow-up commit to the *same* PR branch; a **new review comment** routes a `bugfix` teammate (the existing `TaskType`) `--after` the source, with the comment body injected. Both slot into the team DAG the supervisor already drains — the loop calls `startReady` each pass so staged fixers launch when their source completes — and every reaction is visible in `agents teams status`. Dedupe is by check-run id / comment id, persisted to `pr-watch-<team>.json`, so the same failure or comment never spawns twice across restarts. The decision logic (`decidePrActions`) is a pure function over injected snapshot data (unit-tested in `src/lib/teams/pr-watch.test.ts`, no network); the `gh` collectors and the `handleSpawn`-backed reactor sit on top. **Deferred (documented follow-up):** the event-driven path from #331's webhook receiver — `pollPrSnapshot` is the seam where a `check_run` / `pull_request_review_comment` payload plugs in, producing the same `PrSnapshot` the pure decider already consumes. Source: `src/lib/teams/pr-watch.ts`, `src/commands/teams.ts`.

**[hosts] `--host`/`--device` now resolves registered devices and ad-hoc `user@host` — one concept, one flag**

- Offloading a run no longer needs a machine enrolled in *two* registries. `agents run --host <name>` (and the new `--device <name>` alias, plus `teams add --host`, and every other `--host` consumer via the shared resolver) now resolves in order: the `agents hosts` registry (unchanged), then the **`agents devices`** registry, then an ad-hoc **`user@host`**. A machine registered once with `agents devices sync` is reachable immediately — previously it errored `Unknown host` unless you *also* ran `agents hosts add`. The fall-through lives in one place (`resolveHost`), so it's not a per-command band-aid. A bare unknown name still returns null so capability-tag routing (`--host gpu`) is unaffected; only a name containing `@` is treated as an ad-hoc target (validated by `assertValidSshTarget`). A device that authenticates by password can't offload over the BatchMode ssh path, so it throws a typed, actionable `DeviceOffloadUnsupportedError` (switch to key auth or enroll as a host) instead of dispatching a run that would hang. Source: `src/lib/hosts/registry.ts`, `src/commands/exec.ts`, `src/lib/hosts/option.ts`.

**[secrets] recover credentials orphaned under a stale keychain access group (RUSH-1413)**

- Secrets written before the access-group pin (#279, first shipped v1.20.27) were filed by macOS under the implicit default group — the literal wildcard `2HTP252L87.*`, not the concrete `2HTP252L87.com.phnx-labs.agents-keychain` that every query now pins (`keychain-helper.swift` `dpBase`). Those items are intact and the wildcard entitlement authorizes reading them, but the pinned queries never ask for that group, so `has`/`get`/`list` reported them **missing** and whole bundles vanished from `secrets list` (their metadata was orphaned too). On one machine this stranded 43 items including the ssh private key, the release signing key, and identity secrets. The helper now recovers them on three levels: (1) `readItem`/`has` add an **un-pinned data-protection fallback pass** after the pinned miss, so an orphan reads and reports present instead of missing; (2) `get`/`get-batch` **re-home** an orphan inline the first time it's read — reusing the read's Touch ID, add-before-delete, deleting the exact orphan by `kSecValuePersistentRef` — mirroring the existing file-based `migrateInline`; (3) a new `migrate-orphans` helper verb bulk re-homes every orphan behind a single Touch ID. `list` is now un-pinned so orphaned bundle metadata reappears, and `set`/`delete` clear across all groups so a rotate/delete can't leave a shadow copy. New `list-orphans` verb enumerates orphans prompt-free. Source: `src/lib/secrets/keychain-helper.swift`, `src/lib/secrets/index.ts`.
- `agents secrets migrate-acl` now sweeps orphaned-access-group items in addition to legacy-ACL stragglers: the dry-run lists both classes, `--commit` re-homes the orphans in one batched Touch ID (add-before-delete needs no pre-write backup), and any listed orphan the helper can't reach (e.g. under a different signing team) is surfaced, never dropped silently. Because every published helper shares team `2HTP252L87` and the same wildcard entitlement, one run recovers every affected user losslessly. Source: `src/commands/secrets-migrate.ts`, `src/lib/secrets/index.ts` (`listOrphanedKeychainItems`, `migrateOrphanedKeychainItems`, `parseOrphanMigrationOutput`). The signed helper must be rebuilt + re-signed + notarized and its sha re-pinned (`scripts/build-keychain-helper.sh`, `scripts/Agents CLI.app.sha256`) at release, per the standard keychain-helper release step.

**CI: audit-event tests are green on Windows; the release re-gates on the windows-latest matrix legs (RUSH-1412)**

- The cross-platform matrix (`ci.yml`, runs only on `release/**` + `v*`) had both `build (windows-latest, …)` legs red: `tests/events-audit.test.ts` and `tests/teams-events.test.ts` spawn the CLI with a redirected `HOME` and then read the audit trail under it, but the events writer rooted its log dir at a bare `os.homedir()` (`src/lib/events.ts:24`). On Windows `os.homedir()` resolves from `USERPROFILE` and ignores a `HOME` override, so every `command.start`/`command.end` record was silently written to the real profile instead of the test's temp home — the events array came back empty and the log file `ENOENT`'d (macOS/Ubuntu were green because `os.homedir()` honors `$HOME` on POSIX). The writer now roots its log dir through `state.getLogsDir()`, the single canonical home anchor (`process.env.HOME ?? os.homedir()`), which honors an explicit `HOME` on every platform and still resolves to `USERPROFILE` in production on Windows (where `HOME` is unset), so real users are unaffected. One `events-audit` case also reconstructed its log filename from a UTC `toISOString()` while the writer names files from the local date, so it `ENOENT`'d whenever a runner's local and UTC dates straddled midnight; it now globs the log dir like the other assertions. `scripts/release.sh` restores both `build (windows-latest, 22|24)` entries to `EXPECTED_CHECKS`, so Windows is a release gate again. Source: `src/lib/events.ts`, `tests/events-audit.test.ts`, `scripts/release.sh`.
- Three more `build (windows-latest, …)` failures fixed. (1) **Antigravity sessions were invisible to Windows users, not just tests.** `parseAntigravity` read its conversation SQLite DBs by shelling out to the `sqlite3` CLI (`src/lib/session/parse.ts:893`), which is absent on Windows — so `execFileSync('sqlite3', …)` threw `spawnSync sqlite3 ENOENT` and the parser silently returned `[]` for every real Antigravity session on Windows. It now reads the `step_payload` BLOBs through the runtime-agnostic `src/lib/sqlite.ts` wrapper (node:sqlite / bun:sqlite, the same path production already uses for the session index), so it works on every OS with no CLI dependency; `parse-antigravity.test.ts` builds its fixture DB through the same wrapper instead of the CLI. (2) `parse-droid.test.ts` derived its `testdata` dir from `new URL(import.meta.url).pathname`, which on Windows yields `/C:/…` — so `path.join` produced a doubled-drive `C:\C:\…` that `ENOENT`'d; it now uses `fileURLToPath(import.meta.url)`. (3) `git.test.ts`'s `syncRepoGit` "pull-only" case failed because the Windows runner's `core.autocrlf=true` converted the freshly-cloned `README.md` to CRLF *during* `git clone` — before `configIdentity()` could set `autocrlf=false` on the clone — so `status.isClean()` saw a phantom modification and `syncRepoGit` refused with "Working tree has uncommitted changes." The test seed now commits a `.gitattributes` (`* -text`), which wins over `autocrlf` at checkout time so every clone lands byte-identical LF content. (`parseOpenCode` shells out to `sqlite3` the same way and has the same latent Windows gap, but its test mocks `execFileSync` so CI never caught it and its argv-injection regression test pins the CLI call — left untouched to avoid scope creep.) Source: `src/lib/session/parse.ts`, `src/lib/session/__tests__/parse-antigravity.test.ts`, `src/lib/session/__tests__/parse-droid.test.ts`, `src/lib/git.test.ts`.

**`agents message <target> <text>`: deliver a message to an already-running agent mid-flight [RUSH-1415]**

- One verb now reaches a live agent while it works, not just a cloud task. `agents message <id> <text>` resolves the target to exactly one destination and routes it: a **cloud task id** takes the existing provider follow-up path (was `agents cloud message`); a **live local/teams/loop agent** gets the text enqueued into a per-agent file-spool mailbox that a `PreToolUse` hook drains and injects at the agent's next tool call. `resolveMessageTarget()` is the anti-misroute gate — exact id wins over prefix, results de-dupe by canonical mailbox id, and a target matching zero or more-than-one live agent (or an empty string) is never guessed: the command errors with the candidate list. `--from <who>` records a sender label; `--host <h>` routes the whole command over SSH (via `REMOTE_PASSTHROUGH`) to the box that owns the agent, and `message` registers as a lazy SQLite-backed command like `cloud`/`sessions`/`teams`. Source: `src/commands/message.ts`, `src/lib/mailbox-target.ts`, `src/lib/hosts/passthrough.ts`, `src/lib/startup/command-registry.ts`.
- The mailbox itself is a crash-safe file-spool under `~/.agents/.history/mailbox/<id>/{inbox,processing,consumed}/`. Enqueue is atomic (temp-write + `rename`); drain is claim-first (`inbox → processing → consumed`) so an interrupted drain is recovered on the next call (at-least-once delivery; consumers dedup by `msgId`). Every message stamps a `to` field and a monotonic FIFO `msgId`; a message that lands in the wrong box or fails to parse is archived and dropped, never delivered or looped. A mailboxId must be a single separator-free path segment (`[A-Za-z0-9._-]`, not `.`/`..`) — validated at the id→path boundary and the write-time `to` stamp so a traversal-bearing id fails loud instead of silently misrouting. At spawn, `buildExecEnv` points each agent at its own box via `AGENTS_MAILBOX_DIR` (keyed by session id); a loop overrides it to the run-level box so every iteration shares one inbox, and prints `agents message <runId>` at start since the runId is otherwise undiscoverable. Source: `src/lib/mailbox.ts`, `src/lib/state.ts`, `src/lib/exec.ts`, `src/lib/loop.ts`.

**Watchdog core: stall detection + nudge decision for a stalled agent (#612) [RUSH-1415]**

- Ports the pure, fs/vscode-free watchdog core so agents-cli can decide when a running agent has stalled and what to say to un-stall it: `classifyTerminal` + `isLikelyTrulyBlocked` (blocked / waiting / completion-hint signals plus a promise-without-toolcall detector), `renderWatchdogPrompt` / `composePromptWithPlaybook` / `WATCHDOG_SYSTEM_PROMPT`, and a tolerant `parseWatchdogResponse`. `summarizeWatchdogTail` extracts the last user/assistant turn across Claude/Codex/Gemini transcript shapes and filters synthetic `<system-reminder>`-style tags. The session-tail reader seeks backward from EOF for the last N JSONL lines and resolves a transcript from `sessionId + agent` by reusing `getAgentSessionDirs()` rather than hardcoding paths — including the recursive `walkForFiles` walk that reaches Codex's deep `sessions/YYYY/MM/DD/rollout-…jsonl` layout and Gemini's tmp layout, driven per-agent by `WATCHDOG_SESSION_LAYOUT`. Source: `src/lib/watchdog/watchdog.ts`, `src/lib/watchdog/watchdogTail.ts`, `src/lib/watchdog/read.ts`, `src/lib/watchdog/index.ts`.

**Terminal injection: type into an already-running agent's exact terminal (#611, #616) [RUSH-1415]**

- `injectIntoTerminal` extends the Terminal Engine to type into a *running* surface, not just open new ones — the primitive a native watchdog needs to nudge a stalled agent with "continue" delivered into the precise terminal it lives in. It mirrors the engine's shape: pure per-backend spec builders produce a `LaunchSpec` run through the same `runSpec` transport, so injection inherits local/remote (`--host` over SSH) execution for free. Backends: **tmux** `send-keys -t <pane>` (socket-addressed), **iterm** `tell session id "<uuid>" to write text` (no `activate`, so it addresses the exact split without stealing focus), **vscodium** (VSCodium/Cursor/VS Code) over the editor CLI's `--open-url` into the extension's `/inject` verb, and **pty** via the agents-pty sidecar (local-only). Ink-TUI Enter semantics: text and Enter are two separate writes by default (a fused `text\r` is swallowed by Claude's Ink TUI), and `combined` opts into the single fused write for plain shells. Source: `src/lib/terminal/inject.ts`, `src/lib/terminal/index.ts`.
- `resolveInjectTarget` is the single resolver the watchdog calls: `sessionId →` a precise `InjectTarget` or an honest `{ addressable: false, reason }`, with precedence tmux > iterm > vscodium > pty and a deliberate safe skip for Ghostty (no addressable split API). `deriveProvenance` now captures `$ITERM_SESSION_ID` and, absent tmux, exposes an `iterm` reply rail carrying the iTerm2 session UUID — tmux still wins whenever present because a pane is reachable inside any host app. `agents sessions inject <id> <text>` is the CLI face: it resolves an active session to its provenance reply rail and routes to the matching backend, with `--pane`/`--pty` to target a backend directly, `--combined` to toggle the Ink-safe two-write default, `--no-enter` to send without submitting, and `--host` to inject over SSH. Source: `src/lib/terminal/resolve.ts`, `src/lib/session/provenance.ts`, `src/lib/session/inject.ts`, `src/commands/sessions-inject.ts`.

**Watchdog consumer + `agents watchdog`: run one stall-detection tick end to end (#619, #622) [RUSH-1415]**

- `runWatchdogTick` ties the pure pieces together into one pass over `getActiveSessions()`: `classifyTerminal()` finds stalls, `readWatchdogTail()` reads the transcript, `isLikelyTrulyBlocked()` gates on the promise-without-toolcall heuristic (deterministic v1) or an optional `--smart` LLM decider, `resolveInjectTargetForSession()` is the absolute safety gate, and `injectIntoTerminal()` delivers `Continue.` into the EXACT split. A nudge fires ONLY on `addressable:true`; an `addressable:false` stall is flagged to a tray-readable state file and skipped — never a guessed target. Per-session policy is `off|keep|handsoff` (handsoff detects and flags but never injects); cooldown and un-addressable flags persist under `~/.agents/.cache/state/watchdog/`. The `agents watchdog` command runs it without the menu-bar: bare = one dry tick (reports would-nudge/skip + why), `--nudge` injects for real, `--watch` is a daemon loop (`--interval`, default 30s), `--json` is machine-readable, and `--stall/--cooldown/--dormant` override thresholds. `runner.test.ts` drives real synthetic sessions through the pure logic (nothing mocked) with dry-run injection. Source: `src/lib/watchdog/runner.ts`, `src/commands/watchdog.ts`, `src/lib/startup/command-registry.ts`.
- The macOS menu-bar helper now auto-nudges from its native tick: `StatusItemController.tick()` reads the enable sentinel and runs one watchdog tick (`nudge=enabled`, detect-only when off), a checkable **Auto-nudge** menu row toggles it via `agents watchdog enable|disable` and shows `N stalled · M nudged`, and `AgentsCLI` gains `watchdogStatus()/watchdogTick(nudge:)/watchdogSetEnabled()` mirroring the `doctorOverview()` shell-and-decode pattern. `refreshWatchdog()` is throttled to a 30s floor (siblings: doctor 60s, routines 20s) so it doesn't spawn two node subprocesses on every 10s tick — still well under the 5-minute stall threshold. Source: `packages/menubar-helper/Sources/MenubarHelper/StatusItemController.swift`, `packages/menubar-helper/Sources/MenubarHelper/AgentsCLI.swift`, `src/commands/watchdog.ts`.

**VSCodium / Cursor / VS Code terminal backend (#608, #620)**

- A new `vscodium-agent` terminal backend opens each resumed session as an agent-terminal tab in a running VSCodium / Cursor / VS Code window — via the `swarm-ext` extension's `/spawn` URI verb — instead of scripting a GUI terminal app. It builds `<cli> --open-url '<scheme>://swarmify.swarm-ext/spawn?…'` (default VSCodium: `codium` / `vscodium://`); the editor CLI forwards the URL over its IPC socket, so it needs no OS scheme handler, works on Linux, and flows over `--host` (SSH) like the other backends — with no `zsh -ilc` wrap since the target is already an interactive login shell. The `{command, cwd, split}` payload is base64url-encoded into a single query param because VS Code percent-decodes `uri.query` once before the handler parses it (a bare `echo a && touch b` was otherwise truncated at the `&`). Wired into `sessions resume` as `--vscodium`; auto-detect is intentionally omitted (`TERM_PROGRAM=vscode` can't disambiguate the three products). Because VSCodium agent terminals open as individual full-width editor tabs, this backend defaults packing to one tab per session (`--tabs` still forces tabs elsewhere). Source: `src/lib/terminal/backends/vscodium-agent.ts`, `src/lib/terminal/index.ts`, `src/commands/sessions-resume.ts`.

**`agents sync <repo>`: git-sync a single DotAgent repo (#535)**

- Giving a DotAgent repo name alone — `agents sync system` / `agents sync user` / `agents sync <alias>` — now git-syncs just that one repo instead of running the umbrella reconcile. The new `syncRepoGit` refuses on a dirty working tree (commit or discard first), otherwise `git fetch origin` + `git pull --rebase origin <branch>` against the repo's own HEAD branch (falling back to `main`), reinstalls the git hooks, and reports the resulting short commit. The `user` repo and enabled extra-repo aliases also `git push` local commits up; `system` is a pull-only mirror of the npm-shipped upstream (`push: false`). `project` and unknown names are rejected — the project `.agents/` lives inside the user's own repo and isn't independently synced. This repo-name form is matched before agent-spec parsing, since names like `system`/`user` would otherwise fail `parseAgentSpec`. Source: `src/lib/git.ts`, `src/commands/sync.ts`.
- Bare `agents sync` no longer eager-fetches secrets and sessions: the umbrella planner now defaults to config repos + reconcile only, with secret bundles and session transcripts made opt-in via `--secrets` / `--sessions` (pulling every secret bundle onto a machine was more blast radius than a bare sync should carry; transcripts stay queryable on demand via `agents sessions --host <machine>`). Interactive bare `agents sync` (TTY, no flags) now drops into a two-checklist picker — which repos to sync FROM, which installed agents to sync INTO — then pull-only freshens the selected repos and reconciles a single merged selection into each agent, unioned across repos via `mergeRepoScopedSelections` / `unionResourceSelections`. Source: `src/lib/sync-umbrella.ts`, `src/lib/versions.ts`, `src/commands/sync.ts`.

**Split `agents.yaml` into portable, per-device, and machine-local files (#538)**

- The committed central `~/.agents/agents.yaml` used to carry machine-specific fields and was held back with a `git skip-worktree` band-aid so it wouldn't sync. It's now partitioned by sync-domain: `agents:` (version pins) moves to per-device `~/.agents/devices/<machineId>/agents.yaml` (committed and synced, but each machine only writes its own folder so pulls never conflict), `versions:` (per-version resource tracking) moves to gitignored, machine-local `~/.agents/.history/version-resources.json`, and central `agents.yaml` is left portable. `writeMetaUnlocked` writes the device and history files BEFORE stripping and rewriting central, so a crash mid-write never drops pins/versions before they persist; `readMeta` overlays the machine-local files back on via `overlayMachineLocal` (device pins win and self-heal a pre-migration central). Source: `src/lib/state.ts`, `src/lib/machine-id.ts`.
- Migration `migrateSplitDeviceLocalMeta` (sentinel bumped to `v11`) performs the one-time split on raw YAML, merging into any existing device/history files (existing entries win) via `atomicWriteFileSync`, and only rewrites central when it actually carries machine-local fields — a portable-only `agents.yaml` is left byte-untouched — while always clearing the `skip-worktree` bit so every machine's file syncs cleanly. The meta cache stamp is now a `|`-delimited string of all four source files' mtimes rather than a numeric sum that could round sub-unit device/history changes away and serve stale reads in long-lived processes. `machineId()` / `normalizeHost()` were extracted to a dependency-free leaf module so low-level `state.ts` can key per-device paths without an import cycle. Source: `src/lib/migrate.ts`, `src/lib/machine-id.ts`, `src/lib/session/sync/config.ts`, `src/index.ts`.

**`agents sessions`: the interactive picker now shows origin machine, PR/ticket, and worktree columns**

- Every discovered session carries the machine it originated on — the local box for live-home transcripts, or the origin host parsed from the cross-machine mirror layout (`backups/<agent>/<machine>/…`) — recorded on `SessionMeta.machine` by `discoverSessions`. The picker row, previously stuck on `shortId · agent · version · project · topic · when`, now folds in a gray machine column (only when the pool spans >1 box, with the longest shared dash-delimited prefix stripped so `yosemite-s0`/`yosemite-s1` read as `s0`/`s1`), a blue `PR#`/ticket column (only when some row carries a ref), and a magenta `wt:<slug>` worktree badge. Column flags are computed once over the whole pool via `pickerColumnsFor` and shared by both the browse picker and the multi-select resume picker, and the topic width is now terminal-aware so the extra columns never wrap.
- A dim `subtitle` hint line renders between the header and the rows (new `subtitle` field on `PickerConfig`/`SessionPickerConfig`), rotating a `Tip:` that surfaces the filter flags (`-a/--agent`, `--project`, `--all`, `-H/--host`, `--since`/`--until`), keyed off pool size so it stays fixed across re-renders. Fixed a wrap bug where the resume picker prepends a 6-cell `> [x] ` gutter but `formatPickerLabel` reserved only the 2-cell single-select cursor, overflowing every row by 4 cells and halving the viewport; the gutter width (2 browse, 6 resume) now threads through `PickerColumns` and is reserved from the topic width. Source: `src/commands/sessions.ts`, `src/commands/sessions-resume.ts`, `src/commands/sessions-picker.ts`, `src/lib/picker.ts`, `src/lib/session/discover.ts`, `src/lib/session/types.ts`.

**Reach Windows peers over `--host` (RUSH-1429)**

- The SSH command layer gained a PowerShell dialect so `--host` operations can target Windows remotes, where ssh lands in `cmd.exe`/PowerShell and `bash -lc` does not exist. `remoteShellFor(os)` routes `windows → powershell` and everything else (including unknown/absent) → posix, so linux/macOS never regress; `buildWindowsAgentsCommand` emits `powershell -NoProfile -EncodedCommand <base64-utf16le>`, which survives `cmd.exe` re-parsing with zero quoting hazards. The peer OS is resolved from the tailscale-synced device registry (fleet fan-out) or the enrolled `HostEntry.os` (explicit `--host`). This fixes `agents sessions --host` / `--active` and remote secrets reads (browse + use-a-remote-bundle), which previously wrapped the remote invocation in `bash -lc` and got `'bash' is not recognized` from a Windows peer. The `secrets export/import --host` write path stays POSIX-only for now (documented follow-up). Source: `src/lib/hosts/remote-cmd.ts`, `src/lib/hosts/remote-os.ts`, `src/lib/devices/registry.ts`.

**Windows portability + CI hardening**

- `agents sessions … resume` no longer crashes on Windows with `spawn EFTYPE`: `resumeSessionInPlace` spawned the version-pinned launcher (`claude@2.1.196`) with `shell:false`, but on Windows that shim is a `.cmd`/extensionless file, so spawn threw synchronously and the error was mis-reported as a discovery failure. It now spawns through the shell on Windows via `needsWindowsShell` and reports a synchronous launch failure truthfully. The generated hook-cache shim also hardcoded `python3` for its hash/timer/mtime, but on Windows `python3` is often the Microsoft Store execution-alias stub (prints to stderr, exits non-zero, 0 bytes) — silently emptying `mtime` so every call missed the cache and re-ran the hook; it now probes for a runnable interpreter (`python3`, then `python`) by executing `-c 'import sys'`. Source: `src/commands/sessions.ts`, `src/lib/hooks/cache.ts`.
- Two new CI guards keep these Windows-only, separator-prone bugs from reaching a release: a path-filtered `test-windows` job runs the suite on `windows-latest` for changes under hooks/platform/shims (the required `test` gate runs on `ubuntu-latest`, where `path.sep` is `/`, so a backslash-path bug is invisible), and `toPortableCommand` is now pure/exported with injectable home + separator so a unit test can assert Windows `C:\…` → `~/…` folding on any host. Separately, a `prepare: npm run build` hook rebuilds the gitignored `dist/` on every install/link (and before `npm publish`), so a dev-linked checkout can't silently run a stale `dist/` behind a source fix. Source: `.github/workflows/tests-windows.yml`, `package.json`.

**License: MIT → Apache-2.0 (#504)**

- The project relicenses from MIT to Apache-2.0. `LICENSE`, `README`, and `package.json` carry the new license, and the human-facing docs (the `AGENTS.md` brand lines, the `CONTRIBUTING.md` CLA clause, `DESIGN.md`) were aligned so the stated license is consistent everywhere.

**Security hardening batch (#474–#478)**

- **Shell / option injection.** `agents inspect` no longer builds its `git` call as a shell string: a crafted repo path could inject via `$(…)` or other shell syntax through `execSync(\`git -C ${…} ${args}\`)`. It now uses argv-form `execFileSync('git', ['-C', root, …args])`, so the path can never reach a shell (#474). Separately, MCP server management rejects a server name that starts with `-` or contains whitespace/control characters and places every user-controlled positional after `--`, closing an option-injection vector (#478). Source: `src/commands/inspect.ts`, `src/lib/mcp.ts`.
- **Path-traversal containment.** Plugin resolution rejects a plugin name that resolves to the plugins root itself, so a crafted name can't escape or target the directory root (#475). Hook-shim generation validates the shim name before constructing any path and asserts the resolved shim path stays inside the shims directory — rejecting separators, traversal components (`..`), NUL bytes, and leading dashes (#477). Source: `src/lib/plugins.ts`, `src/lib/hooks.ts`, `src/lib/hooks/cache.ts`.
- **Supply-chain.** Per-version agent installs now run `npm install --ignore-scripts`, so a dependency's install/postinstall lifecycle script can't execute arbitrary code during an `agents` version install (#476). Source: `src/lib/versions.ts`.

## 1.20.35

**CI: build node-pty's native binary on macOS/Windows so the release matrix is green cross-platform**

- The cross-platform matrix (`ci.yml`, runs only on `release/**` + `v*`) installed deps with `bun install --ignore-scripts`, so `pty.node` from `@homebridge/node-pty-prebuilt-multiarch` was never fetched/built. That package ships prebuilt binaries only for Linux; macOS/Windows obtain `pty.node` via its own install script (prebuild-install download, else a node-gyp compile). With that script skipped the native module was absent, so the daemon-liveness integration test added in #568 — which spawns the real daemon (it loads node-pty) and asserts the browser IPC socket stays up — crashed on macOS/Windows while passing on Linux, and had been red on every release since. The matrix runs only on release branches, so it never surfaced on normal PRs (bun does not run that install script even without `--ignore-scripts` in bun 1.3.x). CI now runs a dedicated step that invokes the package's own install script (`npm run install`), which prefers a prebuilt download and falls back to a node-gyp compile, so it self-heals across platforms and node ABIs. Production (`npm install`) already built the native module, so end users were unaffected. A second macOS/Windows-only failure in the same #568 daemon-liveness test was also fixed: the test rooted its fake `HOME` under `os.tmpdir()`, which on macOS is the long `/var/folders/…/T/…`, pushing the daemon's AF_UNIX socket path to ~116 bytes — past macOS's 104-byte `sun_path` limit — so `bind()` failed with `EADDRINUSE`. The test now roots `HOME` at a short base on POSIX (Windows uses length-unlimited named pipes); real users with a normal `HOME` were never affected. Source: `.github/workflows/ci.yml`, `src/lib/daemon.test.ts`.

**`agents logs`: a top-level, unified run-log viewer (#575)**

- Viewing a dispatched run's output used to be nested and undiscoverable — only `agents hosts logs <id>` and `agents daemon logs` existed, and `agents hosts` wasn't even in `--help`. `agents logs [id]` is now a discoverable top-level command that resolves a run across **two substrates** — host-dispatch task stdout (`agents run --host`) and the local session index — and shows or (`-f`) follows it. `[id]`/`--session` load directly (host task tried first, then session); with no id, `--host`/`--agent`/`--version` filter a merged candidate list (one match shows, several open a fuzzy picker, non-TTY prints the list). Additive: `agents hosts logs` and `agents sessions tail` are unchanged and share the same helpers. Source: `src/commands/logs.ts`, `src/lib/hosts/logs.ts`.

**Host-follow log tailer: no self-corruption on localhost, byte-accurate offsets (#586, #589)**

- Following a run dispatched to **localhost** tripled the on-disk log and triple-printed the output, because the local mirror file and the remote log were the same file and the tailer appended its own reads back into it; it now detects that aliasing by file identity (`dev:ino`) and echoes only. Separately, the offset tracker advanced by a re-encoded string length, so a multibyte UTF-8 char split at a poll boundary drifted the offset and corrupted the stream on non-ASCII output; the tail is now byte-exact (raw `Buffer` via `sshExecRaw`). Source: `src/lib/hosts/progress.ts`, `src/lib/ssh-exec.ts`.

**`agents upgrade`: the "What's new" changelog is now a compact heading list (#562)**

- The post-upgrade changelog dumped every heading *and* every verbose sub-bullet for each version in the range — a screenful across a multi-version jump. It now prints one bullet per feature/fix heading and links to the full CHANGELOG for the details. The parser was extracted to a pure, unit-tested `renderWhatsNew` so it can be exercised without the CLI's import-time side effects. Source: `src/lib/whats-new.ts`, `src/index.ts`.

**`agents sessions --active`: a per-pid registry de-collapses co-located agents (#546)**

- On a host with no terminal extension (bare SSH/tmux — e.g. any Linux box), `--active` could only map a discovered agent process to a session by guessing the newest `.jsonl` in its cwd, so several agents in the same repo collapsed onto one session row (observed live: a single id listed 28 times), and `/restore` couldn't tell them apart. `agents run` now records each launch to `~/.agents/.cache/terminals/by-pid/<pid>.json` (`{agent, cwd, tmuxPane, sessionId, startedAtMs}`) — the headless equivalent of the terminal extension's `live-terminals.json` — so `--active` and `/restore` attribute each co-located agent correctly. Source: `src/lib/session/pid-registry.ts`, `src/lib/session/active.ts`, `src/lib/exec.ts`.

## 1.20.34

**Test suite runs remotely on a crabbox VM (#525, #540)**

- `scripts/release.sh`'s test gate now runs `bun install && bun run build && bun run test` on a leased crabbox VM via `scripts/sandbox.sh` instead of freezing the local machine, matching CI's Build→Test order (crabbox's sync honors `.gitignore`, so the gitignored `dist/` is built on the box). A new `bun run test:remote` offloads the suite the same way for local dev. Publishing still happens locally — only the signed macOS keychain helper can be produced and notarized here, and crabbox boxes are Linux. Source: `scripts/sandbox.sh`, `scripts/release.sh`, `package.json`.
- `scripts/sandbox.sh` box acquisition is now robust: secrets load via `agents secrets export --plaintext` (the bare form now hard-errors), a missing `.crabbox.yaml` no longer aborts the script under `set -e`, and the agents-cli/claude install is gated to PR mode so test-mode runs match GitHub CI. Box selection gates on `crabbox status … ready=true` — skipping failed-bootstrap duds (which still report `status=running`) and warming a fresh box if none are ready — keyed on the stable `profile` label rather than an ephemeral slug. A dedicated `agents-cli` crabbox profile (`.crabbox.yaml`) isolates this repo's warm pool. Source: `scripts/sandbox.sh`, `.crabbox.yaml`.

## 1.20.31

**`agents sessions <id>`: a catch-up digest for switching between many agents (#502)**

- Opening a single session now leads with its auto-inferred title (user `/rename` > Claude `ai-title` > first-prompt topic) and PR / worktree / ticket badges, then a **Changes** section that groups touched files by directory and tags each as created / modified / deleted (with a `+N ~N -N` summary) instead of the old flat "Modified" list, a **Tools** histogram (per-tool call counts), and a **Tests** verdict parsed from the last `vitest` / `jest` / `pytest` / `go test` / `cargo test` / `tsc` run. The same signals are folded into the interactive picker preview.
- `agents sessions --active` now collapses the many subagent/fork PIDs of one session into a single row with a `×N` count instead of printing dozens of identical lines. Source: `src/lib/session/digest.ts`, `src/lib/session/render.ts`, `src/lib/session/active.ts`, `src/commands/sessions.ts`, `src/commands/sessions-picker.ts`.

## 1.20.30

**`agents sessions` live state engine: waiting / PR / worktree / ticket detection + reliable preview (#494)**

- `agents sessions --active` infers real activity from each transcript's tail — **working** / **waiting** / **idle** — rather than the old mtime-only running/idle guess, using structural signals (Claude `ExitPlanMode` / `AskUserQuestion`) plus a question + mtime heuristic for Codex. It detects and badges a PR opened during the session (`gh pr create` + the resulting pull URL), a git worktree (`.agents/worktrees/<slug>/`), and a Linear/Jira ticket (from the prompt or branch), and shows the latest turn as the preview instead of the first prompt.
- `--waiting` filters `--active` to only sessions blocked on your input and exits non-zero (a scriptable gate); `--tree` groups the listing by directory, dropping the id/version columns while keeping the short-id handle.
- The preview line is now width-correct: measurement is ANSI- and wide-char-aware and reads `$COLUMNS` first, so it no longer wraps or drifts under tmux or over `--host` SSH (the remote is handed the caller's width). Session index schema v7 persists the PR / worktree / ticket signals so historical listings carry them too. Source: `src/lib/session/state.ts`, `src/lib/session/tail.ts`, `src/lib/session/width.ts`, `src/lib/session/{discover,db,active}.ts`, `src/commands/sessions.ts`.

**`agents sessions --host <machine>`: query a remote machine's sessions live over SSH**

- `agents sessions "<query>" --host <alias|user@host>` runs the same session query on a remote machine's own index over SSH and streams the result back — repeat `--host` (or pass several) to fan out across machines. SSH access is the only auth; there's no daemon or shared store. Targets are validated against a strict allowlist (`SSH_TARGET_RE`) to block flag-smuggling, and the forwarded invocation is double-quoted (`shellQuote`) so a query like `$(whoami)` survives as a literal string on both shell layers. Source: `src/lib/session/remote.ts`, `src/commands/sessions.ts`, `docs/05-sessions.md`.

**Fix: migrations + menu-bar self-heal were silently disabled on Homebrew-node installs**

- The "is this a dev build?" check walked `dirname(dirname(argv[1]))` looking for a `.git`, without resolving the bin symlink. On a Homebrew-node setup `agents` is `/opt/homebrew/bin/agents`, so it walked up to `/opt/homebrew` — **which is itself a git repo** — and false-positived as a dev build. Dev builds auto-set `AGENTS_SKIP_MIGRATION=1`, which gates **both** one-shot migrations **and** the menu-bar upgrade self-heal. Net effect: every Homebrew-node user ran with migrations and the menu-bar refresh permanently off.
- Detection now `realpath`s the entrypoint (so a symlinked bin resolves into the real package dir) and requires the `.git`'s repo root to actually be the `@phnx-labs/agents-cli` package — an unrelated ancestor repo no longer counts. Extracted to `src/lib/startup/dev-build.ts` with tests covering the Homebrew symlink layout, a real checkout, and unrelated-ancestor cases.

**Secrets default policy is now `daily` (one Touch ID per ~24h), not `always`**

- The default prompt policy for bundles without an explicit one flipped from `always` (Touch ID on *every* read) to **`daily`** (one prompt, then held ~24h until screen-lock / sleep / logout). This is the fix for the prompt storm: a background reader like sessions-sync hammering a bundle now costs one Touch ID per ~24h instead of one per read.
- **Auto-cache is on by default.** The secrets-agent is the mechanism that delivers the daily policy, so it self-caches a `daily` bundle on first read with no `secrets.agent.auto: true` needed. Opt out with `secrets.agent.auto: false`.
- **Configurable, still flexible.** Set the global default in `agents.yaml` (`secrets.policy: always` to restore prompt-every-time), or override per bundle with `agents secrets policy <bundle> always` for high-value keys (signing, SSH) you want to confirm on every read.
- **Explicit `always` now persists** under the legacy `tier: biometry` token (older CLIs read it as their own always default). Bundles with no stored policy inherit the configured default — so an existing always-by-default bundle quietly becomes `daily` on first read by the new CLI, which is the intended migration.

**Menu bar: a macOS status item for agent activity (`agents menubar`)**

- New no-Dock menu bar app showing live agent activity on the machine: a **NEEDS YOU** section (sessions awaiting input + failed/overdue routines), a per-agent **roster** (running / idle counts across installed agents), a **+ New session** launcher, and a one-line routines summary. The icon badges red `!` when something needs you, green with a count when sessions are running.
- Reads state **directly from disk** — `live-terminals.json`, teams `meta.json`, and the cloud `tasks.db` — so opening the menu never triggers the costly sessions transcript re-index. The CLI is shelled only for actions (start a session, run a routine).
- **Auto-enabled on macOS** for every user as a launchd login service (`com.phnx-labs.agents-menubar`); a fresh install brings the icon up with no manual step. Manage with `agents menubar enable | disable | status`. Opt out with `agents menubar disable` — sticky across upgrades.
- **Upgrade self-heal:** the installed bundle is version-stamped, and the startup self-heal now re-installs the helper when a newer release ships a newer build (or the installed copy goes missing), instead of skipping whenever a service already existed. So `npm update` actually moves users onto the new helper binary + plist rather than leaving the old one running (#442). `agents menubar status` shows installed vs current version and staleness.
- Docs: [Menu bar](docs/menubar.md). macOS only.

**`agents repos view [name]`: inspect one repo's contents without opening it**

- New `agents repo view <name>` (also reachable as `agents repos view`, now a first-class alias of the `repo` command) prints a single repo's git state and per-kind resource counts — `system`, `user`, `project`, or an extra-repo alias. Omit the name for an interactive picker over the registered repos. It reuses the `inspect` repo renderer, so output matches `agents inspect <repo>`; supports `--brief` and `--json`. Source: `src/commands/repo.ts`, `src/commands/inspect.ts`.

**`agents doctor --fix` + a daemon safety check: heal the gap between defined and installed**

- Root cause behind "a plugin/command silently vanished": a DotAgents repo can DEFINE a resource that never makes it into an agent home, and nothing closes the gap. Two concrete failure modes — (1) `agents plugins update`/`sync` only reconcile each agent's **default** version, so a non-default installed version keeps serving stale/invalid resources; (2) a plugin.json with a bare-name `skills`/`commands` field makes Claude Code **silently reject the entire plugin**, and the sync path only *warned*. The detection (`agents doctor`'s live-home diff) and the healing (`syncResourcesToVersion`) existed but were never wired together — and the sync fast-guard keyed off the staleness manifest, which is blind to home-side rot.
- **`agents doctor --fix`** turns the read-only diagnosis into a heal: installs missing resources, repairs Claude-invalid plugin manifests (strips the bare `skills`/`commands` field — Claude auto-discovers from the dirs), fast-forwards stale plugins from their `.source`, and reconciles drift — across **every installed version**, not just defaults. With no target it heals the whole install; `agents doctor <agent> --fix` scopes to one.
- **Daemon safety check:** the routines daemon now runs the same heal in conservative `safe` mode (~every 6h + ~30s after start) — it fixes only unambiguous gaps (missing resources, invalid manifests, *provably-unmodified* stale plugins) and **notifies rather than clobbers** on hand-edited content or a plugin it can't prove is pristine.
- Built on the **live-home diff**, not the staleness manifest, so it catches drift the sync fast-guard can't. Heal **fills and fixes, never deletes** (orphans stay `agents prune cleanup`'s job), excludes the project layer (the global home isn't reconciled against per-cwd project resources), and **verifies after writing** — it only claims resources that actually reconciled, so repeated runs converge instead of "fixing" the same item forever.
- `.source` now records the plugin version at pull time, a baseline that lets the safe path tell an untouched mirror (fast-forward) from a user edit (leave alone).
- **`agents doctor` overview now covers every installed version, not just defaults.** Sync status and orphans previously reported only each agent's default version — so a stale NON-default version (the exact rot `--fix` heals) was invisible in the readout. Each version is now listed with its default marked. The **Agent CLIs** list also stops nagging: it shows the agents you actually run (ready, or managed-but-broken) and collapses the rest of the supported catalog to a single `+N more supported …` hint instead of a column of red "not installed" lines for tools you never adopted.
- **Says exactly WHAT is out of sync — plugins first.** A stale version in the overview now lists the specifics under it, prioritizing plugins and their bundled content: `plugin code — 0.6.1→0.7.0, missing skills: ship, learn`. The plugin diff went from presence-only ("installed: yes") to **content-aware** — it compares the version's marketplace mirror against the central source and surfaces a stale mirror version, a Claude-invalid manifest, and the plugin's own skills/commands that never reached the mirror (the system-repo content that matters most). `agents doctor <agent>@<version>` shows the same detail per plugin row.
- **Fixed a false "drift" that could never be reconciled:** a hook's `.md`/`.rst` doc sibling (e.g. `git-guard.md` next to `git-guard.sh`) was wrongly treated as the hook's runtime *data file*, so the installer's correct omission of docs showed as perpetual drift in `doctor` (and as an un-healable item under `--fix`). Docs are no longer counted as hook data; structured siblings (`.yaml`/`.json`/...) still are.
- **Corrected a false promise in the sync-status readout.** Stale/cold versions used to say "will sync on next launch" / "first launch will populate" — but version homes are NOT reconciled on launch (the shim hot path only resolves a version and compiles project-scoped resources; v15/v16 moved version-home reconciliation to management commands). The readout now states the fact ("sources changed since last sync" / "never synced") and points at the real fix: `agents doctor <agent>@<version> --fix` or `agents sync <agent>@<version>`.

**Secrets prompt policy: human-readable `always` / `daily`, and `secrets list` now shows it**

- Renamed the secrets-agent `tier` to a **prompt policy** with plain-language names: `biometry` → **`always`** (ask every time), `session` → **`daily`** (ask once, then held ~24h until screen-lock / sleep / logout). The old name `session` was misleading — it never meant "once per login session" — and collided with the half-dozen other "session" concepts in the CLI (`agents sessions`, sessions-sync, pty/browser sessions). Set it with `agents secrets policy <bundle> [always|daily]`.
- **Disclosure fixed.** `agents secrets list` now has a `POLICY` column — previously there was no way to tell which bundles would Touch-ID-prompt you. `daily` bundles currently held by the agent show `daily · Nh left`. `agents secrets view` and `create` now always state the policy (before, only the quiet tier was shown; the noisy default printed nothing).
- **Back-compat:** the policy still persists under the legacy `tier`/`session` token, so bundles stay readable across mixed CLI versions on synced machines. `agents secrets tier`, `--tier`, and the `biometry`/`session` values keep working as aliases.
- A third **`never`** policy (silent, no biometry ACL) is tracked for later in #421.

**Self-healing: long-running processes reload onto new code after an upgrade**

- Root cause behind a class of "stale behavior" bugs: a routines daemon or secrets-agent broker keeps running **pre-upgrade code** for days. An in-place `npm i -g` swaps the files but not the running processes, so fixes (keychain read-memoization, the broker fast-path, etc.) silently never take effect — the daemon kept popping Touch ID from the keychain because it predated the fix.
- **Heal-on-upgrade:** `postinstall` now bounces the routines daemon and kickstarts the persistent secrets-agent broker onto the just-installed code — the one moment we know the code changed. Best-effort, non-fatal, skipped in CI / with `AGENTS_NO_HEAL=1`.
- **Broker version-skew self-heal:** the broker's `ping` reports the version of the code it's running; `ensureAgentRunning` (the unlock / auto-cache path, never per-read) restarts a broker found running stale code, and a persistent broker self-exits on detecting an in-place upgrade so launchd relaunches it fresh. New `getCliVersionFresh()` re-reads `package.json` to detect the swap.
- No hot-path cost: all checks live on existing control-plane paths (postinstall, the broker sweep, `ensureAgentRunning`), never on a per-secret-read. macOS only. Complements #412 (daemon session-sync memoization) by ensuring the daemon actually *runs* that code.

**`agents secrets start`: persistent secrets-agent service (fixes the broker under heavy load)**

- On a heavily-loaded machine (many concurrent agents, high load average) the on-demand broker — a full CLI cold-start — couldn't get scheduled enough CPU to finish booting and bind its socket, so `unlock`/auto-cache silently failed and reads kept prompting. New `agents secrets start` installs the broker as a **launchd user service** (`RunAtLoad` + `KeepAlive`, `ProcessType: Interactive` for foreground scheduling priority): it starts once and stays up for the whole login session, so every read just connects — the cold start happens once (and launchd retries until it wins), never per read. `agents secrets stop` removes it; `agents secrets status` shows whether it's installed.
- `unlock` and the auto-cache worker now install/kickstart this service automatically via `ensureAgentRunning`, falling back to the old one-off detached spawn only if the service path is unavailable. So the persistent broker is set up on first use with no extra step.
- macOS only. Security model unchanged: in-memory only, per-bundle TTL, wiped on screen-lock/sleep.

**Fix: secrets-agent auto-cache now survives a slow broker cold-start under load**

- `secrets.agent.auto` (auto-cache on first read of a `session`-tier bundle) used a fire-and-forget inline loader that gave up connecting to the broker after 3s. But the broker it spawns is itself a full CLI cold-starting; under heavy load (many concurrent agents) that can exceed 3s, so the loader quit before the broker bound and the cache silently never populated — every read kept prompting. The auto-load now runs through a detached `secrets _agent-load` worker that reuses the robust `ensureAgentRunning` path (spawn-then-ping, 20s budget) and loads synchronously, so it reliably populates even when the broker is slow to start. Manual `agents secrets unlock` was always reliable and is unchanged. (secret values still travel over stdin, never argv.)

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
