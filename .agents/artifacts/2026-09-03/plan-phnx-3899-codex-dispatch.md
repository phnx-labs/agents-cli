---
kind: plan
surface: cli
title: Make `agents run codex` dispatchable again — and stop reporting killed runs as success
summary: Three unrelated faults were bundled as one "codex is broken" symptom. The load-bearing one is not codex-specific — spawnAgent maps a signal-killed child to exit 0, so any SIGKILLed agent on any harness reports success with zero output.
status: draft
project: agents-cli
context: agents run codex — fleet dispatch
repository: phnx-labs/agi-cli
branch: phnx-3899-codex-dispatch-plan
harness: claude
agent: claude-opus-5
host: yosemite-m2
session: 42a53382
date: "2026-09-03"
tracking: PHNX-3899
facts:
  - Verified live across 6 fleet devices on 2026-09-03
  - Three unrelated faults, one shared symptom
links:
  - url: https://linear.app/getrush/issue/PHNX-3899/agents-run-codex-is-undispatchable-fleet-wide-linux-userns-sandbox
    label: PHNX-3899
  - url: https://linear.app/getrush/issue/PHNX-3859/fleet-account-state-diverges-by-host
    label: PHNX-3859
---

## Focus for review

1. **The owner's framing needs one correction, not a rebuttal.** "Install or configuration?" is the right question, but it has three different answers here because three unrelated faults were bundled into one ticket. Approval policy — the Claude-style auto-approve — is already correct and is not implicated in any of them.
2. **The highest-severity defect is not in codex.** `cli/src/lib/exec.ts:2366` drops Node's `signal` argument, so a SIGKILLed child resolves as **exit 0**. That is fleet-wide, harness-wide, and is why this took a day to diagnose. Recommend landing it first and separately.
3. **macOS was misdiagnosed.** `pinnacles` is not failing on config keys or a shim/PATH split. Its managed codex binaries are **Gatekeeper-killed for a revoked signing certificate**. The fix is an install, not a setting.
4. **Linux genuinely needs root, and `sudo` is not passwordless on most of the fleet.** That kills the "silent setup phase" design. The phase has to be interactive-or-explicit, and the plan says so rather than shipping something that quietly no-ops.
5. **Do we ship the trusted-device sandbox opt-in at all?** Recommendation below is *yes, but narrowly* — and deliberately not as the answer to the Linux problem.

## Purpose

`agents run codex` cannot be dispatched headlessly anywhere on the fleet (PHNX-3899). Codex is one of the three launch-catalog harnesses, so codex lanes are currently re-dispatched to claude/kimi and the local codex path no longer exercises what the cloud path claims to support.

The ask is to decide the Linux sandbox policy, root-cause the macOS silent exit-0, reconcile the version split, and note the `NO_VERIFIED_USAGE` recovery. This plan does that, and corrects two of the ticket's own hypotheses with live evidence.

## The framing: approval policy and sandbox are different things

The owner asked whether the AGI CLI config should "land the user into a setting where the sandbox is in auto mode / permission-mode approved, like Claude Code's auto mode." That conflates two independent axes. Only one of them is broken, and it is not the one a config key can reach.

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <h3>Approval policy — already correct</h3>
    <p><strong>Question it answers:</strong> does codex stop and <em>ask</em> before running a tool?</p>
    <p><strong>Who sets it:</strong> the CLI, unconditionally, on every native launch path — <code>codexPolicyArgs</code> in <code>cli/src/lib/codex-policy.ts:70</code> emits <code>approval_policy="never"</code> and <code>default_permissions="agents-auto"</code> for <code>--mode auto</code>.</p>
    <p><strong>Status:</strong> this <em>is</em> the Claude-style auto-approve the owner is asking for. It already ships. It is not implicated in any of the three failures.</p>
  </article>
  <article class="artifact-panel">
    <h3>Sandbox — the actual break</h3>
    <p><strong>Question it answers:</strong> what can the tool <em>touch</em> once it runs?</p>
    <p><strong>Who enforces it:</strong> not the CLI. Codex's own bundled <strong>bubblewrap</strong>, which builds its mounts inside a fresh unprivileged <strong>user namespace</strong>.</p>
    <p><strong>Status:</strong> the kernel denies that namespace on every Linux box in the fleet. No value in any config file changes a kernel sysctl.</p>
  </article>
</section>

