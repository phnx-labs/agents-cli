# SSH transport — one multiplexed engine (design decision)

> Status: **accepted** · Related: [hosts.md](hosts.md), [99-optimizations.md](99-optimizations.md#opt-02-ssh-transport--one-multiplexed-engine), [00-concepts.md](00-concepts.md#devices--hosts)

A design record for *how `agents` talks to remote machines over SSH*. Every
remote surface — `run --host`, `view/usage/cost/doctor/inspect/list/sync --host`,
`sessions -H`, `teams … --host`, remote `secrets`, the browser CDP tunnel — moves
bytes over the system `ssh`. This doc pins down the one transport they all share,
and why it is a set of shared primitives rather than a daemon.

## Context

The fleet is driven from a laptop — frequently an 8 GB MacBook — that fans out to
Macs, Linux boxes, and a Windows mini over Tailscale. The scarce resource is not
the remote machine's CPU. It is **local**: every `ssh` the CLI forks is a process
in the laptop's table, a TCP socket, an ephemeral port, and a full public-key
handshake against the laptop's kernel and CPU. A transport that reopens a
connection per logical operation turns a quiet "watch this run" into thousands of
handshakes an hour on the one machine the user is actually sitting at.

The transport already funnelled through a single hardened choke point,
`sshExec`/`sshStream` in [`src/lib/ssh-exec.ts`](../src/lib/ssh-exec.ts), and
OpenSSH connection multiplexing (`ControlMaster`) was already implemented there.
The problem was that it was **opt-in** and almost nobody opted in.

## Goals / non-goals

**Goals**

- One connection strategy for every remote surface, defined in one place.
- Minimize *local* cost: process spawns, sockets, handshakes, zombie connections.
- No new always-on service, port, or protocol to run on every Mac and Linux box.
- No behavior regressions; multiplexing must never make a reachable host unreachable.

**Non-goals**

- A bespoke agent/relay daemon (see [Alternatives](#alternatives-considered)).
- Parallelizing the multi-host fan-out (it is deliberately serial — one `ssh`
  alive at a time is memory-safe on a small laptop; latency is the accepted cost).
- Changing the detached-dispatch model (`nohup` + offset-tail) that lets a remote
  job survive a dropped connection — that design is orthogonal and stays.

## The problem, with evidence

Multiplexing was gated behind `multiplex: true` and only 3 of ~13 call paths
passed it. The un-multiplexed callers were precisely the hot ones:

| # | Where | Cost before |
|---|---|---|
| P1 | `followHostTask` ([`progress.ts`](../src/lib/hosts/progress.ts)) — the poll behind every `run --host` / `teams … --watch` | **2 un-muxed ssh / 1.5 s ≈ 4,800 process spawns/hour**, per followed job |
| P2 | `ensureHostReady` ([`ready.ts`](../src/lib/hosts/ready.ts)) — runs before every dispatch | **3 sequential connections** (reachable + version + agent listing), 2 un-muxed |
| P3 | `sshExec`/`sshStream` default | multiplexing opt-in; the common paths skipped it |
| P4 | `runRemoteSessions` ([`session/remote.ts`](../src/lib/session/remote.ts)) | a **private copy** of the ssh options with no multiplexing |
| P5 | secrets push, the `-N` tunnel, and other direct `spawn('ssh')` sites | bypass the choke point; some under-specified (no `ConnectTimeout`) |
| P6 | `hosts add` ([`hosts.ts`](../src/commands/hosts.ts)) | a duplicate reachability probe |
| P7 | `SSH_OPTS` | no keepalive — a dropped link hangs instead of dying |

## Design

The transport is **two shared primitives, and everything composes from them.**

### 1. One hardened baseline: `SSH_OPTS`

```
StrictHostKeyChecking=accept-new   BatchMode=yes   ConnectTimeout=10
ServerAliveInterval=15   ServerAliveCountMax=3          ← keepalive (P7)
```

Every `ssh` in the codebase composes this list — directly through
`sshExec`/`sshStream`, or as `[...SSH_OPTS, …extra]` in the handful of callers
that need `-L`/`-N`/`ProxyCommand`. The keepalive means a silently-dropped
connection (laptop sleeps, Wi-Fi flips) is detected and the `ssh` process exits
within ~45 s (`15 × 3`) instead of pinning a zombie process + socket on the
laptop. Long-lived `-N` tunnels inherit it by composing the same baseline.

### 2. One multiplex helper: `controlOpts()`, default-on

```
ControlMaster=auto   ControlPath=~/.agents/.cache/ssh/cm-%C   ControlPersist=60s
```

The first connection to a host opens a control socket; every later connection —
even from a *separate* `agents` invocation — rides it, skipping the TCP+auth
handshake. This is now the **default** (`opts.multiplex === false ? [] :
controlOpts()`); a caller opts *out* only for a genuine one-shot where a lingering
60 s master is pure overhead. Flipping this one default is what fixes P1's poll,
P2's probes, and P4's fan-out at once — they already routed through the engine and
simply started reusing sockets. It degrades safely: if the socket can't be opened
ssh falls back to a fresh connection, and on Windows (no `ControlMaster`) the
helper returns `[]`.

### 2b. Host-key pinning: a managed `known_hosts` (RUSH-1767)

`accept-new` in the baseline is trust-on-first-use: it silently accepts whatever
key answers on the first connect and never re-checks it, so a
machine-in-the-middle present in that window is trusted forever. The CLI keeps its
own `known_hosts` store — `~/.agents/.cache/devices/known_hosts` (mode 0600),
separate from `~/.ssh/known_hosts` — so a device's key can be *pinned*
([`known-hosts.ts`](../src/lib/devices/known-hosts.ts)):

```
UserKnownHostsFile=<managed store>   StrictHostKeyChecking=yes   ← once pinned
UserKnownHostsFile=<managed store>   StrictHostKeyChecking=accept-new  ← first connect
```

`agents ssh <device>` learns the key on first connect (`accept-new`, written into
the managed store) and verifies it with `StrictHostKeyChecking=yes` on every
subsequent connect — a later key swap is refused, not re-accepted. `run --host
--copy-creds` **refuses** a host that isn't pinned there and, when it does run,
prepends the strict host-key opts (they must come *before* the baseline —
`sshConnectOpts` — because ssh honors the first value seen for each option) over a
fresh, non-multiplexed connection, so credentials never ride an unverified
connect. A registered device earns its pin the ordinary way — connect once with
`agents ssh <device>`. But a bare `~/.ssh/config` `Host` alias (or ad-hoc literal)
is **not** a registered device, so `agents ssh <alias>` dead-ends at "Unknown
device" and could never pin it; for that case the `--copy-creds` gate pins the
target itself with `pinHostKey` (ssh-keyscan against the alias's real
`HostName`/`Port`, resolved via `ssh -G`) before shipping anything, so
`--copy-creds` works for ssh-config-alias hosts instead of dead-ending.
**Remaining:** the broad `accept-new` baseline still governs
non-credential fan-outs (`sessions --host`, the browser driver, `fleet run`),
which still use OpenSSH default `~/.ssh/known_hosts`, not the managed store, so
they neither pin into it nor verify against it. Wiring those call sites onto the
managed store (so they verify strictly too) is follow-up.

### 3. The follow loop: one round-trip per cycle (P1)

The old loop made two calls per cycle — `tail -c +offset` for new log bytes, then
`cat .exit`. Rewritten to a single round-trip:

```
tail -c +<offset> <log>;  printf '<sentinel>';  cat <exit>
```

`splitProgressOutput` splits the response on the **last** occurrence of a
per-task sentinel (`@@AGENTS_HOST_EXIT_<taskId>@@`), so the log tail, an end
marker, and the exit code come back together and are separated without ever
miscounting the byte offset (the marker and exit bytes come from `printf`/`cat`,
never the log). Splitting on the *last* marker means even if the agent's own
output echoed the token, the real trailing sentinel still wins. The sentinel's
`printf` format is derived from the same `exitMarker()` the parser uses, so the
two can never desync. On top of that: **default multiplexing** (each cycle reuses
the socket the launch opened) and **adaptive backoff** (1.5 s while output flows,
easing toward 4 s when idle). Net: 50 % fewer process spawns *and* each spawn is a
socket reuse instead of a handshake.

### 4. Readiness: three round-trips to one (P2)

`readyProbe` replaces the reachable → version → agent-listing sequence with one
compound `bash -lc` script. Reachability keys off the returned sentinel, not the
exit code — so a command that *ran but failed* is never misread as a dead
connection, and only ssh's own connection-layer failure (no sentinel) reads as
unreachable.

## Alternatives considered

**A bespoke daemon / relay on every host.** Rejected. It would add a socket
server, a port or tunnel, a custom wire protocol, and its own auth to every Mac
and Linux box — for no capability SSH doesn't already give us. SSH is more
*reliable* (battle-tested, no long-lived process to crash or double-run, host-key
trust + auth + encryption for free) and, with multiplexing, just as *fast* for
repeated calls. Reliability for long jobs already comes from detached `nohup`
dispatch, which survives a dropped connection without any daemon. The scheduling
daemon stays scoped to scheduling.

**Parallel multi-host fan-out.** Rejected as a default. On a small laptop, N
concurrent `ssh` processes trade the one resource we are protecting (local
memory/process pressure) for latency we can tolerate. The serial loop keeps at
most one `ssh` alive; multiplexing already removes the repeat-handshake cost.

**A persistent `tail -f` stream for follow.** Deferred, not rejected. A single
long-lived streaming connection would drop per-cycle spawns to zero, but
complicates offset-resume-on-disconnect and exit capture. The combined-round-trip
+ multiplexing design captures most of the win at a fraction of the complexity;
streaming is future work.

## Results

Measured against a live Tailscale-relayed host (`scripts/bench-ssh.mjs`), stable
across runs. Each number is wall-clock on the laptop:

| Path | Before | After | Win |
|---|---|---|---|
| P3 · repeated `--host` (per call) | ~444 ms | **~75 ms** | **~6–7×** |
| P2 · readiness per dispatch | 1.5–1.8 s | **~0.8 s** | **~2×** |
| P1 · follow loop (per cycle) | ~706 ms | **~33 ms** | **~21–23×**, 50 % fewer spawns |

The P1 figure is the headline: an old cycle paid two fresh handshakes (~706 ms on
a relayed link); the new cycle rides the reused socket (~33 ms). Over an hour of
following that is the difference between the laptop grinding through thousands of
handshakes and holding one socket open.

Reproduce: `bun run build && node scripts/bench-ssh.mjs <host>`.

## Trade-offs and risks

- **A 60 s master lingers after each call.** `ControlPersist=60s` keeps an idle
  master briefly so back-to-back commands reuse it. The cost is bounded (one idle
  unix socket per recently-touched host, reaped after 60 s) and is the entire
  point. An interactive one-shot that must not leave a master can pass
  `multiplex: false`.
- **Keepalive terminates a live-but-silent connection after ~45 s.** Intended: a
  genuinely idle-but-healthy link is re-established on the next call for near-zero
  cost via the control socket; a dead one no longer hangs.
- **Sentinel-based framing** assumes the remote login shell runs (a `bash -lc`
  assumption shared by every remote call in the codebase). A bash-less remote
  reads as unreachable — the same failure the old code produced, with a clearer
  message.

## Rollout and future work

Shipped as one PR: the engine change plus every consumer, unit tests, an A/B
benchmark harness, and this doc. Behavior-preserving — the only observable change
is that remote commands are faster and dead connections self-terminate.

Follow-ups (non-blocking):

- Remove the now-unused `sshReachable` export.
- Route the remaining specialized direct-`ssh` sites (browser CDP, cloud
  `ProxyCommand`, drive-sync) through the shared baseline.
- Evaluate the persistent `tail -f` streaming follow.
