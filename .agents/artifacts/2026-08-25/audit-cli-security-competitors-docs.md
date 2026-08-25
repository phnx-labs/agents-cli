---
kind: report
template: report.v1
title: agents-cli audit — security/corner-cases, competitor guarantees, doc staleness
summary: Three-track read-only swarm audit (codex/kimi/grok) of agents-cli @ origin/main (64226735f) — one genuine high-severity hardening finding plus one medium, a five-axis competitor comparison (ahead on watchdog/secrets/scheduling, behind on cross-device session portability), and 20+ stale-doc findings led by a fully removed `agents hosts` command still taught in six places.
project: agents-cli
repository: phnx-labs/agents-cli
branch: main
tracking: PHNX-3254
status: final
links:
  - https://linear.app/phnx-labs/issue/PHNX-3254
---

## Summary

Dispatched a 3-track read-only swarm (`agents teams`, team `cli-audit-0825`, all
teammates on `yosemite-m2`, `--mode plan`, worktree-isolated) against
`origin/main` at `64226735f9c84efb504c9449a0263ccbff1b6f37` — one provider per
lens for blind-spot diversity: codex on security/corner-cases, kimi on
competitor guarantee comparison, grok on doc staleness. No files were modified
and no PR was opened; this is findings-only.

Headline results:

- **One high-severity finding**: Windows `%VAR%`/`!VAR!` cmd.exe expansion is
  deliberately left unescaped in `quoteWin32ExecArg`
  (`cli/src/lib/platform/exec.ts:63`) on a trust assumption that fleet/routine
  dispatch can violate.
- **Five graded guarantee comparisons** vs. named competitors (Claude Code,
  Codex CLI, Cursor, Factory Droid, Warp, Devin, OpenHands, GitHub Copilot,
  Continue.dev, Aider, Google Antigravity/Jules) — ahead on stall
  detection/recovery, secrets-never-plaintext, and execution singularity;
  parity on multi-agent worktree fan-out; behind on cross-device session
  portability.
- **`agents hosts` is the single most misleading doc gap** — removed in commit
  `8948a3bbe`, still taught as a live command in the README, root `AGENTS.md`,
  the normative `cli/docs/specifications.md`, and three skill files.
- Two process notes worth keeping for future swarm runs: the fleet-wide Codex
  sandbox bug (`bwrap: setting up uid map: Permission denied`) recurred and
  self-recovered via a GitHub API read fallback; `agents teams status` reported
  the docs track as `FAILED` when it had actually written a complete, correct
  417-line report — confirming the known unreliable-status-metadata pattern.

| Track | Provider | Focus | Duration | Status shown | Actually delivered |
|---|---|---|---|---|---|
| security-audit | codex | security + corner-cases | 4.0 min | COMPLETED | Yes — inline in final message (local file write blocked by sandbox) |
| competitor-compare | kimi | guarantee comparison | 8.5 min | COMPLETED | Yes — `/tmp/cli-audit-competitors.md`, 170 lines |
| docs-staleness | grok | doc staleness | 10.3 min | **FAILED** | Yes — `/tmp/cli-audit-docs.md`, 417 lines, complete |

<div class="artifact-callout">
<strong>Don't trust <code>agents teams status</code>'s terminal state alone.</strong>
The docs-staleness track shows <code>FAILED</code> above but produced a complete,
well-formed report — verify by reading the teammate's actual output before
writing off a track.
</div>

## Findings

### Security & corner-cases (codex)

**High — Windows `%VAR%`/`!VAR!` expansion left unescaped.**
`cli/src/lib/platform/exec.ts:63`:

```ts
/*
 * CAVEAT: cmd.exe expands `%VAR%` (always) and `!VAR!` (under delayed expansion)
 * BEFORE argv parsing, and double-quoting does NOT suppress `%`/`!` (the
 * "BatBadBut" / CVE-2024-1874 class). We deliberately do not escape `%`/`!`:
 * the callers here run a command whose `%`/`!`-bearing tokens are the caller's
 * own (an agent prompt against the caller's shell, a bundle the caller owns), so
 * caller-controlled `%`/`!` is not a privilege boundary.
 */
export function quoteWin32ExecArg(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>()^]/.test(arg)) return arg;
```

