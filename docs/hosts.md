# Hosts — dispatch agents to your own machines (design)

> **Status:** Design / RFC. No implementation yet. This document is for review
> before any code lands.

`agents hosts` lets you run any agent (`claude`, `codex`, `droid`, …) on any of
*your* machines — a Mac mini, a Windows mini, a couple of DGX Sparks — over your
own tailnet, with no central service to run or pay for:

```
agents run claude "fix the auth bug"   --on mac-mini
agents run codex  "port this to rust"  --on spark-0
agents run droid  "triage the inbox"   --on win-mini
```

It sits next to the vendor clouds (`agents cloud run --provider rush|codex|…`),
not replacing them: those dispatch to *someone else's* cloud; `hosts` dispatches
to *your* boxes (owned, or leased on demand via crabbox — see Host sources).

## Motivation — the bottleneck is OS coordination, not RAM

This is grounded in a real incident (Agent Workload Resource Report, 2026-06-27).
A 30-core workstation became unusable while running agents — but **not** from
memory pressure (102G used, **25G free**). The failure was **OS-coordination
starvation**:

```
Load Avg: 232.61, 306.45, 245.25
CPU: 18.99% user, 79.35% sys, 1.65% idle
Processes: 1807 total, 13322 threads
```

~79% of CPU was spent *inside the kernel* (scheduling, vnode/path resolution,
symlink handling, filesystem metadata) — a recursive `ripgrep` search-storm from
an editor extension, plus the general process/file/UI fan-out of agent tooling. A
Linux 16-vCPU comparison showed the same shape (`system_pct` ~50, `runnable` ~38,
high fork rate). The report's conclusions map directly onto this design:

- **"Separate headless agent execution from interactive rendering."** Running an
  agent headless and publishing *summarized state transitions* — instead of
  rendering its full transcript character-by-character in a desktop UI — is what
  lets a machine carry more concurrent work. This is exactly the transcript-tail
  progress model (§4): the agent runs headless on the host; we read summarized
  events from its transcript, we don't live-render a remote TTY.
- **"A cloud or Linux box helps only if synchronization overhead is
  controlled."** Offloading is necessary (your laptop has finite coordination
  capacity), but the remote run must be bounded — headless, concurrency-capped,
  no unbounded recursive scans. The design must carry those constraints to the
  host, not just relocate the storm.

So `hosts` isn't only "I want more cores" — it's "keep my interactive machine
responsive by moving headless agent execution off it," which the report shows is
a coordination problem money-can't-buy-RAM doesn't fix.

## Why this is brokerless (the core thesis)

Every hosted-agent product surveyed — OpenAI Codex, Cursor cloud agents, Cognition
Devin, Factory Droid Computers, Google Jules, Anthropic Managed Agents — runs a
central relay/control-plane. But they all do it for **one** reason: they are
multi-tenant and their machines sit behind NAT they don't control, so they need a
relay for NAT traversal + discovery + identity + heartbeat. Cursor and Factory say
so directly — the relay exists "so no inbound ports / VPN required" (i.e.
*because there is no VPN*).

- Cursor self-hosted: outbound HTTPS worker → control plane. <https://cursor.com/blog/self-hosted-cloud-agents>
- Factory BYOM: outbound WebSocket → Factory relay. <https://docs.factory.ai/cli/features/droid-computers>
- Anthropic self-hosted: outbound HTTPS poll of a work queue. <https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes>

We have a VPN: a Tailscale tailnet already connects these machines (the `ssh-keys`
bundle already unlocks `mac-mini` et al.). On a tailnet the entire broker layer
collapses — verified against Tailscale's own APIs:

| What a relay-broker provides | Tailscale gives it for free |
|---|---|
| connection registry (name → address) | `tailscale status --json` → `PeerStatus{HostName, DNSName, OS, TailscaleIPs}` |
| heartbeat / "is it online?" | `PeerStatus.Online` (pushed live by the coordination server — no daemon of ours) |
| NAT traversal | WireGuard + DERP, zero config |
| SSH key distribution / rotation | Tailscale SSH via ACL tags, or the existing `ssh-keys` bundle |
| identity / always-on nodes | tagged nodes, key-expiry disabled |

