---
kind: plan
template: plan.v1
title: Agent tabs must survive a network blink
summary: >-
  Remote interactive agents are not detached on the peer, so an SSH blink SIGHUPs them.
  Make them survive, make reconnect work for every harness, and stop one blip from
  killing every tab on a host.
header: AGI EXT · agents-cli
footer: Phoenix Labs
project: agents-cli
context: >-
  Two VS Codium agent tabs died on a brief network disruption. One printed a reconnect
  countdown and still dead-ended at a shell; the other printed nothing at all.
repository: phnx-labs/agents-cli
branch: fix/ext-agent-reconnect
surface: cli
tracking: RUSH-3125
status: draft
harness: claude
agent: claude
human: Muqsit
host: zion
session: e9b853bc
date: '2026-08-23'
facts:
  - 'tmux.enabled is off by default on every fleet peer — verified on yosemite-s0/s1/m6'
  - 'No tmux server exists on those peers: the socket path does not exist'
  - '6 agent tabs to yosemite-s1 shared ONE ssh ControlMaster socket'
  - 'The ext emits --session-id only for claude; every other harness resolves its id over SSH after the drop'
  - 'Total reconnect budget is 6 attempts / ~90 seconds'
links:
  - title: RUSH-3125
    url: https://linear.app/prix/issue/RUSH-3125
assets: []
---

## Purpose

A brief network disruption kills every offloaded agent tab in VS Codium. The two captured
tabs show two *different* failure modes, and neither is the one the code believes it is
handling.

The reconnect subsystem in `apps/cli/src/lib/hosts/reconnect.ts` is carefully built,
well-tested, and rests on a premise that is **false on every device in this fleet**. Its
own file header states it plainly:

> A remote interactive agent runs in a DETACHED tmux session on the peer (see lib/exec.ts
> `runInTmux`), so a network blink kills only the local ssh client — the agent keeps running.
> — `apps/cli/src/lib/hosts/reconnect.ts:5`

It does not. Verified live against the actual boxes the user runs on:

```
$ agents ssh yosemite-s0 'agents devices config yosemite-s0 tmux.enabled'
  tmux.enabled  — (default)  … Off, the default, spawns the agent directly.

$ agents ssh yosemite-s0 'tmux -S ~/.agents/.cache/tmux/default ls'
  error connecting to /home/muqsit/.agents/.cache/tmux/default (No such file or directory)
```

Same on `yosemite-s1` and `yosemite-m6`. There is no tmux server running on any of them.
The remote agent is a direct child of the sshd session holding the controlling TTY, so
when the link drops sshd tears the session down and the agent takes a **SIGHUP and dies**.

The message the user sees — *"the agent is still running there"*
(`reconnect.ts:172`) — is not true. The reattach that follows calls
`agents sessions focus <id> --local` (`reconnect.ts:235`), finds no live pane, and falls
through to **resume**: a brand-new process replaying the transcript, with the in-flight
turn lost.

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> this is not a
reconnect-tuning problem. The reconnect layer is sound; the thing it reconnects <em>to</em>
does not exist. Durability was made conditional on <code>tmux.enabled</code>, a
per-device <em>ergonomics</em> toggle about mouse and scrollback, which defaults off.</aside>