Failure scenario: on Windows, a fleet- or routine-driven invocation (not an
interactive caller) supplies an agent prompt or `agents secrets exec` argument
containing `%COMSPEC%` or an attacker-influenced environment variable name.
`cmd.exe` expands it before the child parses argv, so a value the comment
assumes is "the caller's own" can in practice originate from routine/cron input
the stated trust boundary doesn't cover — and both `agents routines` and fleet
dispatch run this code path.

**Medium — file-backed secrets fallback co-locates key and ciphertext trust
boundary.** `cli/src/lib/secrets/filestore.ts:94,144,247,285` — the
auto-provisioned machine-local passphrase lives at
`~/.agents/.secrets-key/passphrase` (mode `0600`), sibling to the `.enc`
ciphertext files it decrypts. A home-directory backup, disk snapshot, or
same-user-process compromise reads both together, at which point `0600`
protects against other OS users but nothing else. This is the fallback path
(used only when Keychain/libsecret/Credential Manager is unavailable) and
should be documented as ciphertext-only obfuscation, not confidentiality under
compromise.

**Checked and sound (negative evidence):** SSH target + argv injection
(`cli/src/lib/ssh-exec.ts:31,180` — strict target regex, argv-array spawn);
remote command quoting (`cli/src/lib/hosts/remote-cmd.ts:199` — double-quoted);
bundle/env-key validation (`cli/src/lib/secrets/bundles.ts:294` — rejects
traversal and reserved loader env names before `path.join`); credential-bearing
SSH dispatch (`cli/src/lib/hosts/dispatch.ts:344,371` — strict host-key
verification, forced fresh connection, closing the RUSH-1767 downgrade case).

### Competitor guarantee comparison (kimi)

| Guarantee | agents-cli claim | Verdict | Why |
|---|---|---|---|
| Cross-device session portability | Explicit-transport resume, routes to owning device (`cli/docs/sessions.md:72-78`) | **Behind / mixed** | Cursor, Factory, Warp, Devin already give a session reachable from a new device without the original machine online; Claude Code/Codex CLI are behind agents-cli here, but the closest "fleet control plane" peers have moved past device-must-be-reachable. |
| Stall detection + automatic recovery | Daemon watchdog, 3-min bounded pass, agent-driven nudge with confirmed delivery (specifications.md WD-1..WD-21) | **Ahead** | Competitors mostly ship reactive notifications or nothing; OpenHands has a `StuckDetector` but no integrated nudge-delivery/cooldown ledger. |
| Multi-agent parallel fan-out, isolated worktrees | `agents teams` — DAG of teammates, one worktree each (`cli/docs/orchestration.md:31-34`) | **Parity** | Table stakes by mid-2026 — Cursor, Codex, Copilot, Warp, Devin, Factory all ship comparable or richer surfaces. |
| Secrets broker (never raw on disk) | SEC-1/SEC-7/SEC-8a/SEC-21 — OS keystore primary, env-only injection, `0600` unlink-before-exec | **Ahead** | Claude Code, Codex CLI, Continue.dev, Cursor store credentials in plaintext under common/default conditions (cited issues + writeups); Devin/Warp have comparable cloud brokers but assume cloud custody. |
| Fleet-wide execution singularity | One scheduler/one executor; UI surfaces can't own acting timers (SING-1/SING-2/SING-5) | **Ahead** | No competitor documents a comparable contract — but the spec itself flags an open gap (below). |

Top gaps kimi flagged as worth closing: (1) cross-device session state is the
biggest real gap vs. cloud-native peers; (2) forward-timer routine dispatch has
no durable per-slot claim — the spec itself marks this `[Intended]` /
`SING-GAP-3` (`specifications.md:3014-3037`); (3) `EXEC-16` admits
`buildExecEnv` has no per-version config-dir var for 11 of the registered
agents, so "version homes prevent config bleed" only fully holds for the 4 main
ones.

### Doc staleness (grok)

Ranked worst-first by how misleading the drift is:

1. **`agents hosts` documented as live in 6+ places** — README's full tutorial
   (`README.md:600-621`), root `AGENTS.md:108-111`, the normative
   `cli/docs/specifications.md`, and three skill files
   (`skills/devices/SKILL.md:116-130`, `skills/run/SKILL.md:211-212`,
   `skills/routines/SKILL.md:153`). Removed in `8948a3bbe`;
   `isKnownTopLevelCommand('hosts')` is pinned false by test
   (`command-registry.test.ts:47`). Replacement: `agents devices` / `agents logs`.
2. **`cli/AGENTS.md` capability table understates the registry** — Codex
   `allowlist`, OpenCode `subagents`, Goose `commands`/`subagents`, Hermes
   `allowlist`/`plugins` are marked `—` in the doc but `true`/enabled in
   `cli/src/lib/agent-spec/agents.ts` — exactly the "capability table stays
   truthful" class the repo's own review conventions call out.
3. **Resource resolution layer order is inverted** in `AGENTS.md`,
   `concepts.md`, and `resources.md` vs. `resources.ts:166-185` (docs say user
   overrides extras; code has extras searched after system, i.e. system wins).
4. **`specifications.md`'s coverage inventory** — the normative file-of-record
   — still lists `hosts`, `profiles`, `share`, `wallet`, `helper`, `webhook`,
   `budget`, `audit` as live top-level commands, and several `SES`/`EXEC`
   clause citations point at the wrong `file:line`.
5. **Repo-map / branding debt** — `apps/cli/` (flattened to `cli/` per
   `cli/scripts/release.sh:65-67`), a `website/` map entry that doesn't exist,
   a `cli/README.md` link that's prepack-only, root README still titled
   `agi-cli` with the pre-fold `~/.agents-system/` path.
6. **Native helper docs inverted vs. code** — computer-mac README says
   stdio-only when socket transport is now primary; computer-win README/AGENTS
   describe the auth token as optional when `Program.cs:39-42` now refuses to
   start without one.
7. **CHANGELOG** still cites `apps/cli/...` paths in the current-version block,
   post-flatten.

No high-severity gaps found in `architecture.md`, `sessions.md`, `secrets.md`,
`execution.md`, `fleet.md`, `automation.md`, or `orchestration.md` beyond what's
already listed above.

## Evidence

Each finding above is cited inline to a `file:line` and, for the competitor
track, to a fetched source URL (not a search snippet) — see the raw per-track
reports for the full citation set (170 lines competitor, 417 lines docs,
codex's security report embedded in its final message since the sandbox blocked
its own file write). All three teammates worked read-only against pinned commit
`64226735f9c84efb504c9449a0263ccbff1b6f37`; none modified the repository.

Process evidence: codex's log shows it hit the known fleet-wide Codex sandbox
bug (`bwrap: setting up uid map: Permission denied`) on its first tool call,
then self-recovered by switching to the `github.fetch` MCP tool to read the
pinned commit's files via the GitHub API instead of the local filesystem —
worth noting as a working fallback pattern for future dispatches on affected
hosts. Grok's `agents teams status` entry read `FAILED` despite
`/tmp/cli-audit-docs.md` (417 lines) being a complete, well-structured report —
reconfirming that team status/delivery metadata should never be trusted without
checking the teammate's actual output.

## Recommendations

1. **Fix the Windows quoting trust boundary** (high) — scope
   `quoteWin32ExecArg`'s no-escape behavior to genuinely interactive callers
   only, or route routine/fleet-dispatched Windows commands through a shell
   mode that disables `%`/`!` expansion.
2. **Doc fix batch**, in dependency order: hosts eradication (6+ sites) →
   capability-table regen (ideally generated from `agent-spec/agents.ts` in CI,
   not hand-maintained) → resolution-order one-liner → `specifications.md`
   coverage-inventory + citation refresh → brand/path flatten
   (`apps/cli`→`cli`, `agi-cli`→`agents-cli`, `~/.agents-system/`) → native
   helper doc corrections. Real work for a follow-up PR, not this read-only
   pass.
3. **Track `SING-GAP-3`** (durable per-slot routine claim) as the one place
   agents-cli's strongest competitive differentiator — execution singularity —
   is not yet structural.
4. Relabel the file-backed secrets fallback (medium) as "ciphertext-only
   obfuscation," not "confidentiality," when the OS keystore is unavailable.