<div class="artifact-callout artifact-callout-warn">
<p><strong>The load-bearing consequence.</strong> <code>approval_policy=never</code> means "never ask." It does not mean "no sandbox." Codex on Linux runs bubblewrap for <strong>both</strong> <code>read-only</code> and <code>workspace-write</code>; the only mode that skips bwrap entirely is <code>danger-full-access</code>, which agents-cli spells <code>--mode skip</code>. So there is no config value that both keeps the sandbox and makes it start on a box whose kernel forbids user namespaces. Fixing this <em>on Linux</em> requires root, once, per box — that is an install/provisioning action, not a setting.</p>
</div>

## Evidence: what actually breaks, measured 2026-09-03

Every row below is a live probe run while writing this plan, not a restatement of the ticket.

<div class="artifact-callout">
<p><strong>Line numbers in this plan are pinned to <code>origin/main</code> at <code>275bcc4b5</code></strong>, the base this branch was cut from. They will drift as <code>exec.ts</code> moves; re-resolve by symbol (<code>child.on('close'</code>, <code>codexSandboxPreflight</code>, <code>codexPolicyArgs</code>) rather than trusting the number after a rebase.</p>
</div>

### Linux — the sandbox cannot start, and sudo is not free

```console
$ for b in yosemite-m2 yosemite-s1 mark-1; do agents ssh $b \
    'unshare --user --map-root-user true 2>/dev/null && echo userns-OK || echo userns-BLOCKED;
     cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns;
     sudo -n true 2>/dev/null && echo sudo-NOPASSWD || echo sudo-needs-password'; done
=== yosemite-m2 ===   userns-BLOCKED   1   sudo-needs-password
=== yosemite-s1 ===   userns-BLOCKED   1   sudo-NOPASSWD
=== mark-1 ===        userns-BLOCKED   1   sudo-needs-password
```

The ticket established `userns-BLOCKED`. The **new** fact is the third column: `sudo` requires a password on two of three sampled boxes. A setup phase that shells `enable-codex-sandbox.sh` cannot run unattended on those machines.

### macOS — the binary is killed by Gatekeeper before it prints a byte

This is where the ticket's hypothesis is wrong. The failure is not the `default_permissions` config keys and not a shim/PATH mismatch.

```console
$ agents ssh pinnacles '... "$B" --version; echo "EXIT=$?"; spctl -a -t exec "$B"'
0.116.0: no binary
0.125.0: exit=137 out=[]
    spctl: CSSMERR_TP_CERT_REVOKED
0.130.0: exit=137 out=[]
    spctl: CSSMERR_TP_CERT_REVOKED
=== PATH codex (bun) ===
exit=0 out=[codex-cli 0.39.0]
```

`exit=137` is `128 + 9` — **SIGKILL**. macOS refuses to execute the binary because its code-signing certificate has been **revoked**, and kills it at `exec` before `main` runs. That is the literal mechanism behind "spawns, produces nothing, exits 0": there is no output because the process never got to run.

It is a `pinnacles`-specific *install* problem, not a macOS problem:

| Box | Managed codex versions | `--version` | `spctl -a -t exec` |
| --- | --- | --- | --- |
| `pinnacles` | 0.116.0, 0.125.0, 0.130.0 | **exit 137, zero bytes** | `CSSMERR_TP_CERT_REVOKED` |
| `zion` | 0.145.0, 0.146.0, 0.147.0 | exit 0, `codex-cli 0.147.0` | `rejected (the code is valid but does not seem to be an app)` |
| `mac-mini` | 0.145.0, 0.146.0, 0.147.0 | exit 0, `codex-cli 0.147.0` | `rejected (the code is valid but does not seem to be an app)` |

The `rejected (… does not seem to be an app)` line on the healthy boxes is **benign** — `spctl -a -t exec` assesses application bundles, and a bare CLI Mach-O is not one. `CSSMERR_TP_CERT_REVOKED` is the distinguishing signal. `pinnacles` is simply stranded on codex builds old enough that OpenAI's signing certificate for them has since been revoked; `zion` and `mac-mini` are on 0.147.0 and work.

### The version split is a stray install, not a CLI bug

```console
$ agents ssh pinnacles 'ls ~/.agents/shims/; which codex; codex --version'
ls: $HOME/.agents/shims/: No such file or directory
$HOME/.bun/bin/codex
codex-cli 0.39.0
```

`pinnacles` has **no shims directory at all**. The `codex-cli 0.39.0` on `PATH` is an unmanaged `bun install` that agents-cli never placed and never invokes. So `codex --version` reports a binary the CLI does not use, while the CLI launches the managed (revoked) 0.125.0. There is no version-resolution defect to fix — there is a misleading stray binary that makes the diagnostic lie, and a `doctor` finding is the right place to surface it.

## Current architecture

Where each fault lands on the dispatch path, and why only one of them is ours.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 980 470" role="img" aria-label="Dispatch path for agents run codex, showing three failure points: the Linux userns denial inside codex's bubblewrap, the macOS Gatekeeper SIGKILL at exec, and the exit-code handler in agents-cli that maps a signal-killed child to exit 0" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="980" height="470" fill="#0a0a0a"/>

  <text x="40" y="30" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">agents-cli (ours)</text>
  <text x="530" y="30" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">codex + OS (not ours)</text>
  <line x1="500" y1="14" x2="500" y2="450" stroke="#38bdf8" stroke-dasharray="3 3" opacity="0.7"/>

  <rect x="40" y="48" width="420" height="52" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="56" y="70" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">agents run codex --headless --mode auto</text>
  <text x="56" y="88" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">src/commands/run.ts</text>

  <line x1="250" y1="100" x2="250" y2="120" stroke="#38bdf8" stroke-width="1.5"/>
  <polygon points="250,128 246,118 254,118" fill="#38bdf8"/>

  <rect x="40" y="128" width="420" height="66" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="56" y="150" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">codexPolicyArgs — approval policy</text>
  <text x="56" y="168" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">approval_policy=&quot;never&quot;</text>
  <text x="56" y="184" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">codex-policy.ts:70 — CORRECT, not implicated</text>

  <line x1="250" y1="194" x2="250" y2="214" stroke="#38bdf8" stroke-width="1.5"/>
  <polygon points="250,222 246,212 254,212" fill="#38bdf8"/>

  <rect x="40" y="222" width="420" height="66" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="56" y="244" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">codexSandboxPreflight — Linux only</text>
  <text x="56" y="262" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">exec.ts:235 · linux-userns.ts</text>
  <text x="56" y="278" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">fails loud — works, but only tells you to fix it by hand</text>

  <line x1="250" y1="288" x2="250" y2="308" stroke="#38bdf8" stroke-width="1.5"/>
  <polygon points="250,316 246,306 254,306" fill="#38bdf8"/>

  <rect x="40" y="316" width="420" height="52" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="56" y="338" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">spawn(binary, args)</text>
  <text x="56" y="356" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">exec.ts spawnAgent</text>

  <rect x="40" y="392" width="420" height="58" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="56" y="414" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">FAULT 3 — close handler</text>
  <text x="56" y="432" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">exec.ts:2366  code ?? 0   → signal dropped</text>
  <text x="56" y="446" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">SIGKILL becomes exit 0 · every harness</text>

  <line x1="250" y1="368" x2="250" y2="386" stroke="#f59e0b" stroke-width="1.5"/>
  <polygon points="250,392 246,382 254,382" fill="#f59e0b"/>

  <rect x="530" y="128" width="410" height="76" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="546" y="150" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">FAULT 1 — Linux: codex bundled bwrap</text>
  <text x="546" y="168" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">unshare --user → /proc/self/uid_map</text>
  <text x="546" y="186" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">EPERM: apparmor_restrict…userns=1</text>
  <text x="546" y="200" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">kernel sysctl — root-only, no config reaches it</text>

  <rect x="530" y="240" width="410" height="76" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="546" y="262" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">FAULT 2 — macOS: Gatekeeper at exec</text>
  <text x="546" y="280" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">CSSMERR_TP_CERT_REVOKED</text>
  <text x="546" y="298" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">SIGKILL → exit 137, zero bytes</text>
  <text x="546" y="312" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">pinnacles only — stale install, revoked cert</text>

  <line x1="460" y1="340" x2="700" y2="340" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <text x="700" y="336" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">faults 1 &amp; 2 both surface here</text>
  <line x1="700" y1="344" x2="700" y2="392" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <polygon points="466,392 462,382 470,382" fill="#f59e0b"/>
  <line x1="700" y1="392" x2="466" y2="392" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
</svg>
<figcaption>The two environment faults are outside our process. The third is ours, sits downstream of both, and is what turned two loud failures into one silent one.</figcaption>
</figure>

<div class="artifact-callout artifact-callout-danger">
<p><strong>Fault 3 is not codex-specific and is the reason to treat it as P0.</strong> <code>cli/src/lib/exec.ts:2366</code> reads <code>const exitCode = budgetKilled ? BUDGET_KILL_EXIT_CODE : (code ?? 0)</code>. Node's <code>'close'</code> event is <code>(code, signal)</code>: when a child dies by signal, <code>code</code> is <code>null</code> and <code>signal</code> holds the name. This handler never binds <code>signal</code>, so <code>null ?? 0</code> yields <strong>0</strong>. Any agent killed by SIGKILL (Gatekeeper, the OOM killer, <code>kill -9</code>), SIGSEGV, or SIGTERM currently reports <strong>success</strong> — on every harness, for <code>run</code>, <code>teams</code>, and routines alike. The correct pattern already exists <strong>elsewhere in the same file</strong>, at <code>exec.ts:1411</code>: <code>child.on('exit', (code, signal) =&gt; resolve(code ?? (signal ? 1 : 0)))</code>. Two handlers in one module disagree about whether a signal is a failure; this one is the side that drifted.</p>
</div>

## Current versus proposed behavior

<figure class="artifact-figure artifact-behavior">
  <section data-state="current" data-evidence="capture">
    <h3>Today — silent success on a killed run</h3>
    <pre><code>$ agents run codex "print the git branch" \
    --device pinnacles --mode auto
$ echo $?
0
$ agents sessions --active | grep codex
(no rows)</code></pre>
    <p>Zero bytes on stdout, no session, no error, exit 0. An orchestrator marks the lane delivered. Verified on <code>pinnacles</code>, 2026-09-03.</p>
  </section>
  <section data-state="proposed" data-evidence="mockup">
    <h3>Proposed — the kill is named, the run fails</h3>
    <pre><code>$ agents run codex "print the git branch" \
    --device pinnacles --mode auto
agents: codex@0.130.0 on pinnacles cannot
execute — macOS killed it at exec (SIGKILL)
and its signature is REVOKED:

  spctl: CSSMERR_TP_CERT_REVOKED

Install a current codex on that box:
  agents add codex@latest -D pinnacles

$ echo $?
137</code></pre>
    <p>Preflight names the cause and the remediation; a kill that slips past it still exits <code>128 + signal</code>, never 0.</p>
  </section>
</figure>

## Fix directions, weighed

### Direction A — fix the exit-code contract (RECOMMENDED, P0, ships alone)

| | |
| --- | --- |
| **What it changes** | `cli/src/lib/exec.ts:2366` — bind `signal` in the `close` handler and map it to `128 + signum`. Add a headless zero-output guard alongside it. |
| **What it cannot do** | Nothing about *why* codex died. It converts a silent wrong answer into a loud right one. |
| **Isolation tradeoff** | None. |
| **Why first** | It is the only one of the three that is a defect in code we own, it is ~10 lines, it is harness-wide, and every other direction's failure mode is *also* currently invisible because of it. |

### Direction B — automate the Linux provisioning in `agents setup` (RECOMMENDED, with a stated limit)

| | |
| --- | --- |
| **What it changes** | New `'codex-sandbox'` phase in `SetupPhase` (`cli/src/commands/setup.ts:317`), a status row from `probeUnprivilegedUserns()`, and a wizard that runs `cli/scripts/enable-codex-sandbox.sh` under `sudo`. |
| **What it cannot do** | **Run unattended on most of the fleet.** `sudo` needs a password on `yosemite-m2` and `mark-1`. The phase must prompt on a TTY and, when non-interactive, print the exact one-liner and exit — never silently skip. |
| **Isolation tradeoff** | None — this is the option that *keeps* codex's `workspace-write` sandbox fully intact. It re-enables a kernel capability, it does not disable a sandbox. |
| **Security note** | `kernel.apparmor_restrict_unprivileged_userns=0` is a **global** relaxation: it re-enables unprivileged userns for every binary on the box, not just bwrap. On a single-tenant fleet worker running the owner's own code this is the same posture Ubuntu shipped before 23.10 and is acceptable. It would not be acceptable on a multi-tenant host. |

An AppArmor profile scoped to `bwrap` (`/etc/apparmor.d/` with a `userns` rule) is the more surgical alternative and is worth a spike, but it is **not** recommended for v1: the profile must be keyed to codex's bwrap, which is extracted **per-run to a fresh randomized path** (`$CODEX_HOME/tmp/arg0/codex-XXXX/`, per `cli/src/lib/linux-userns.ts:6`) and exec'd from a memfd. There is no stable path to attach a profile to. Filing it as a follow-up rather than blocking this ticket on it.

### Direction C — a trusted-device sandbox opt-in (RECOMMENDED, narrowly, and NOT as the Linux answer)

| | |
| --- | --- |
| **What it changes** | A per-device config key — `devices.<name>.codex.sandbox = managed \| host-trusted` — read where `codexPolicyArgs` is selected. `host-trusted` runs codex `danger-full-access`. |
| **What it cannot do** | It cannot be the fleet default, and it must not be what `setup` offers first. The ticket is explicit: *do not normalize `--mode skip`*. |
| **Isolation tradeoff** | Real and total. `danger-full-access` removes codex's filesystem sandbox entirely — the agent can write anywhere the user can, not just the workspace roots. |
| **Recommendation** | Ship it, gated: explicit per-device opt-in, stored in that device's tracked `devices/<name>/agents.yaml` so the choice is visible fleet-wide, a banner on every run it affects, and an `agents doctor` **warning** naming each box that carries it. Correct for the owner's own code on the owner's own fleet when a box genuinely cannot be given root. Wrong as a default and wrong for anything multi-tenant. |

This exists so a box that cannot be provisioned is not permanently undispatchable. It is the escape hatch, not the fix — Direction B is the fix.

### Direction D — macOS: preflight the binary, and surface the stray install (RECOMMENDED)

| | |
| --- | --- |
| **What it changes** | A `darwin` sibling to `codexSandboxPreflight` (`cli/src/lib/exec.ts:235`): before spawning a managed binary on macOS, assess it and refuse with the remediation when the signature is revoked. Plus an `agents doctor` finding for an unmanaged harness binary shadowing `PATH`. |
| **What it cannot do** | It cannot repair the binary. The repair is `agents add codex@latest` on that box — an install, exactly as the owner suspected, just not the install the ticket guessed at. |
| **Isolation tradeoff** | None. |
| **Cost note** | `spctl` is a fork per spawn. Gate it the way the userns probe is gated — cache per process, and only assess after a spawn has already failed, or on `doctor`/`setup`, not on every launch. |

### Direction E — `NO_VERIFIED_USAGE` (noted, not solved here)

Worth recording because it is self-reinforcing rather than merely annoying. Codex usage is **not** a network fetch: `cli/src/lib/accounting/usage.ts:560` registers codex as `{ fetch: getCodexUsageInfo, network: false }`, derived from local transcripts under `.codex/sessions`. So a box where codex cannot run produces no fresh usage, which makes `--strategy available|balanced` find nothing verified, which fails the run with `NO_VERIFIED_USAGE`, which means codex still never runs. **Fixing A–D breaks the loop on its own.** The residual — that a genuinely idle codex account ages out of verification — is PHNX-3859's fleet usage-sync problem and should stay there.

## Proposed Changes

`exec.ts` does **not** import `os` today, so the signal-name lookup below needs one added:

```diff
--- a/cli/src/lib/exec.ts
+++ b/cli/src/lib/exec.ts
+import * as os from 'os';
@@
-    child.on('close', (code) => {
+    // Node's `close` is (code, signal): a signal-killed child reports
+    // code === null and the signal name. Binding only `code` and coercing
+    // `code ?? 0` reported a SIGKILLed agent as SUCCESS with zero output —
+    // the PHNX-3899 macOS symptom, and harness-wide. `exec.ts:1411` already
+    // does this correctly; this is the path that drifted.
+    child.on('close', (code, signal) => {
@@
-      const exitCode = budgetKilled ? BUDGET_KILL_EXIT_CODE : (code ?? 0);
+      const exitCode = budgetKilled
+        ? BUDGET_KILL_EXIT_CODE
+        : signal
+          ? 128 + (os.constants.signals[signal] ?? 0)
+          : (code ?? 0);
+      if (signal) {
+        process.stderr.write(
+          `\x1b[31magents: ${options.agent} was killed by ${signal} ` +
+          `(exit ${exitCode}) after ${stdoutTail.length} bytes of output.\x1b[0m\n`,
+        );
+      }
```

```diff
--- a/cli/src/lib/exec.ts
+++ b/cli/src/lib/exec.ts
+/**
+ * Preflight a managed agent binary on macOS. Gatekeeper SIGKILLs a binary whose
+ * Developer ID certificate has been revoked, BEFORE main runs — so the process
+ * emits zero bytes and (pre-fix) resolved as exit 0. Observed on pinnacles:
+ * codex 0.125.0/0.130.0 both `spctl: CSSMERR_TP_CERT_REVOKED`, exit 137.
+ * Scoped like codexSandboxPreflight: darwin only, headless only, and only
+ * consulted after a spawn produced nothing — never a fork on every launch.
+ */
+export function darwinBinaryPreflight(args: {
+  platform: NodeJS.Platform;
+  agent: AgentId;
+  version?: string;
+  binaryPath: string;
+  assess: (path: string) => 'ok' | 'revoked' | 'unknown';
+  machine: string;
+}): string | null {
```

```diff
--- a/cli/src/commands/setup.ts
+++ b/cli/src/commands/setup.ts
-export type SetupPhase = 'browser' | 'computer' | 'share' | 'secrets'
-  | 'accounts' | 'fleet' | 'watchdog' | 'preferences';
+export type SetupPhase = 'browser' | 'computer' | 'share' | 'secrets'
+  | 'accounts' | 'fleet' | 'watchdog' | 'codex-sandbox' | 'preferences';
@@ getSetupStatus()
+  // Linux only: codex's bwrap sandbox needs unprivileged userns, which
+  // Ubuntu 23.10+ denies by default. 'n/a' off Linux — codex uses no bwrap
+  // there, so the row must not read as an unfinished step on macOS/Windows.
+  const userns = process.platform === 'linux'
+    ? probeUnprivilegedUserns()
+    : { state: 'ok' as const };
+  const sandboxState: SetupStatusState =
+    process.platform !== 'linux' ? 'n/a' : userns.state === 'ok' ? 'ready' : 'missing';
@@
+    { phase: 'codex-sandbox', state: sandboxState,
+      detail: sandboxState === 'n/a' ? 'Linux only — codex uses no bwrap here'
+        : sandboxState === 'ready' ? 'unprivileged userns available'
+        : 'userns restricted — codex headless runs land zero tools' },
```

```diff
--- a/cli/src/commands/setup-codex-sandbox.ts   (new)
+++ b/cli/src/commands/setup-codex-sandbox.ts
+// Applying the fix needs root, and `sudo` is NOT passwordless on most of the
+// fleet (measured 2026-09-03: yosemite-m2 and mark-1 both prompt). So this
+// wizard PROMPTS on a TTY and, when non-interactive, prints the exact command
+// and returns a stated skip. It never silently no-ops, and it never falls back
+// to widening the sandbox — see the trusted-device opt-in for that, which is a
+// deliberate operator choice rather than a setup default.
```

## Public Interface

| Surface | Change | Notes |
| --- | --- | --- |
| `agents run <any>` | A signal-killed run now exits `128 + signum` and prints the signal | **Behavior change.** A caller that treated 0 as success was previously wrong; scripts asserting exit 0 on a killed run will start failing, which is the point. |
| `agents setup` | New `Codex-sandbox` row and menu phase | `n/a` on macOS/Windows. |
| `agents setup status --json` | New `codex-sandbox` row | Additive. |
| `agents config set devices.<name>.codex.sandbox <managed\|host-trusted>` | New per-device key | Default `managed`. Shared, tracked in `devices/<name>/agents.yaml`. |
| `agents doctor` | Two new findings: `harness-binary-revoked` (critical), `harness-binary-shadow` (warning) | `binary-shadow` exists for agents-cli itself; this is the harness sibling. |
| CHANGELOG + `cli/README.md` + `cli/AGENTS.md` §"Codex's Linux sandbox…" | Updated | Required by repo convention for a flag/behavior change. |

## Plan

| # | Task | Direction |
| --- | --- | --- |
| 1 | Fix signal-killed child reported as exit 0 (`exec.ts:2366`) | A |
| 2 | Add empty-output guard for headless runs | A |
| 3 | Preflight the agent binary for Gatekeeper revocation on macOS | D |
| 4 | Add a codex-sandbox phase to `agents setup` / fleet onboard | B |
| 5 | Decide and gate the trusted-device sandbox opt-in | C |
| 6 | Render, share, and land this plan | — |

Order matters: **1 and 2 land first and alone.** Until they do, every other fix's failure mode is invisible.

## Validation

Real paths only, no mocks, per repo convention.

```bash
# 1. Unit: a signal-killed child must not resolve 0 (exec.ts close handler).
#    Real process, real SIGKILL — no mock.
cd cli && bun run test src/lib/exec.signal-exit.test.ts

# 2. End-to-end, the fault as it actually occurs on pinnacles.
#    Pre-fix this prints nothing and echoes 0; post-fix it must echo 137.
agents run codex "print the current git branch" --device pinnacles --mode auto
echo "exit=$?"

# 3. Linux acceptance, after the setup phase provisions a box.
agents ssh yosemite-s1 'unshare --user --map-root-user true && echo userns-OK'
agents run codex "print the current git branch" --device yosemite-s1 --mode auto
agents sessions --active | grep codex     # must show the row

# 4. macOS acceptance, after installing a current codex on pinnacles.
agents add codex@latest --device pinnacles
agents run codex "print the current git branch" --device pinnacles --mode auto

# 5. Full suite, sharded across the fleet.
cd cli && scripts/test.sh --shard 3
```

The ticket's acceptance bar is a real run on at least one Linux box **and** on `pinnacles`, with the session visible in `agents sessions --active`, both quoted. Steps 3 and 4 are exactly that.

## Risks

| Risk | Where | Mitigation |
| --- | --- | --- |
| The exit-code change is a **breaking behavior change** — callers asserting `exit 0` on a run that was silently killed will start failing | `cli/src/lib/exec.ts:2366` | Correct by construction: those callers were already wrong. Land it alone, with a CHANGELOG entry naming it explicitly so a red lane is attributable. |
| `128 + signum` collides with `BUDGET_KILL_EXIT_CODE = 7` only if a signal maps to 7 — it cannot (`128 + n ≥ 129`) | `cli/src/lib/exec.ts:2379` | No collision. Noted so a reviewer does not have to re-derive it. |
| The setup phase **silently no-ops** on a box where `sudo` prompts and there is no TTY — reproducing the exact class of failure this ticket is about | new `setup-codex-sandbox.ts` | Fail loud with the stated reason and the copy-pasteable command. Never return as if it worked (repo convention: *fail loud at boundaries*). |
| `spctl` forked on every spawn adds latency to the hot path | `darwinBinaryPreflight` | Process-cached like `probeUnprivilegedUserns` (`linux-userns.ts:134`), and consulted only after a spawn produced zero bytes. |
| `host-trusted` gets set once "to unblock a lane" and quietly becomes the fleet norm — the outcome the ticket forbids | new config key | Per-device only, tracked in the synced `devices/<name>/agents.yaml` so it is visible fleet-wide, a per-run banner, and an `agents doctor` warning listing every box carrying it. |
| Global `apparmor_restrict_unprivileged_userns=0` relaxes userns for **all** binaries, not just bwrap | `cli/scripts/enable-codex-sandbox.sh:94` | Accepted for single-tenant fleet workers, stated in the wizard's prompt. The scoped-AppArmor alternative is blocked on codex's randomized per-run bwrap path (`linux-userns.ts:6`) and is filed as a follow-up, not silently dropped. |
| `codexPolicyArgs` emits the permission-profile keys (`default_permissions`, `permissions.<profile>`) with **no version gate** (`codex-policy.ts:70`), while the capability table version-gates every other codex capability | `cli/src/lib/codex-policy.ts:76-84` | Not on this ticket's critical path — `pinnacles`' binaries never start, so the keys are never parsed. Flagged as a latent gap against the repo's *capability table stays truthful* convention; needs the introducing codex version confirmed before gating. |

## Tracking

- [PHNX-3899](https://linear.app/getrush/issue/PHNX-3899/agents-run-codex-is-undispatchable-fleet-wide-linux-userns-sandbox) — this plan
- [PHNX-3859](https://linear.app/getrush/issue/PHNX-3859/fleet-account-state-diverges-by-host) — `NO_VERIFIED_USAGE` / fleet usage divergence (Direction E)
- PHNX-3285 — the original Linux userns diagnosis this recurs from
- Follow-up to file: scoped AppArmor profile for codex's bwrap, if the randomized extraction path is ever stabilized
- Follow-up to file: version-gate `codexPolicyArgs`' permission-profile keys