### The three defects behind the two screenshots

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 940 430" role="img" aria-label="Failure chain from a network blink to a dead agent tab">
    <defs>
      <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b8b8b" />
      </marker>
      <marker id="arRed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#f87171" />
      </marker>
    </defs>

    <text x="20" y="26" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="12">zion (VS Codium)</text>
    <line x1="470" y1="12" x2="470" y2="418" stroke="#3a3a3a" stroke-width="1" stroke-dasharray="4 4" />
    <text x="490" y="26" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="12">peer (yosemite-s0/s1)</text>

    <rect x="20" y="44" width="180" height="46" rx="6" fill="#141414" stroke="#4a4a4a" />
    <text x="110" y="66" text-anchor="middle" fill="#d4d4d4" font-family="Inter, system-ui, sans-serif" font-size="13">agent tab</text>
    <text x="110" y="82" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">agents run --device</text>

    <rect x="20" y="120" width="410" height="72" rx="6" fill="#1a1206" stroke="#f59e0b" stroke-width="1.5" />
    <text x="34" y="142" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="11">DEFECT 3 — one shared ControlMaster per peer</text>
    <text x="34" y="160" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">ControlPath=cm-%C hashes host+user only, so all 6 tabs</text>
    <text x="34" y="176" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">to yosemite-s1 ride ONE TCP connection.</text>

    <line x1="205" y1="67" x2="700" y2="67" stroke="#8b8b8b" stroke-width="1.5" marker-end="url(#ar)" />
    <text x="450" y="58" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">ssh -tt (multiplexed)</text>
    <path d="M 466 52 L 478 82 M 478 52 L 466 82" stroke="#f87171" stroke-width="2.5" />
    <text x="472" y="100" text-anchor="middle" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="10">blink</text>

    <rect x="700" y="44" width="220" height="46" rx="6" fill="#141414" stroke="#4a4a4a" />
    <text x="810" y="66" text-anchor="middle" fill="#d4d4d4" font-family="Inter, system-ui, sans-serif" font-size="13">sshd session (has the TTY)</text>
    <text x="810" y="82" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">no tmux — direct child</text>

    <line x1="810" y1="92" x2="810" y2="128" stroke="#f87171" stroke-width="2" marker-end="url(#arRed)" />
    <rect x="700" y="130" width="220" height="62" rx="6" fill="#1a0d0d" stroke="#f87171" stroke-width="1.5" />
    <text x="810" y="152" text-anchor="middle" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="11">DEFECT 1 — SIGHUP</text>
    <text x="810" y="170" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">the agent process dies.</text>
    <text x="810" y="185" text-anchor="middle" fill="#8b8b8b" font-family="Inter, system-ui, sans-serif" font-size="11">Work in flight is lost.</text>

    <rect x="20" y="222" width="410" height="88" rx="6" fill="#1a1206" stroke="#f59e0b" stroke-width="1.5" />
    <text x="34" y="244" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="11">DEFECT 2 — reconnect needs the network to learn the id</text>
    <text x="34" y="262" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">claude gets --session-id up front → reconnect runs.</text>
    <text x="34" y="278" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">grok/codex/gemini resolve it via an SSH read issued</text>
    <text x="34" y="294" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">AFTER the drop → it fails → no reconnect at all.</text>

    <rect x="20" y="336" width="196" height="70" rx="6" fill="#1a0d0d" stroke="#f87171" />
    <text x="118" y="358" text-anchor="middle" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="11">clip (b) — grok</text>
    <text x="118" y="376" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">silent drop to shell</text>
    <text x="118" y="392" text-anchor="middle" fill="#8b8b8b" font-family="Inter, system-ui, sans-serif" font-size="11">no notice, no retry</text>

    <rect x="234" y="336" width="196" height="70" rx="6" fill="#1a0d0d" stroke="#f87171" />
    <text x="332" y="358" text-anchor="middle" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="11">clip (a) — claude</text>
    <text x="332" y="376" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">retries a dead pane</text>
    <text x="332" y="392" text-anchor="middle" fill="#8b8b8b" font-family="Inter, system-ui, sans-serif" font-size="11">escape garbage, then shell</text>

    <rect x="490" y="222" width="430" height="88" rx="6" fill="#101a0a" stroke="#a3e635" stroke-width="1.5" />
    <text x="504" y="244" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">THE FIX — detach on the peer, then reconnect is real</text>
    <text x="504" y="262" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Wrap every REMOTE interactive run in tmux regardless of</text>
    <text x="504" y="278" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">the peer's local ergonomics toggle. The agent outlives the</text>
    <text x="504" y="294" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">transport, so reattach rejoins a LIVE pane instead of resuming.</text>

    <rect x="490" y="336" width="430" height="70" rx="6" fill="#101a0a" stroke="#a3e635" />
    <text x="705" y="358" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">then: per-tab ControlPath · launch-id reconnect · patient budget</text>
    <text x="705" y="378" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">One blip stops being a fleet-wide event, and every harness</text>
    <text x="705" y="394" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">recovers, not just Claude.</text>
  </svg>
  <figcaption><b>Figure 1.</b> One blink, three independent defects. Defect 1 is why the
  work is lost; defect 2 is why Grok got no reconnect; defect 3 is why <em>all</em> the
  tabs go at once.</figcaption>
