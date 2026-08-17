---
kind: plan
surface: cli
title: Remove the plaintext secrets export — injection becomes the only agent path
summary: Agents copy `eval "$(agents secrets export <b> --plaintext)"` from our own scripts and dump whole bundles into transcripts. Delete the plaintext printers, keep injection (`secrets exec`) as the only agent path, and backstop older CLIs with a fleet guard.
status: awaiting-review
tracking: "RUSH-2774"
links:
  - "https://linear.app/phnx/issue/RUSH-2774"
facts:
  - 263 local session transcripts contain a live `secrets export` use; 577 hits on the single-key `--plaintext | grep | cut` variant
  - The screenshot command (`eval "$(agents secrets export hetzner.com --plaintext)"`) is verbatim apps/cli/scripts/sandbox.sh:41
  - "`secrets exec` already injects values into the child env only — the paved road exists; the plan removes the leaky shortcut beside it"
---

## Focus for review

- **`secrets export`'s shell-print mode is deleted** — the `KEY=VALUE` eval surface is gone for every caller; a destination (`--device` / `--to-1password` / `--to-file`) is required. Breaking for any third-party eval script.
- **`get <bundle> <KEY>` is removed unconditionally** (replacement: `agents secrets exec <b> -- printenv KEY`); the raw-item `get <item>` and `view --reveal` refuse inside agent sessions (markers: `AGENTS_RUNTIME`, `AGENT_SESSION_ID`, `AGENTS_SESSION_ID`, `CLAUDECODE`), and `view --reveal` loses its non-TTY `--plaintext` escape. Right marker set? Right strictness split?
- **Version-skew stance:** the SSH remote-resolve transport keeps the legacy argv but is gated on a dedicated env marker — so a **new driver still resolves from an old remote** during rollout; an old driver against a new remote fails loud with an upgrade hint. No silent fallback.
- **Accepted residual:** `agents secrets exec <b> -- env` still prints values — deliberate, audited, cumbersome; not blocked at the CLI level (the fleet guard can flag it later).

## Intent

Muqsit: *"reduce the probability that agents can exfiltrate the secret … there should probably be a command that enables you to do this export, but maybe it's still cumbersome, maybe it's using agents secrets exec and then you have to write some script. I don't think it should be direct plaintext reveal."*

## Purpose

Every secret printed by a Bash tool call lands in the model's context **and** the session `.jsonl`, which syncs across the fleet. `secrets export --plaintext` turns that into a one-liner for a whole bundle, and agents reach for it reflexively because our own scripts, `--help` example, docs quick-reference, and two skills teach exactly that line. The injection path (`secrets exec`, `run --secrets`) already covers every legitimate automation use without materializing anything.

<div class="artifact-callout">
The load-bearing insight: agents do not invent the exfil pattern — they copy it from the repo. Removing the command AND its eight teaching sites is one delivery; either half alone leaves the reflex intact.
</div>

## Current architecture

`docs/secrets-trust-boundaries.md` names two data paths. Path A (inject) puts resolved values only in a child process env (`buildSecretsExecEnv`, `commands/secrets.ts:484-497`). Path B (materialize) prints to stdout: `export --plaintext` (`secrets.ts:2413-2443`), `get` (`:1618-1663`), `view --reveal --plaintext` (`:1431`, `:1546`). The SSH machine-to-machine resolve (`remoteResolveEnv`, `lib/secrets/remote.ts:224-297`) rides Path B's `--format json` mode; `verifyRemoteKeychainPush` (`remote.ts:426`) reuses it for push read-back.