So this prior art's relay (rush's `prix/api/src/computers/relay.ts` + the Go daemon's
outbound WebSocket in `rush/cli/internal/daemon`) is exactly the part we **don't**
need. What a free CLI needs is: read `tailscale status --json`, filter `Online`,
`ssh <node> 'agents run …'`. No metadata service, no DB, no heartbeat.

Refs: `tailscale status --json` → `ipnstate.PeerStatus`
(<https://pkg.go.dev/tailscale.com/ipn/ipnstate>); `Online`/`LastSeen` semantics
(<https://github.com/tailscale/tailscale/issues/16584>); Tailscale SSH
(<https://tailscale.com/docs/features/tailscale-ssh>).

## What the field actually does (and where we can be better)

Remote-agent UX has converged on two modes:

- **Relay / remote-control** — the agent keeps running on machine A; B is a live
  window (Claude Code Remote Control, Codex remote-SSH from the phone). Seamless,
  but A must stay awake. <https://code.claude.com/docs/en/remote-control>
- **Migrate / handoff** — the session moves (Claude `--teleport`, Codex thread
  handoff, Cursor "Move to Cloud", Devin `/handoff`). But **every one transfers
  only committed git + the transcript and either blocks on or silently drops
  uncommitted changes.** Devin alone moves full state — via proprietary VM
  block-diff snapshots, only inside its own cloud (<https://cognition.com/blog/blockdiff>).

The uncommitted-changes wall exists because those tools **can't reach into your
machine** — no VPN, multi-tenant. We don't have that constraint. Over the tailnet
we control both ends, so a handoff can `rsync` the dirty working tree directly —
no "clean git required," no VM snapshots. That is the differentiated capability
(Phase 2), and it's something Claude Teleport / Cursor have open issues asking for.

## Architecture

```
agents run <agent> "<task>" --on <host>
  │
  ├─ resolveHost(name)         tailscale status --json → online? OS? addr   [Phase 1]
  │
  ├─ ssh <node> 'agents run <agent> --print "<task>"'                       [Phase 1]
  │     reuse src/lib/browser/drivers/ssh.ts (runSSHCommand, shellQuote)
  │     remote agents-cli builds the harness argv (buildExecCommand, exec.ts)
  │
  ├─ progress  ◀── incrementally tail the REMOTE transcript file           [Phase 1]
  │     not the live SSH stdout pipe — the transcript on disk is the
  │     durable log. Offset-tracked reads (like session/active.ts), parsed
  │     by the existing per-agent parsers (session/parse.ts).
  │
  └─ track in the cloud store (a `host` provider) so                       [Phase 1.5]
        agents cloud list / status / logs see host runs
```

### Host sources — owned (tailnet) + leased on demand (crabbox)

A "host" comes from one of two sources, but both reduce to **a tailnet SSH
target**, so the dispatch path (§2–§4) is identical:

- **Owned, always-on** — your mac-mini, win-mini, DGX Sparks. Discovered live via
  `tailscale status` (§1). Zero provisioning; they're just there.
- **Leased, on demand** — ephemeral cloud machines provisioned by **crabbox**,
  which is already installed and already a multi-cloud leasing layer:
  `--provider hetzner|aws|azure|gcp|proxmox|e2b|modal|sprites|daytona|…`
  (verified from `crabbox warmup --help`; AWS/EC2 is `--provider aws` with
  `CRABBOX_AWS_REGION` + spot/on-demand). Crucially, crabbox machines **join your
  tailnet** (`CRABBOX_TAILSCALE_AUTH_KEY`) and expose SSH (`crabbox ssh --id`),
  with idle-timeout/TTL auto-expiry (`CRABBOX_IDLE_TIMEOUT`, `CRABBOX_TTL`). So a
  leased box is the same kind of target as an owned one.

This is the answer to "I need machines but don't own enough": when the laptop is
starving, lease one.

```
agents run claude "big refactor" --on new           # crabbox warmup (default provider) → run → idle-release
agents run codex  "gpu eval"     --on new:aws        # provider/class selector → EC2 → run
agents run droid  "triage"       --on mac-mini       # owned, always-on
```

`--on new[:<provider/class>]` leases via crabbox, runs headless, and releases on
idle/TTL. agents-cli **does not** reimplement provisioning — crabbox owns lease
lifecycle, cost, multi-cloud, and the tailnet join; `hosts` owns *dispatch*. The
overlap is deliberate: `crabbox run --provider ssh --static-host mac.local` shows
crabbox already unifies leased + static SSH targets; we layer harness-agnostic
agent dispatch + transcript-tail progress on top.

Open question (carried below): how thin is the crabbox integration — shell out to
the `crabbox` CLI (`warmup`/`ssh`/`stop`), or treat crabbox-leased boxes purely as
tailnet peers once they've joined? (Leaning: shell out for lease/release, then the
common tailnet-SSH path for everything else.)

### 1. Discovery — Tailscale-native (no registry required)

The fleet **is** `tailscale status --json`. A host resolves to the peer whose
`HostName`/`DNSName` matches; we read `Online` (gate dispatch on it), `OS`, and
`TailscaleIPs[0]`. `agents hosts` is then a thin layer:

- `agents hosts list` — table of tailnet peers: name, OS, online, IP, tags.
- `agents hosts add <name> …` — *optional* overlay in `agents.yaml` for a friendly
  alias, a non-default ssh user, or a capability tag (e.g. `gpu: dgx-spark`) the
  tailnet doesn't carry. Pure sugar — discovery works with zero config.
- `agents hosts check <name>` — ssh probe + remote `agents --version` + remote
  `agents list` (which agents are installed there).

Implementation note: the `tailscale status --json` schema is documented
"subject to change," so the reader must be defensive (parse the fields we use,
tolerate the rest). A small `src/lib/hosts/tailscale.ts` wraps it.

`agents.yaml` overlay (optional):

```yaml
hosts:
  spark-0: { tailnet: spark-0.tailXXXX.ts.net, user: muqsit, gpu: dgx-spark }
  win-mini: { tailnet: win-mini, user: muqsit, os: windows }
```

Resolution order for an address: explicit `hosts.<name>.tailnet` > a `tailscale
status` peer whose HostName == name > error with the candidate list.

### 2. Transport — tailnet SSH (reuse, don't reinvent)

`src/lib/browser/drivers/ssh.ts` already has the whole pattern: `runSSHCommand`,
`shellQuote`, `startSSHTunnel`, `ensureRemoteBrowser`, with
`StrictHostKeyChecking=accept-new`, `BatchMode=yes`, `ConnectTimeout`. A
`src/lib/hosts/dispatch.ts` calls the same helpers to run the remote command and
inherit stdout/stderr/exit. SSH is the protocol — it gives auth + transport +
stream + exit code; no custom `command_output`/`command_done` framing (which is
what the rush daemon had to invent over its WebSocket).

Auth: the existing tailnet `ssh-keys` bundle, or Tailscale SSH (`tailscale ssh
<node> <cmd>`) where ACL tags remove key management entirely.

### 3. Execution — remote `agents run` (harness-agnostic)

The remote command is literally `agents run <agent> --print "<task>"` (+ `--mode`,
`--model`, `--json`, `--quiet`). `agents run` already produces the right headless
argv per harness via `buildExecCommand` (`src/lib/exec.ts`), so **every harness,
mode, and secret-injection path works remotely for free** — provided agents-cli +
that agent are installed and authed on the box (`agents hosts check` verifies).

Workspace (where the run executes) is a deliberate scoping choice — see Open
Questions. Phase 1 default: a caller-specified `--remote-cwd` (or the repo's
existing checkout on the box). The rush per-task git-worktree workspace
(`rush/cli/internal/daemon/workspace.go`: warm clone + `git worktree add
--detach` + secret denylist + PATH shim) is the model to port **later** if we
want isolated, repo-URL-driven runs.

### 4. Progress — incrementally tail the remote transcript (the key idea)

Streaming raw SSH stdout ties progress to the live pipe: drop the connection and
you lose the run's visibility. Instead, lean on the fact that **every agent already
writes a JSONL transcript to disk** (Claude/Codex/Gemini/Droid/…), and agents-cli
**already parses those** (`src/lib/session/parse.ts`: `parseClaude`, `parseCodex`,
`parseGemini`, … → `SessionEvent[]`; locations via
`session/discover.ts:getAgentSessionDirs`).

So host progress = **tail the remote transcript file, offset-tracked**, parse the
new lines, render with the existing `SessionEvent` pipeline. This is the same shape
as `session/active.ts:200-248`, which already does offset reads
(`fs.readSync(fd, chunk, 0, chunkSize, totalRead)`) rather than re-reading the
file or scanning the directory.

Mechanics:
1. Resolve the run's transcript path on the remote (agent + session id; `agents
   run --json` surfaces the session id, or we derive it from the agent's dir).
2. Poll cheaply over SSH from a byte offset — `ssh <node> "tail -c +<offset>
   <file>"` (or `dd`/`stat` for size), keeping a per-run `{file, offset}` cursor.
3. Feed new bytes to the matching `parseX` function; render incrementally.
4. Reconnect = resume from the saved offset. No live-pipe dependency.

This is precisely the user's "use the session parser, read updates from the file,
efficiently — like the ssh/remote-browser pattern."

### 5. Scheduling — falls out of the existing daemon

Scheduled fleet dispatch needs **no new machinery**: the routines scheduler
(`src/lib/daemon.ts`) fires jobs on cron; a job whose command is `agents run …
--on <host>` is a scheduled remote dispatch. Online-gating is a `tailscale status`
check before firing. (We do **not** turn the scheduler into an RPC server — see
Non-goals.)

### 6. Tracking — reuse the cloud store (Phase 1.5)

To make `agents cloud list/status/logs` show host runs alongside cloud runs, add a
thin `host` entry to the cloud provider model that records `{host, agent, prompt,
transcriptPath, offset, status}` in the existing SQLite store
(`src/lib/cloud/store.ts`) and streams via the transcript tailer above. This makes
"fleet observability" free and unifies the dispatch surface.

## Phase 2 — session handoff (the differentiator)

`agents run --resume <session-id> --on <host>` — move a live session, *including
uncommitted work*, to another box and continue:

1. **Code**: push/sync the git branch; **`rsync` the working tree** (uncommitted
   included) over the tailnet — the thing the cloud tools can't do.
2. **Conversation**: sync the transcript. The CRDT session-sync substrate already
   exists (`src/lib/session/sync/`, the `sessions-sync` work — G-Set union over
   R2); for same-tailnet hops we can also rsync the JSONL directly.
3. **Resume**: `agents run <agent> --resume <session-id>` on the target.
4. **Relay/attach mode**: attach to a still-running remote session by tailing its
   transcript (Phase 1 §4) and sending follow-ups over SSH — the "remote-control"
   UX, built on the *existing* daemon, not a new one.

Honest hard parts (consistent across the whole field): secrets/env don't travel
(the target needs its own bundles), model/provider continuity, and concurrent-
session collisions on one branch. The doc will spell these out before Phase 2
implementation.

## Non-goals / what we explicitly will NOT build

- **No broker / relay / connection-registry / heartbeat service.** Tailscale is
  that, for free. If we ever need off-tailnet hosts, that's an explicit registry
  entry + plain SSH, still no central service.
- **No provisioning engine.** crabbox already leases across Hetzner/AWS/Azure/GCP/
  e2b/modal/… and joins them to the tailnet. `hosts` shells out to crabbox for
  lease/release and otherwise treats the box as a tailnet-SSH peer. We do not
  reimplement multi-cloud provisioning, cost, or lifecycle.
- **No new daemon.** Phase 2 relay/attach expands the existing routines daemon;
  it does not add a second long-running process.
- **No custom wire protocol.** SSH + on-disk transcript are the protocol.
- **No VM snapshots.** `rsync` over the tailnet replaces Devin-style block-diff for
  our single-tenant case.

## Design constraints carried from the incident

The Resource Report is also a list of things the remote run must NOT do (or it
just relocates the storm):

- **Headless only** — `agents run --print/--json`, never a remote interactive TTY.
  Progress is summarized state from the transcript, not a live char stream.
- **Bound concurrency** — cap simultaneous agents per host; a host's value is
  finite coordination capacity, not infinite parallelism.
- **No unbounded recursive scans** — the incident's trigger was `rg --no-ignore
  --follow` over `.agents/worktrees` + `.gocache`. Remote workspace setup must
  respect ignore boundaries and avoid scanning generated/worktree trees.
- **Don't sync junk** — a working-tree `rsync` (Phase 2) must exclude
  `node_modules`, `.gocache`, build caches, nested worktrees.

## Open questions (decide before Phase 1 build)

1. **Workspace model for Phase 1** — caller-specified `--remote-cwd` only, or port
   the rush git-worktree workspace now? (Leaning: `--remote-cwd` first, worktree as
   a fast follow.)
2. **Tailscale dependency** — hard-require a tailnet for `hosts`, or support plain
   SSH hosts from the `agents.yaml` registry as a fallback for non-tailnet boxes?
   (Leaning: Tailscale-native primary, explicit-registry fallback.)
3. **Windows targets** — `win-mini` over SSH: do remote `agents run` semantics hold
   on Windows (shims, paths)? Needs a verification pass.
4. **GPU routing** — should `--on` accept a capability selector (e.g. `--on
   gpu`) that picks an online Spark, not just a named host?
5. **Surface for tracked runs** — keep one-offs on `agents run --on` and only
   *tracked* runs in `agents cloud` (a `host` provider), or unify?
6. **crabbox integration depth** — shell out to `crabbox warmup/ssh/stop` for
   leased hosts (leaning yes), or a tighter library binding? And `--on new`
   semantics: default provider/class, auto-release on idle vs explicit `stop`.
7. **Concurrency cap** — default max simultaneous agents per host (the incident
   says "bound it"); per-host override in the `hosts:` overlay?

## Phasing & verification

- **Phase 1**: `agents hosts list/check` (tailscale-native) + `agents run --on
  <host>` (synchronous, transcript-tailed progress). Verify end-to-end against a
  real tailnet box (mac-mini): dispatch a trivial task, see live progress via the
  transcript tailer, correct exit code. Crabbox for the unit suite.
- **Phase 1.5**: leased hosts via crabbox (`--on new[:provider]` → warmup → run →
  idle-release) + a `host` provider in the cloud store → `agents cloud
  list/status/logs`.
- **Phase 2**: `--resume … --on` handoff (branch + working-tree rsync + transcript
  sync + resume) and attach/relay mode on the existing daemon.

## Key files (reuse map)

| Need | Existing code to reuse |
|---|---|
| SSH transport | `src/lib/browser/drivers/ssh.ts` (`runSSHCommand`, `shellQuote`, tunnels) |
| Headless argv per harness | `src/lib/exec.ts` (`buildExecCommand`) + `agents run` (`src/commands/exec.ts`) |
| Transcript parse → events | `src/lib/session/parse.ts` (`parseClaude`/`parseCodex`/…) |
| Incremental offset read | `src/lib/session/active.ts:200-248` |
| Per-agent transcript dirs | `src/lib/session/discover.ts:getAgentSessionDirs` |
| Cross-machine transcript sync | `src/lib/session/sync/` (CRDT G-Set / R2) |
| Scheduling | `src/lib/daemon.ts` (routines scheduler) |
| Task tracking store | `src/lib/cloud/store.ts` |
| Config schema | `src/lib/types.ts` (`Meta`) + `src/lib/state.ts` (`readMeta`) |

## Prior art studied

- rush "computers": `rush/cli/internal/computer/` (model/fingerprint),
  `rush/cli/internal/daemon/workspace.go` (warm clone + worktree + env denylist),
  `prix/api/src/computers/relay.ts` (the WebSocket relay we deliberately drop).
- Field survey + citations: see the research links inline above (Codex, Cursor,
  Devin/blockdiff, Factory, Jules, Anthropic Managed Agents, Claude Remote
  Control/Teleport, Tailscale LocalAPI/SSH/tsnet).