</figure>

### Defect 1 — the remote agent is not detached (why work is lost)

`shouldWrapInTmux` requires the peer's `tmux.enabled`, which is off by default:

```ts title=apps/cli/src/lib/exec.ts:1425
export function shouldWrapInTmux(ctx: TmuxWrapContext): boolean {
  if (!ctx.interactive) return false;
  …
  if (!ctx.configEnabled) return false;   // ← the peer's `tmux.enabled`, default OFF
  if (!ctx.tmuxAvailable) return false;
  return true;
}
```

Every reason listed in that function's doc comment is about **local ergonomics** — an
addressable `%pane` so `agents sessions --active` can tell co-located agents apart, and
`agents focus` re-attaching without forking. Surviving a dropped SSH link is not mentioned.
The device-config help text confirms the framing: *"Turn it on … once the tmux mouse,
clipboard, and scrollback behavior suits this device."*

So a **remote** run's durability is gated on a **local** preference the user set for
entirely unrelated reasons. That is the design error. The default itself lives at
`apps/cli/src/lib/device-config.ts:224`.

There is a second-order bug in the same place: reconnect eligibility is decided **locally**
from the flags this side requested (`!isRaw`, `commands/exec.ts:1892`). The launcher has no
idea whether the peer's tmux gate actually passed, so it cannot know whether the agent
survived — yet it prints "the agent is still running there" regardless. Whether the wrap
engaged is a fact only the peer holds, and it is never reported back.

### Defect 2 — reconnect fetches its key over the network that just died

```ts title=apps/cli/src/commands/exec.ts:1862
if (correlationLaunchId) {
  try {
    resolvedRemoteId = resolveRemoteSessionId(sshTargetFor(host), correlationLaunchId);
  } catch { /* ssh read is best-effort */ }
  …
}
const reconnectId = … hostSessionId ?? resolvedRemoteId ?? resumeId;
if (reconnectId && !isRaw) { /* reconnect loop */ }
process.exit(exitCode);
```

`resolveRemoteSessionId` is **an SSH round-trip** (`lib/hosts/remote-session-id.ts:74`)
run *after* `runInteractiveOnHost` returned — i.e. after the link dropped. With the network
down it fails, `resolvedRemoteId` stays undefined, the guard is false, and the process exits.

Only Claude escapes this, because the extension hands it an id up front:

```ts title=apps/ext/src/core/agents.ts:238
if (sessionId && agentKey === 'claude') {
  command += ` --session-id ${sessionId}`;
}
```

Verified against the user's live processes at the time of the capture:

```
pid 81308  … yosemite-m6 … agents run claude  --interactive … --session-id 9847556a-…
pid 72418  … yosemite-s0 … agents run grok@   --interactive … --env AGENT_LAUNCH_ID=dcf80180-… (no --session-id)
```

**Auto-reconnect is Claude-only in practice.** Clip (b) is a Grok tab on yosemite-s0.

### Defect 3 — one shared connection under every tab on a host

`runInteractiveOnHost` multiplexes by default (`lib/hosts/dispatch.ts:645`,
`multiplex: !opts.copyCreds`), and `controlOpts()` builds a ControlPath keyed on
`%C` — a hash of local host, remote host, port and user only (`lib/ssh-exec.ts:114`).
Every tab to the same peer therefore shares **one** master connection. Verified live:

```
56732 ssh … ControlPath=…/cm-%C … yosemite-s1 … agents sessions focus 2f408818-…
56735 ssh … ControlPath=…/cm-%C … yosemite-s1 … agents sessions focus cf9a371a-…
56738 ssh … ControlPath=…/cm-%C … yosemite-s1 … agents sessions focus 4b0084b0-…
56741 ssh … ControlPath=…/cm-%C … yosemite-s1 … agents sessions focus accdd3b1-…
56742 ssh … ControlPath=…/cm-%C … yosemite-s1 … agents sessions focus 0cdc1592-…
56743 ssh … ControlPath=…/cm-%C … yosemite-s1 … agents sessions focus 2575318c-…
```

Six tabs, one socket. OpenSSH's documented behaviour is that killing the master closes
every multiplexed session abruptly. This is the mechanism behind *"all of my agents
basically just all exit"* — it is not six independent failures, it is one.

And it compounds **across** peers, not just within one. Every master shares the same
keepalive settings — `ServerAliveInterval=15`, `ServerAliveCountMax=3`
(`lib/ssh-exec.ts:53`) — so during a local Wi-Fi or ISP interruption every peer's master
gives up on the same ~45-second cadence. Tabs on yosemite-s0, s1 and m6 therefore die
together even though they share no connection. That is the missing half of why the failure
reads as *everything at once* rather than a few tabs on one box.

### Defect 4 — the budget is ~90 seconds

`MAX_ATTEMPTS = 6` with backoff 2s, 4s, 8s, 16s, 30s, 30s (`reconnect.ts:92`) gives a
total window of about 90 seconds. A laptop lid close, a Wi-Fi handoff, or a Tailscale
re-auth all exceed that comfortably, and on wake the suspended timers fire back-to-back
before the network is up — burning the budget in seconds.

### Defect 5 — nothing restores the terminal between attempts

`sshStream` is `spawnSync('ssh', …, { stdio: 'inherit' })` with `-tt`
(`lib/ssh-exec.ts:404`). There is **no** termios save/restore, no stdin drain, and no DEC
mode reset anywhere on this path — a grep for `setRawMode`, `stty`, or `?1004` across
`lib/hosts/`, `lib/ssh-exec.ts` and `commands/exec.ts` returns nothing. When ssh dies hard,
the local tty is left in raw mode with the remote app's reporting modes still enabled, so
the terminal's own responses echo as literal garbage — exactly the
`^[[?997;1n ^[[I ^[[O` in clip (a) — and those buffered bytes are then fed straight into
the next attach's stdin. There is also no `SIGINT` handler, so the `^C` visible in that
clip killed the whole `agents` process mid-loop.

### Defect 6 — the ext dead-ends, and the guidance is stale

The extension has no notion of a dropped agent: a grep of `watchdog.vscode.ts` for
`reconnect`/`dropped`/`255` returns nothing. `wrapNativeAgentCommand`
(`apps/ext/src/core/agents.ts:273`) prints `Agent exited with status $ec` and leaves a bare
shell. Meanwhile all three give-up notices (`reconnect.ts:179`, `:190`, `:199`) tell the
user to run `agents reconnect <id>` — a command that is **deprecated and hidden**
(`apps/cli/src/commands/reconnect.ts:98`).

## Verification

The plan skill calls for independent agents to plan the same problem blind. Four attempts;
one produced usable results:

| Verifier | Outcome |
| --- | --- |
| `gemini` on yosemite-m3 | Could not run — Google retired the Gemini CLI on 2026-06-18 |
| `antigravity` on yosemite-m3 | Could not run — no healthy account (`signed_out`) |
| `codex` on yosemite-m1 | Could not run — read sandbox failed (`bwrap: setting up uid map: Permission denied`) on the Linux peer. It correctly refused to guess rather than produce an ungrounded diagnosis. |
| **`codex` on zion** | **Completed with full source access.** |