<svg viewBox="0 0 860 360" role="img" aria-label="Secret value data paths before and after" width="860" height="360">
  <defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0L8,4L0,8z" fill="currentColor"/></marker></defs>
  <text x="20" y="28" fill="currentColor" font-size="13" font-weight="600" font-family="sans-serif">Before</text>
  <rect x="20" y="44" width="130" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.4"/><text x="34" y="70" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">keychain / broker</text>
  <rect x="230" y="44" width="150" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.4"/><text x="244" y="70" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">resolve in memory</text>
  <path d="M150,66 H228" fill="none" stroke="currentColor" stroke-width="1.4" marker-end="url(#a)"/>
  <rect x="470" y="14" width="170" height="44" rx="8" fill="none" stroke="#3a9a5f" stroke-width="1.4"/><text x="484" y="40" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">child process env</text>
  <path d="M380,56 C420,46 430,40 468,36" fill="none" stroke="#3a9a5f" stroke-width="1.4" marker-end="url(#a)"/>
  <text x="472" y="8" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">exec / run --secrets (Path A)</text>
  <rect x="470" y="88" width="170" height="44" rx="8" fill="none" stroke="#d64545" stroke-width="1.4"/><text x="484" y="114" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">stdout → transcript</text>
  <path d="M380,76 C420,86 430,92 468,110" fill="none" stroke="#d64545" stroke-width="1.4" marker-end="url(#a)"/>
  <text x="472" y="152" fill="#d64545" font-size="12" font-family="sans-serif">export --plaintext · get · view --reveal (Path B)</text>
  <rect x="680" y="88" width="160" height="44" rx="8" fill="none" stroke="#d64545" stroke-width="1.4"/><text x="694" y="106" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">agent context +</text><text x="694" y="122" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">session .jsonl (synced)</text>
  <path d="M640,110 H678" fill="none" stroke="#d64545" stroke-width="1.4" marker-end="url(#a)"/>
  <text x="20" y="212" fill="currentColor" font-size="13" font-weight="600" font-family="sans-serif">After</text>
  <rect x="20" y="228" width="130" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.4"/><text x="34" y="254" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">keychain / broker</text>
  <rect x="230" y="228" width="150" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.4"/><text x="244" y="254" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">resolve in memory</text>
  <path d="M150,250 H228" fill="none" stroke="currentColor" stroke-width="1.4" marker-end="url(#a)"/>
  <rect x="470" y="198" width="170" height="44" rx="8" fill="none" stroke="#3a9a5f" stroke-width="1.4"/><text x="484" y="224" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">child process env</text>
  <path d="M380,240 C420,230 430,224 468,220" fill="none" stroke="#3a9a5f" stroke-width="1.4" marker-end="url(#a)"/>
  <text x="472" y="192" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">exec / run --secrets — unchanged</text>
  <path d="M380,260 C410,270 420,276 448,288" fill="none" stroke="#d64545" stroke-width="1.4" marker-end="url(#a)"/>
  <line x1="440" y1="300" x2="472" y2="272" stroke="#d64545" stroke-width="2.2"/>
  <line x1="440" y1="272" x2="472" y2="300" stroke="#d64545" stroke-width="2.2"/>
  <text x="486" y="292" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">export --plaintext deleted · get / view --reveal refuse under agent markers</text>
  <rect x="470" y="310" width="250" height="40" rx="8" fill="none" stroke="currentColor" stroke-width="1.4"/><text x="484" y="328" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">marker-gated json transport (SSH only;</text><text x="484" y="343" fill="currentColor" opacity="0.75" font-size="12" font-family="sans-serif">refuses under agent markers)</text>
  <path d="M380,266 C410,290 430,318 468,328" fill="none" stroke="currentColor" stroke-width="1.4" marker-end="url(#a)"/>
</svg>

*Legend: green = value stays in a child env (invisible to the agent); red = value printed to stdout (enters context + transcript). The "after" half deletes the red path; the only remaining JSON emitter is the SSH transport shape, gated on `AGENTS_SECRETS_REMOTE_TRANSPORT=1` and refused under agent env markers.*

## Behavior — current vs proposed

<div class="artifact-grid artifact-grid-2 artifact-behavior">
<div class="artifact-panel" data-state="current" data-evidence="mockup">

**Today — one reflexive line exfiltrates a whole bundle**

```console
$ eval "$(agents secrets export hetzner.com --plaintext 2>/dev/null)"; crabbox list
# every KEY=VALUE of hetzner.com is now in the Bash tool output →
# model context → session .jsonl → fleet transcript sync

$ agents secrets export npmjs.com --plaintext | grep NPM_TOKEN | cut -d= -f2-
npm_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

</div>
<div class="artifact-panel" data-state="proposed" data-evidence="mockup">

**After — export refuses; the pointers name the paved road**

```console
$ agents secrets export hetzner.com --plaintext
error: unknown option '--plaintext'

$ agents secrets export hetzner.com
export no longer prints values. Pick a destination:
  --device <host> | --to-1password | --to-file <path>
Run a command with the values injected instead:
  agents secrets exec hetzner.com -- <cmd>
Reveal one value at your terminal:
  agents secrets view hetzner.com --reveal

