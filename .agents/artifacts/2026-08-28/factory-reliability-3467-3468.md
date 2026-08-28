---
kind: report
title: "Factory reliability — PHNX-3467 & PHNX-3468 findings"
summary: >
  Two Factory-reliability sub-tasks of PHNX-2653. 3467 (orphaned refresh
  children): needs-fix, bounded the one unbounded agents-CLI spawn in agi-ext
  (PR agi-ext#16). 3468 (near-instant boot): profiled — top costs are the
  Claude setup-token scrypt decrypt (~150ms), an uncached resolveVersion walk,
  and a serial per-launch self-heal chain; report + plan, no blind fix.
status: draft
links:
  - https://linear.app/getrush/issue/PHNX-3467
  - https://linear.app/getrush/issue/PHNX-3468
  - https://github.com/phnx-labs/agi-ext/pull/16
---

# Factory reliability — PHNX-3467 & PHNX-3468 findings

Epic: **PHNX-2653** — Factory app (menubar + extension) UX & reliability.
Two investigation-first sub-tasks. Date: 2026-08-28.

Both criteria were investigated against the real code in `agents-cli`
(`cli/`) and `agi-ext`. Device names, home paths, and identifiers are
anonymized per artifact rules.

---

## Findings

- **PHNX-3467 — needs-fix, shipped as `agi-ext#16`.** The Swift menubar helper's
  child-reaping machinery is airtight *for its own children*, and the Factory /
  `agents-dbg` app spawns no CLI children at all. But the extension had one
  genuinely unbounded, untracked refresh spawn — `handoff.ts` `runAgentsSessions`
  — the single agents-CLI runner in the repo with no `timeout`. Across sleep/wake
  a wedged child orphans and latches the in-flight guard forever. Bounded it
  (15s SIGTERM); verified a hung child is killed at ~209 ms.
- **PHNX-3468 — profiled, report + plan, no blind fix.** Dominant boot cost is
  the Claude setup-token `scrypt` decrypt (~150–170 ms/launch, uncached across
  processes), then an uncached `resolveVersion` cwd→root walk called ~5×/launch,
  then a serial per-launch filesystem self-heal chain. The biggest cut is on the
  credential path and the cheapest cut has a daemon-staleness caveat, so both are
  design decisions rather than a safe drive-by — the task was explicit not to ship
  a speculative fix.

## PHNX-3467 — no orphaned/untracked refresh child processes across sleep/wake & churn

**Verdict: needs-fix → fix shipped as PR (`agi-ext#16`).** Not already
covered by the Swift machinery; a real unbounded/untracked path existed in the
extension, and it was the *one* agents-CLI runner in the repo without a deadline.

### What is already handled (and is NOT the leak)

The **Swift menubar helper** in `agents-cli` (`cli/menubar/.../ChildProcess.swift`)
is the extensively-hardened secret-broker/status helper, and it is airtight for
its own children. Every timer-driven CLI call it makes is:

- **Bounded** — 30s default deadline, 180s for the pathological `doctor --json`
  (measured 136s idle); past the deadline the child is terminated.
- **Group-killed** — spawned as its own process-group leader
  (`POSIX_SPAWN_SETPGROUP`), so a timeout `kill(-pgid)`s the whole subtree (the
  CLI *and* every `node -e` probe it forked). Foundation's `Process` cannot set a
  process group — that is why it is raw `posix_spawn`.
- **Reaped by the next launch** — live children recorded in
  `~/.agents/.cache/state/menubar-children`; `reapOrphansFromPreviousLaunch()`
  runs in `main.swift` *before* the first AppKit call, because the crash being
  recovered from (SIGSEGV in `SLSNewConnection`) runs no exit handler.

This machinery was built after a real incident: 38 orphaned `doctor`s + 92
orphaned `node -e` probes, ~13 of 18 cores, load 490. **The concern in the
ticket is genuinely covered — for the Swift helper's children.** It is not the
source of the leak.

### The "Factory" app is also NOT the leak

The `agents-dbg` / Factory app lives in `agi-ext/app/` (an Electron
`BrowserWindow`, **not** a Tray/menubar app — no `NSStatusBar`, no `.swift`, no
`Tray` anywhere in the repo). Its 5s poll (`app/main.ts` `POLL_MS = 5000` →
`FloorPoll`) reads `~/.agents/{teams,swarm}/agents/*/meta.json` off disk plus a
**single `fetch()` bounded by `AbortSignal.timeout(5000)`**. It spawns **no CLI
children at all** (its own code comments about "burning `agents` calls every 5s"
are stale). Tracked, bounded, nothing to leak.

### The real unbounded/untracked path

**`agi-ext/src/core/handoff.ts` `runAgentsSessions`** — an `execFile('agents', …)`
with **no `timeout`, no retained handle, no `.kill()`, no `AbortController`**:

```ts
function runAgentsSessions(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('agents', args, { cwd, maxBuffer: 8*1024*1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout));
  });
}
```

It is driven on a cadence by the agent panel
(`src/vscode/agentPanel.vscode.ts` — a 4s `setInterval` on `main`,
`getSessionToolStatsViaAgentsCli` → `computeSessionToolStats` →
`runAgentsSessions`) and per-terminal by `extension.ts`.

Why this leaks specifically across **sleep/wake and churn**:

1. **No timeout while every sibling has one.** `agentsBin.ts` `runAgentsArgs`
   (30s), `foreman.sources.ts` (3s), `tasks.vscode.ts` (15s) all pass a
   `timeout`. `runAgentsSessions` was the lone outlier.
2. **No sleep/wake reaping anywhere in `agi-ext`** — no `powerMonitor`
   (Electron) and no `NSWorkspace willSleep/didWake` hooks exist. The poll pauses
   only on webview *visibility* changes, never on suspend/resume. A child in
   flight when the machine sleeps is never bounded or killed.
3. **The in-flight guard converts a hung child into a permanent orphan.**
   `toolStatsInFlight` coalesces callers onto one subprocess so a slow call can't
   *stack* — but a child that never returns (wedged on a stuck FS/network read, a
   classic post-wake state) leaves the promise **latched forever**, so that
   session's stats never recover *and* the child is never reaped.

### Is the current in-flight work enough? No.

Two unmerged branches already rework this area:
`agents/spawn-storm` (PHNX-2833) removes the 4s poll cadence (event-driven
redraw, "the daemon is the only scheduler"), and `agents/poll-timers-3447`
reworks the webview polling. **Neither touches `handoff.ts`** — the unbounded
spawn survives whichever lands. Removing the poll lowers spawn *frequency*; it
does not bound an *individual* wedged child. So the fix is orthogonal and still
required.

### Fix shipped — `agi-ext#16`

Add a 15s deadline (`killSignal: 'SIGTERM'`) to the `execFile` in
`runAgentsSessions` — the source-correct, single-chokepoint fix covering all
three callers, matching the repo's existing bounded-runner convention. The
timeout is injectable so a **real-path** regression test
(`src/core/handoff.timeout.test.ts`) proves a hung child is killed without
waiting the production budget.

**Verified:** the real `execFile` path against a fake `agents` on `PATH` that
`sleep 30`s is SIGTERM-killed at **~209 ms** (near the injected 200 ms budget),
not left running for 30 s.

> The larger, AGENTS.md-tracked rework — fold `runAgentsSessions` into the
> canonical `agentsBin.ts` resolver, and bind `toolCallCount`/`todos` onto the
> single `agents feed watch` stream so the poll (and this spawn) can be *deleted*
> — remains the durable end state, and is deliberately out of scope for this
> low-risk hardening. It should be tracked on the spawn-storm/stream-binding
> effort, not blocked on it.

---

## PHNX-3468 — new-agent boot near-instant (~1s local)

**Verdict: profiled; report + ranked plan. No blind fix shipped** — the top cost
is on the credential path and the cheapest cut carries a daemon-staleness caveat
that is a design decision, not a slam-dunk. Details below.

### Measurement notes / how to reproduce

The launch path already carries **first-party instrumentation** — no new
timing code is needed:

- `spawnAgent` wraps the spawn in `createTimer('agent.run', …)`
  (`cli/src/lib/exec.ts`), marks `startup` at the moment of `spawn()`, and
  `timer.end()` on child close. `startup` = wall time from entering `spawnAgent`
  to the child actually spawning — exactly the boot cost.
- Samples spool to a SQLite perf warehouse at `~/.agents/.cache/perf/perf.db`.
- A purpose-built microbench exists: `cli/src/lib/exec.bench.ts`
  (`vitest bench`), benchmarking `buildExecEnv` / `buildExecCommand` /
  `execAgent` against the real `~/.agents` layout, using `--version` passthrough
  so the harness short-circuits before any network/session work (a network-free
  spawn-overhead measurement).

**Environment limits on this pass:** live `agents run`, `vitest bench`, and
`bun test` are process-spawn-blocked in the authoring sandbox, so the isolated
`startup` phase could not be re-measured live here. The installed CLI
(v1.22.54) stores only the *total* `agent.run` duration in `perf.db` (the
`startup` phase break-out is not persisted), so that warehouse can't isolate
boot either. Figures below combine what could be measured live (CLI cold-start)
with the codebase's own committed measurements (the bench docblock) and
structural call-graph analysis.

**Measured live on a fleet box (warm page cache, best of 3):**

| Command | Time | What it exercises |
|---|---|---|
| `agents --version` | **~0.07–0.09 s** | bun process start + minimal arg parse |
| `agents run --help` (warm) | ~0.08 s | run command *definition* only (commander lazy-loads the action module) |
| `agents run --help` (cold page cache) | **~0.44 s** | same, first hit after idle |
| `agents --help` (full top-level) | **~0.86 s** | eager registration of the whole command tree |

So the CLI's own floor is ~70–90 ms warm; a cold-cache first invocation of a
subcommand is ~440 ms before any real work. Neither reaches the exec hot path
(sync/version/token), which lives behind commander's lazy action load.

### Top costs, ranked by payoff

#### 1. `resolveClaudeSetupToken` scrypt decrypt — DOMINANT (~150–170 ms/launch, Claude signed-in)

`buildExecEnv` (`cli/src/lib/exec.ts`) eagerly calls the Claude adapter's
`resolveClaudeSetupToken` (`cli/src/lib/claude-account-token.ts`) for **every
resolved Claude version whose version home has a signed-in account**. That runs
an AES key derivation via `scryptSync` to decrypt the file-backed `auth`
bundle. **The repo's own bench docblock measures this at ~150–170 ms per call**
(`exec.bench.ts`), and it is the single largest driver of `buildExecEnv`.

- A version home with **no** signed-in account short-circuits at ~0.07 ms — so
  the cost is entirely gated on whether *that specific version* is logged in.
- RUSH-2317 added a **process-lifetime** cache keyed by home + credential
  fingerprint — but this **does not help a plain `agents run`**: every real CLI
  invocation is its own fresh process, so the cache starts empty and the one
  call pays the full ~150 ms. It only pays off inside a long-lived orchestrator
  (loop/teams) that calls `buildExecEnv` many times.

**Cut (highest payoff, but not low-risk):** derive the token **lazily** — only
when the harness actually needs it, rather than eagerly in every `buildExecEnv`
— or persist a decrypted-token cache **across processes** keyed to the
credential fingerprint, or move the setup-token to a cheaper at-rest format/KDF.
All three touch the credential path and need care (SEC review, cache-poisoning /
staleness on account switch). Recommend a scoped ticket, not a drive-by.

#### 2. `resolveVersion` cwd→root walk — repeated, uncached (cheapest structural win)

`resolveVersion` → `getProjectVersion` (`cli/src/lib/installations/store.ts`)
walks **every parent directory from cwd to root**, doing `existsSync` +
`readFileSync` + `yaml.parse` for any `agents.yaml` it finds. This walk is **not
cached**, and `resolveVersion` is called **~5× per launch** (`buildExecEnv`,
`buildExecCommand`, two self-heal sites in `commands/exec.ts`, and
`runWithFallback`). Cost scales with cwd depth (worktrees run several levels
deep).

**Cut:** memoize `getProjectVersion`/`resolveVersion` per `(agent, cwd)`.
**Caveat that makes this a design decision, not a blind fix:** `resolveVersion`
is shared with the **long-lived daemon**, where cwd varies and `agents.yaml` can
change during the process's life — a naive process-global memo would serve stale
versions there. The safe form is **request-scoped** memoization (one launch
action), or a mtime-invalidated cache like the one `readMeta` already uses
(`state.ts`). Low-risk *if scoped correctly*; that scoping is the decision.

#### 3. Per-launch filesystem self-heal chain — skip-fast but serial

The run action `await`s a **serial chain** of independent filesystem probes
before spawning: `ensureAgentRunnable` → `resolveLaunchBinary` →
`applyActiveRulesPresetAtRun` (rules re-sync, mtime+size sentinel skip-fast) →
(interactive only) a login preflight. Each is individually cheap when nothing
changed, but they run **sequentially** and each stats the disk.

> Note on the "config sync every run?" question: the **broad** resource sync
> (commands/skills/hooks/mcp, `syncResourcesToVersion`) is **NOT** on the run
> path — it runs at install / `agents use` / `agents sync` only. Only **rules**
> re-application runs per launch, and it is sentinel-gated.

**Cut:** these probes are independent of each other and of `buildExecEnv`'s
token decrypt — parallelize them (`Promise.all`) and/or make the staleness
sentinels even cheaper. Low-risk, medium payoff, but measure the sentinel-hit
cost first to confirm it's material.

#### Not on the plain-local hot path (verified, don't chase these)

- **Secrets/share broker** — only if `--secrets` is passed, or if share is
  configured *and* the token isn't already in env (`shareRuntimeEnv`
  short-circuits otherwise). No unconditional broker handshake.