The verifier that ran was given the two screenshots' symptoms and the launch command, and
was told nothing about the approach here. It independently reached **the same four defects
in the same priority order** — remote runs not detached because `tmux.enabled` defaults
off, reconnect skipped for non-Claude because the id is resolved after the drop, one shared
ControlMaster per peer, and missing TTY cleanup between attach attempts — with its own
file:line citations. Its top-four fix list matches F1–F3 and F5.

It contributed two things this plan did not have, both folded in above:

- **Reconnect cannot know whether the agent survived.** Eligibility is decided from locally
  requested flags at `commands/exec.ts:1892`; the peer's tmux gate result never crosses
  back. The "still running there" claim is therefore structurally unknowable, not merely
  currently-wrong — so F1 now carries a report-back requirement.
- **The correlation is cross-peer, not just same-peer.** Shared `ServerAliveInterval=15` /
  `CountMax=3` (`lib/ssh-exec.ts:53`) makes every host's master time out on the same
  cadence, so tabs on *different* boxes die together too.

Nothing in the verifier's findings contradicted the diagnosis. Confidence is high on the
root cause and on F1–F3; F4 and F6 are design choices it did not weigh in on.

## Proposed Changes

Ordered by impact. F1 is the fix; everything after it is what makes F1 usable.

### F1 — a remote interactive run is always detached on the peer

Split durability from ergonomics. `tmux.enabled` keeps its documented meaning (a local
mouse/clipboard/scrollback preference). A run that arrives over SSH gets wrapped
regardless, because for that run the wrap is not a preference — it is the only thing
keeping the agent alive.

```diff title=apps/cli/src/lib/exec.ts
@@ interface TmuxWrapContext @@
   /** This device's `tmux.enabled` config — true opts every eligible launch on this box into the wrap. */
   configEnabled: boolean;
+  /** True when this run was dispatched here over SSH by `--device`. A remote run's
+   *  agent is a child of the sshd session, so without the wrap a dropped link
+   *  SIGHUPs it. Durability, unlike `configEnabled`, is not a preference. */
+  remoteDispatch: boolean;
   /** Whether a tmux binary is on PATH. */
   tmuxAvailable: boolean;

@@ export function shouldWrapInTmux @@
-  if (!ctx.configEnabled) return false;
+  if (!ctx.configEnabled && !ctx.remoteDispatch) return false;
   if (!ctx.tmuxAvailable) return false;
```

`remoteDispatch` is read from an env marker the dispatcher already has a natural place to
set — `remoteRunShellPrelude` in `lib/hosts/dispatch.ts` already exports
`AGENTS_ACTOR`/`AGENT_TERMINAL_ID` into the remote command, so this rides the same hop.

**Fail loud, per the repo's boundary rule:** if `remoteDispatch` is set and tmux is *not*
installed on the peer, the run must refuse with a clear message rather than launch an agent
that cannot survive. `ensureHostReady` already gates every `--device` dispatch on a peer
probe, so the check belongs there, before a TTY is opened. (`tmux` is present on the peers
checked: `/usr/bin/tmux` on both s0 and s1.)

**The peer must report whether the wrap engaged.** Reconnect currently infers survivability
from locally-requested flags and gets it wrong. The remote run should emit its durability
state (wrapped / not wrapped, plus the pane handle) alongside the session id it already
emits, so the reconnect loop claims "still running there" only when that is a fact it was
told, never an assumption. Without this, F1 fixes the behaviour but leaves the message able
to lie again the next time the gate changes.

### F2 — reconnect keys off an id the launcher already holds

The launcher mints `AGENT_LAUNCH_ID` locally (`commands/exec.ts:1801`) and forwards it. Let
the peer resolve *by launch id*, so the local side never needs a network read to know what
to reconnect to:

```diff title=apps/cli/src/commands/exec.ts
-const reconnectId = (runAgent === RUN_AUTO_KEYWORD
-  ? resolvedRemoteId ?? hostSessionId
-  : hostSessionId ?? resolvedRemoteId) ?? resumeId;
-if (reconnectId && !isRaw) {
+// A launch id is known BEFORE the connection exists, so it survives the drop that
+// a post-hoc `resolveRemoteSessionId` read cannot (it needs the dead link).
+const reconnectTarget = pickReconnectTarget({
+  sessionId: hostSessionId, resolved: resolvedRemoteId, resume: resumeId,
+  launchId: correlationLaunchId, agent: runAgent,
+});
+if (reconnectTarget && !isRaw) {
```

with `agents sessions focus --launch-id <id> --local` on the peer side. This closes the
Claude-only asymmetry once, in the CLI, rather than teaching the extension to emit
`--session-id` per harness — and it covers every harness the capability applies to
(codex, grok, gemini, kimi, droid, cursor, opencode, …), as the harness-parity rule requires.

### F3 — interactive agent streams get their own connection

```diff title=apps/cli/src/lib/hosts/dispatch.ts
   return sshStream(target, remoteCmd, {
     tty: process.stdin.isTTY,
-    multiplex: !opts.copyCreds,
+    // An interactive agent stream must NOT ride the shared master: every tab to a
+    // peer hashes to the same ControlPath, so one dropped master takes them all
+    // down together. The handshake it saves is a one-time ~200ms on a session
+    // that lives for hours.
+    multiplex: false,
```

### F4 — a patient, interruptible, honest reconnect

Once F1 holds, "the agent is still running there" becomes true and the loop can afford to
wait. Replace the fixed attempt count with a wall-clock window (default 15 minutes, capped
30s backoff), print a live countdown, and handle `SIGINT` explicitly so `Ctrl-C` leaves the
loop cleanly instead of killing the process mid-print.

### F5 — terminal hygiene around every attach

Save termios before each `sshStream` and restore after; on return, emit the reset set
(`\e[?1004l \e[?2004l \e[?997l \e[?1049l \e[?25h`) and drain buffered stdin before writing
the notice. This is one helper in `ssh-exec.ts` wrapping the existing `spawnSync`, so every
caller benefits rather than the reconnect path alone.

### F6 — the tab never dead-ends, and the Fleet panel says so

Per the repo's scheduling-singularity rule, detection and action stay in the CLI. The
extension only renders: a tab whose agent is reconnecting shows as `reconnecting`, and
`wrapNativeAgentCommand` re-enters the CLI recovery verb on a remote 255 rather than
dropping to a prompt. No new timer or watcher in `apps/ext`.

### F7 — stop pointing at a deprecated command

`exhaustedNotice` / `unstableNotice` / `remoteExitNotice` should recommend
`agents sessions resume <id>`, not the hidden-and-deprecated `agents reconnect`.

## Public Interface

```bash
# Unchanged for the user. Behaviour changes:
agents run <agent> --interactive --device <host>
#   → now always detached on the peer; survives a dropped link
#   → reconnects for EVERY harness, not just claude
#   → keeps trying for ~15 min (was ~90s), Ctrl-C to stop

agents sessions focus --launch-id <id> --local   # new selector (peer-side)
agents sessions resume <id>                      # what the give-up notices now recommend
```

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="capture">
    <strong>Current — clip (b), Grok on yosemite-s0</strong>
    <pre><code>Shared connection to yosemite-s0.tail1a85a1.ts.net closed.
agents-cli % ▊</code></pre>
    <p>No notice, no retry, no session id. The agent on the peer is dead and the
    transcript ends mid-turn. Five sibling tabs on the same host died in the same instant.</p>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <strong>Proposed — same drop, same tab</strong>
    <pre><code>── link to yosemite-s0 dropped ─────────────────────────
   grok is still running there (detached pane ag-grok-dcf80180).
   Reconnecting… next attempt in 4s · 14m51s left
   Ctrl-C to stop · r to retry now