$ agents secrets get npmjs.com NPM_TOKEN
'secrets get <bundle> <KEY>' has been removed — printing a bundle
value to stdout is the exfiltration path this blocks.
Use: agents secrets exec npmjs.com -- printenv NPM_TOKEN
```

</div>
</div>

Humans at a plain shell keep the raw-item `get <item>` and TTY `view --reveal`. The deliberately-cumbersome escape hatch is composition under injection: `agents secrets exec npmjs.com -- bash -c '…$NPM_TOKEN…'` — a conscious act, recorded by the value-free audit stream.

## Proposed Changes

### 1. `apps/cli/src/lib/secrets/headless.ts` — the agent-context predicate (done in worktree)

```diff
+export function isAgentInvocationContext(env: NodeJS.ProcessEnv = process.env): boolean {
+  return Boolean(
+    env.AGENTS_RUNTIME ||
+    env.AGENT_SESSION_ID ||
+    env.AGENTS_SESSION_ID ||
+    env.CLAUDECODE,
+  );
+}
```

Platform-independent and TTY-independent (an agent inside tmux has a TTY): this guards the materialization boundary, not the biometry-prompt boundary that `isHeadlessSecretsContext` owns.

### 2. `apps/cli/src/commands/secrets.ts` — export loses its printer; the transport survives behind a marker

```diff
     .command('export [bundle]')
-    .description('Resolve a bundle and print KEY=VALUE lines, push it to a 1Password vault…')
-    .option('--plaintext', 'Acknowledge that the resolved values will be printed in the clear (shell export mode)')
+    .description('Push a bundle to remote machine(s) over SSH with --device, to a 1Password vault with --to-1password, or to an encrypted file with --to-file.')
+    .addOption(new Option('--plaintext', '(internal transport)').hideHelp())
+    .addOption(new Option('--format <json>', '(internal transport)').hideHelp())
     .option('--to-1password', …)
     .option('--device <target...>', …)
-    .option('--format <shell|json>', 'Output for --plaintext export: shell (default) or json…', 'shell')
     .option('--to-file <path>', …)
```

In the action tail (`:2409-2443`): the `export KEY=VALUE` shell-print loop is **deleted — nothing resurrects it**. The `--format json` branch survives solely as the SSH machine-to-machine transport, double-gated:

```diff
-        if (!opts.plaintext) {
-          console.error(chalk.red('export prints secrets in the clear and requires --plaintext…'));
-          process.exit(1);
-        }
-        …shell print loop / json branch…
+        const transport = process.env.AGENTS_SECRETS_REMOTE_TRANSPORT === '1'
+          && opts.plaintext && opts.format === 'json' && !isAgentInvocationContext();
+        if (!transport) {
+          …refusal: "export no longer prints values" + destinations + exec/view pointers; exit 1…
+        }
+        const { env } = readAndResolveBundleEnv(resolvedBundleName, { caller: 'remote resolve transport', keyMode: 'process', agentOnly: true });
+        process.stdout.write(JSON.stringify(env));
```

`get <bundle> <KEY>` (`:1641-1663`) is **removed unconditionally** — the refusal names `agents secrets exec <b> -- printenv KEY`. The raw-item `get <item>` (`:1620-1639`) stays but refuses under `isAgentInvocationContext()`. `view` loses the `--plaintext` option and its non-TTY escape (`:1367`, `:1381`, `:1431-1434`, `:1546-1549`); `--reveal` refuses when `!isInteractiveTerminal() || isAgentInvocationContext()`, checked before the `--device` passthrough (`:1374`). The `--help` example block (`:1062-1069`) drops the eval recipe and leads with `exec`.

### 3. `apps/cli/src/lib/secrets/remote.ts` — marker injection, zero new plumbing

```diff
   const remoteCmd = buildRemoteAgentsInvocation(
     ['secrets', 'export', bundle, '--plaintext', '--format', 'json'],
-    undefined, osForTarget(target, opts.osLookupName),
+    undefined, osForTarget(target, opts.osLookupName),
+    { AGENTS_SECRETS_REMOTE_TRANSPORT: '1' },
   );