- **tmux wrap** — `tmux.enabled` defaults **off**; a plain local run takes the
  bare `spawn` branch. Large if a box opts in (serial tmux round-trips), but not
  the default.
- **Prewarm pool** — there is **no** CLI-side agent prewarm pool on the boot
  path (the `prewarm` hits are the *extension's* config, not a CLI pool).
- **`actor` resolution** — process-lifetime cached; but a genuinely fresh
  terminal with no inherited `AGENTS_ACTOR` on an SSH box can pay a
  `spawnSync('tailscale','whois')` up to 2 s on the first call. Environment-
  dependent; check whether the launching terminal inherits `AGENTS_ACTOR`.

### Recommendation for PHNX-3468

1. **First, restore the measurement.** Persist the `startup` phase into `perf.db`
   (it's already computed by `createTimer`) so boot is trackable across the
   fleet, then read real p50/p90 `startup` numbers. Everything below is graded
   against that.
2. **Attack #2 (version-walk memoization, request-scoped) first** — the
   cheapest, most localized win, no credential surface.
3. **Then #3 (parallelize the pre-spawn self-heal chain).**
4. **Scope #1 (token decrypt) as its own ticket** — biggest single number
   (~150 ms) but on the credential path; lazy derivation or cross-process cache
   needs a deliberate SEC-aware design.

No fix was shipped for 3468: the biggest cost is credential-path work, and the
cheapest cut has a daemon-staleness caveat — both are design decisions, and the
task was explicit not to ship a speculative fix.

---

## Evidence

Anchors backing the findings above.

**PHNX-3467 (file:line):**

- `agi-ext/src/core/handoff.ts` `runAgentsSessions` — pre-fix `execFile('agents', …)`
  with `{ cwd, maxBuffer }` and **no** `timeout`. Sibling runners that *do* bound:
  `src/core/agentsBin.ts` `runAgentsArgs` (`timeout: 30_000`),
  `src/vscode/foreman.sources.ts` (`timeout: 3_000`), `src/vscode/tasks.vscode.ts`
  (`timeout: 15_000`).
- Cadence driver: `src/vscode/agentPanel.vscode.ts` 4s `setInterval` →
  `getSessionToolStatsViaAgentsCli` → `computeSessionToolStats` → `runAgentsSessions`;
  also `src/vscode/extension.ts` per-terminal.
- In-flight latch: `toolStatsInFlight` coalesces callers (comment at
  `handoff.ts` "so a slow `agents sessions` call can't stack across ticks") — but
  never times out a hung promise.
- No `powerMonitor` / `NSWorkspace willSleep|didWake` anywhere in `agi-ext`
  (grep-verified); poll pauses on webview visibility only.
- In-flight branches `agents/spawn-storm` (PHNX-2833) and
  `agents/poll-timers-3447` change none of `handoff.ts` (diff-verified).
- **Runtime proof of the fix:** the real `execFile` path against a fake `agents`
  on `PATH` running `sleep 30` is SIGTERM-killed at **~209 ms** with an injected
  200 ms budget (mirrors `src/core/handoff.timeout.test.ts`).

**PHNX-3468 (measured + cited):**

| Signal | Value | Source |
|---|---|---|
| CLI floor, `agents --version` (warm) | ~0.07–0.09 s | measured live, best of 3 |
| `agents run --help`, cold page cache | ~0.44 s | measured live |
| `agents --help` full tree | ~0.86 s | measured live |
| Claude setup-token `scrypt` decrypt | ~150–170 ms/call | `cli/src/lib/exec.bench.ts` docblock (committed measurement) |
| logged-out short-circuit (same code path) | ~0.07 ms | `cli/src/lib/claude-account-token.ts` |
| `resolveVersion` cwd→root walk | uncached, ~5×/launch | `cli/src/lib/installations/store.ts`, call sites in `exec.ts` + `commands/exec.ts` |

> Live `agents run` / `vitest bench` / `bun test` are process-spawn-blocked in
> the authoring sandbox, so the isolated `startup` phase could not be re-measured
> live; the installed CLI (v1.22.54) persists only the *total* `agent.run`
> duration in `~/.agents/.cache/perf/perf.db`, not the `startup` break-out. The
> ~150 ms figure is the repo's own committed benchmark measurement, not a guess.

---

## Summary

| Ticket | Outcome |
|---|---|
| **PHNX-3467** | **needs-fix → PR `agi-ext#16`.** Swift helper machinery is airtight for its own children and the Factory/agents-dbg app spawns no CLI children; the real leak was `handoff.ts` `runAgentsSessions`, the one agents-CLI runner with no deadline. Bounded it (15s SIGTERM) with a verified real-path regression test. Orthogonal to the in-flight spawn-storm/poll-timer branches. |
| **PHNX-3468** | **profiled → report + plan, no blind fix.** Top costs: (1) Claude setup-token scrypt decrypt ~150 ms/launch, uncached across processes; (2) uncached `resolveVersion` cwd→root walk ~5×/launch; (3) serial per-launch FS self-heal chain. Recommended order: persist the `startup` phase metric, then request-scoped version memoization, then parallelize the self-heal chain, then a scoped credential-path ticket for the token decrypt. |
