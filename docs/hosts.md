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
to *your* boxes.

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
- **No new daemon.** Phase 2 relay/attach expands the existing routines daemon;
  it does not add a second long-running process.
- **No custom wire protocol.** SSH + on-disk transcript are the protocol.
- **No VM snapshots.** `rsync` over the tailnet replaces Devin-style block-diff for
  our single-tenant case.

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

## Phasing & verification

- **Phase 1**: `agents hosts list/check` (tailscale-native) + `agents run --on
  <host>` (synchronous, transcript-tailed progress). Verify end-to-end against a
  real tailnet box (mac-mini): dispatch a trivial task, see live progress via the
  transcript tailer, correct exit code. Crabbox for the unit suite.
- **Phase 1.5**: `host` provider in the cloud store → `agents cloud list/status/logs`.
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