── reconnected ─────────────────────────────────────────
</code></pre>
    <p>The agent kept working through the outage. The tab rejoins the <em>live</em> pane,
    not a resumed copy, so the in-flight turn is intact. Sibling tabs are unaffected —
    they no longer share a connection.</p>
  </div>
</div>

## Validation

| Check | Expected result |
| --- | --- |
| Kill the link mid-turn (`sudo pfctl` block / Tailscale down) on a Grok tab | Reconnect notice appears; agent still running on the peer; tab rejoins the live pane |
| Same, on a Claude tab | Identical behaviour — no harness asymmetry |
| Drop the link with 6 tabs open on one host | Only the tabs on that host show a notice; each recovers independently |
| Close the laptop lid for 10 minutes | On wake, tabs reconnect rather than having given up |
| `agents ssh <peer> tmux ls` during a remote run | A detached `ag-<agent>-<id>` session exists |
| Peer without tmux installed | `--device` run refuses with a clear message, no TTY opened |
| `Ctrl-C` during the backoff | Loop exits cleanly; no escape garbage; shell is in cooked mode |

## Risks

| Risk | Mitigation |
| --- | --- |
| **tmux degrades the agent TUI** — OSC 8 hyperlinks are not clickable inside tmux ([claude-code#27047](https://github.com/anthropics/claude-code/issues/27047)), and mouse/clipboard/scrollback change. The captured screenshot shows a clickable link, so this is a real regression for this user. | This is the one genuine product decision in the plan — see *Open decision* below. Mitigate with a tuned tmux profile (`set -g allow-passthrough on`, mouse on, large history) and measure against the real TUI before landing. |
| Dropping multiplexing adds a handshake per tab launch | ~200ms once, on a session lasting hours. Only the interactive stream changes; probes and fan-outs keep the shared master. |
| tmux missing on some peer | F1 fails loud at `ensureHostReady` rather than launching an unsurvivable run. |
| A longer retry window hides a genuinely dead agent | The window is wall-clock bounded and the countdown is visible; the pane is probed each attempt, so a dead pane stops the loop rather than waiting it out. |

### Open decision

**Multiplexer choice.** tmux is already implemented, already on every peer
(`/usr/bin/tmux` on s0 and s1), and needs no new dependency — but it inserts a full
terminal emulator between the agent and the terminal, which costs OSC 8 and changes
mouse/scrollback. `abduco` (the maintained successor to `dtach`) is a pure pty detacher
with *no* terminal emulation, so escape sequences pass through untouched — but it is not
installed on the fleet and gives up tmux's addressable panes, which
`agents sessions --active`, `agents message`, and injection all depend on today.

Recommendation: **tmux**, because the pane addressability is load-bearing for existing
features and re-implementing it on abduco is a much larger change than this bug warrants.
Worth a timed look at the TUI before landing.

## Checklist

- [x] Root cause confirmed against the live fleet
- [ ] F1 — remote dispatch always detached on the peer (+ fail loud without tmux)
- [ ] F2 — reconnect by launch id, all harnesses
- [ ] F3 — per-tab connection for interactive streams
- [ ] F4 — patient, interruptible reconnect with countdown
- [ ] F5 — termios save/restore + stdin drain + DEC reset
- [ ] F6 — ext renders `reconnecting`; no dead-end shell
- [ ] F7 — notices point at `agents sessions resume`
- [ ] Tests: real drop against a real peer, per the no-mocking rule
- [ ] Docs: `apps/cli/docs/specifications.md` §Agent execution, ext AGENTS.md, CHANGELOG
- [ ] PR opened with a recording of a real drop-and-recover

## Tracking

- [RUSH-3125](https://linear.app/prix/issue/RUSH-3125) — Agent tabs die on a network blink: remote interactive runs are not detached on the peer
- Branch: `fix/ext-agent-reconnect`