```

Same in `verifyRemoteKeychainPush` (`:432`). `buildRemoteAgentsInvocation` already prepends env assignments to the remote shell string (`lib/hosts/remote-cmd.ts:196-244`, used today for PATH shims), so both directions of version skew resolve cleanly: a **new driver → old remote works unchanged** (old code ignores the marker and accepts the argv), and an **old driver → new remote fails loud** through the existing `"Is the remote agents-cli new enough…"` parse-error path (`remote.ts:258-261`). No silent fallback.

### 4. First-party scripts — the copy-sources become injection

`apps/cli/scripts/sandbox.sh:41,51,119` — one guarded self re-exec replaces the three evals:

```diff
-if [[ -z "${HCLOUD_TOKEN:-}" ]]; then
-  eval "$(agents secrets export hetzner.com --plaintext 2>/dev/null)" || die "…"
-fi
+# Re-enter under `agents secrets exec` chains: values ride the child env, never stdout.
+# CI (env-provided tokens) and boxes without a bundle skip the corresponding link.
+if [[ -z "${AGENTS_SANDBOX_EXEC:-}" && -z "${HCLOUD_TOKEN:-}" ]] && command -v agents >/dev/null; then
+  chain=(); for b in hetzner.com github.com anthropic.com; do
+    agents secrets list --json 2>/dev/null | grep -q "\"$b\"" && chain+=(agents secrets exec "$b" --)
+  done
+  [[ ${#chain[@]} -gt 0 ]] && AGENTS_SANDBOX_EXEC=1 exec env AGENTS_SANDBOX_EXEC=1 "${chain[@]}" "$0" "$@"
+fi
```

`apps/cli/scripts/release.sh:266` (`resolve_npm_auth`) needs one value, so it uses the established printenv-capture idiom (`docs/secrets.md:675,679`): `NPM_TOKEN="$(agents secrets exec npmjs.com -- printenv NPM_TOKEN)"` — the `.npmrc` writing and `npm whoami` verification are unchanged. `apps/ext/scripts/release.sh:344` (two PATs used downstream) self re-execs under `agents secrets exec vs-marketplace -- "$0" "$@"` behind its existing unset-env guard.

### 5. Docs, spec, skills, CHANGELOG (same delivery)

| File | Change |
|---|---|
| `docs/secrets.md` | Drop the eval quick-reference row (`:415`) + recipe (`:613`) + "automation primitives" framing (`:21-40`); exec-first everywhere |
| `docs/secrets-trust-boundaries.md` | Path B table shrinks; export row removed; agent-gate noted on `get`/`view --reveal` |
| `docs/specifications.md` | SEC-9 shrinks to `view --reveal` + human-context `get`; SEC-13b's automation-primitive list loses export; new **SEC-9b**: a materializing command MUST refuse under an agent invocation context; materialization table + rule-of-thumb updated; the `AGENTS_SECRETS_REMOTE_TRANSPORT` marker documented as the normative transport gate; GWT-S2 replaced with a refusal scenario + a transport scenario; resolved-gap entry added |
| `skills/secrets/SKILL.md` | `:119` x.com reveal example → `exec`; `:175` primitive row rewritten |
| `apps/cli/CHANGELOG.md` | Breaking entry under the next version with the migration line |
| `~/.agents/skills/browser/browser-use.md:131` | `eval "$(… export browser-accounts --plaintext)"` → `agents secrets exec browser-accounts -- <cmd>` (separate PR in its repo) |

### 6. Fleet PreToolUse guard (companion PR, `phnx-labs/.agents-system`)

`hooks/pre-tool-use/secrets-guard.sh` + `.md`, mechanically following `git-guard.sh`: fast-path on `secrets`, jq→node→python fail-closed JSON extraction, chain-operator + `sh -c` segment recursion (avoids the RUSH-2760 quoted-prose false-positive class), plus one level of `eval "$(…)"` unwrap (the named exfil idiom), structured `blocked_op` / `reason` / `do_this_instead` deny (exit 2) for `secrets export … --plaintext` without a destination flag, two-arg `secrets get`, and `secrets view … --reveal --plaintext`. This layer is skew-immune — it fires on the agent's own Bash call before any CLI runs, so it protects sessions on fleet boxes still running older installed CLIs.

## Public Interface

| Surface | Before | After |
|---|---|---|
| `secrets export <b> --plaintext` (shell mode) | whole bundle to stdout | **removed** — print loop deleted for every caller |
| `secrets export <b> --plaintext --format json` | JSON to stdout, ungated | transport-only: needs `AGENTS_SECRETS_REMOTE_TRANSPORT=1` and no agent markers; flags hidden from help |
| `secrets export <b>` (no destination) | error demanding `--plaintext` | error naming the three destinations + `exec` + `view --reveal` |
| `secrets export --device/--to-1password/--to-file` | push modes | unchanged |
| `secrets get <b> <KEY>` | ungated printer | **removed unconditionally** — pointer: `exec <b> -- printenv KEY` |
| `secrets get <item>` (raw keychain item) | ungated printer | refuses under agent env markers; human shell hooks unchanged |
| `secrets view <b> --reveal [--plaintext]` | TTY-gated; non-TTY escape via `--plaintext` | `--plaintext` deleted; interactive-TTY-only + refuses under agent env markers |
| `secrets exec <b> -- <cmd>` / `run --secrets` | injection | unchanged — the only agent path |

## Plan

- [x] `isAgentInvocationContext` predicate (`headless.ts`, re-exported via `bundles.ts`)
- [ ] `secrets.ts`: delete export print loop; marker-gate the json transport; remove two-arg `get`; gate raw `get` + `view --reveal`; help examples
- [ ] `remote.ts`: inject `AGENTS_SECRETS_REMOTE_TRANSPORT=1` at both call sites
- [ ] Scripts: `sandbox.sh` (self re-exec chain), `apps/cli/scripts/release.sh` (printenv capture), `apps/ext/scripts/release.sh` (self re-exec)
- [ ] Tests: update `remote.test.ts:245-250,432` (marker prefix), `secrets.test.ts:471` (marker env + refusal), `:564-577` (reveal escape gone); new refusal + predicate tests
- [ ] Docs/spec/skill/CHANGELOG (table above) + regenerate `docs/command-index.md` (`gen-command-index.ts` + verify)
- [ ] PR on `rush-2774-secrets-export` → subagent non-author review (prix-cloud paused, #1767) → rebase-merge on green
- [ ] Companion PR: `.agents-system` secrets-guard + hooks.yaml wiring
- [ ] Companion PR: `~/.agents` browser skill line
- [ ] Close RUSH-2774 with proof; change ships fleet-wide on the next release train run

## Validation

| Check | Command | Expect |
|---|---|---|
| Unit/integration | `cd apps/cli && bunx vitest run src/commands/secrets.test.ts src/lib/secrets/remote.test.ts src/lib/secrets/headless.test.ts` | green |
| Export refusal | `agents-dev secrets export <b>` and `… --plaintext` | destination error / unknown option |
| Agent gate | `AGENT_SESSION_ID=x agents-dev secrets get <b> KEY` | refusal + exec pointer |
| Human path intact | `agents-dev secrets get <b> KEY` at clean shell | value |
| Injection intact | `agents-dev secrets exec <b> -- sh -c 'echo ${KEY:+set}'` | `set` |
| Remote transport | `agents-dev secrets exec <b> --device <fleet-box> -- true` | resolves via the marker-gated json path on the remote |
| Guard | pipe synthetic PreToolUse JSON with the eval line into `secrets-guard.sh` | exit 2 + `do_this_instead`; `secrets exec` cmd → exit 0 |

## Risks

| Risk | Handling |
|---|---|
| Mixed-version fleet during rollout | New driver → old remote **works unchanged** (old code ignores the marker, accepts the argv). Old driver → new remote fails loud through the existing "Is the remote agents-cli new enough…" parse-error path — upgrade the driver box. No silent fallback |
| Third-party scripts evaling `export --plaintext` or using two-arg `get` | Breaking change: CHANGELOG migration line + the refusal text itself carries the fix (`exec -- printenv KEY`) |
| Agent inside tmux has a TTY | Gated on env markers, not TTY — still refused |
| Hooks/statusline calling `get` inside agent sessions | Grep of `~/.agents` hooks found only `exec` usage; any stragglers get the refusal with the exec pointer |
| Agent spoofs the marker (`env -i`, `AGENTS_SECRETS_REMOTE_TRANSPORT=1`) or echoes via `exec` | Accepted residual: two deliberate steps, value-free audited (`secrets.get` events), guard-flaggable later — no longer a paved road |
| Direct `/usr/bin/security` / `secret-tool` read by a same-user process | Documented non-goal (spec `:1730-1733`) — unaffected by this change |
| Guard false-positives on prose mentioning the commands (RUSH-2760 class) | Segment-splitting + `eval "$(…)"` unwrap mechanics inherited from `git-guard.sh` |

## Tracking

- **RUSH-2774** — this change (Linear, AGI project, High).
- Companion PRs: `.agents-system` (guard), `~/.agents` (browser skill).
- Related: #1767 (prix-cloud paused → subagent review), RUSH-2760 (guard prose matching), RUSH-2527 (secret-bearing SSH transport hardening the transport reuses).
