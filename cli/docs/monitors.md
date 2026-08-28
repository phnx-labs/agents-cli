# Monitors (Event-Triggered Watchers)

A **monitor** watches a SOURCE, detects a CONDITION change, and fires an ACTION.

> **A monitor is a routine whose trigger is a *watched source* instead of a *clock*.**
> `Monitor : routines :: event-triggered : time-triggered` — one daemon, one
> dispatch seam. The monitor owns only the source → condition → action layer;
> everything below it (spawning the agent, device placement, run history, the
> daemon lifecycle) is the [routines](routines.md) backbone, reused verbatim.

## The three-part model

```
   SOURCE                 CONDITION                ACTION
   (what to watch)        (did it change?)         (what to do)
 ┌───────────────┐      ┌────────────────┐      ┌──────────────────┐
 │ command       │      │ on-change      │      │ run: <agent>     │
 │ poll / http   │ ───► │ match: regex   │ ───► │ routine: <name>  │
 │ file / device │      │ every          │      │ notify: telegram │
 │ ws / webhook  │      │ + dedupe key   │      │ webhook-out: url │
 └───────────────┘      │ + state.json   │      │ ({event} → prompt)│
                        └────────────────┘      └──────────────────┘
```

## Architecture

```
~/.agents/
  monitors/
    ci-red.yml                         # Monitor config (YAML)
    cert-issued.yml
  .history/monitors/
    ci-red/
      state.json                       # last-seen value/hash + fire bookkeeping (written only on fire/baseline)
      liveness.json                    # per-poll heartbeat: lastCheckedAt, checkCount, lastError (written EVERY poll)
      fires/<id>/event.json            # fire history
```

Each monitor is a YAML file in `~/.agents/monitors/` (the user layer) or, for a
built-in shipped with the CLI, `~/.agents/.system/monitors/` (the system layer,
from `gh:phnx-labs/.agents-system`). `listMonitors()`/`readMonitor()` union the
two — the user layer shadows a system built-in of the same name, exactly like
routines' project/user/system resolution. A system built-in with no `enabled:`
field is **opt-in**: it stays disabled until you enable it, which materializes a
user copy (enable/edit/delete always write the user dir; the system mirror is
pull-only). The same background daemon that runs routines
(`agents routines start`) hosts a **monitor engine** beside the cron scheduler. On each tick it evaluates every enabled, device-owned monitor that
is due, applies the condition through the native state-diff store, and on a fire
dispatches the action through the exact `executeJobDetached` path cron and webhook
fires use.

### Built-in: `pr-merge-on-green`

Opt-in. Polls every 5 minutes for **this user's** open PRs that are CI-green and
non-author-approved, then dispatches `claude` to rebase-merge them.

The **built-in YAML** lives in `gh:phnx-labs/.agents-system` (`monitors/pr-merge-on-green.yml`)
and polls `monitors/pr-merge-on-green.sh` — `gh search prs` plus `gh pr view --repo`,
verdict via `pr-verdict.py` (the same file `merge-guard.sh` calls). Companion:
phnx-labs/.agents-system#347.

This CLI also ships a hidden helper with the **same verdict rules**
(`hasApproveVerdict` / `isCiGreen` match that python), listing registered
project slugs instead of a global search:

```bash
agents _internal mergeable-prs    # owner/repo#n, or empty
```

```bash
agents monitors enable pr-merge-on-green
agents monitors test pr-merge-on-green    # dry-run: observation + would-fire
```

A user copy created by an older `enable` still has the broken `gh pr list`
command (no `--repo`, `reviewDecision == APPROVED` only). Re-enable to pick up
the new poll: `agents monitors remove pr-merge-on-green && agents monitors enable pr-merge-on-green`.

### The one genuinely new piece: native state-diff

Routines persist per-*run* metadata but have no last-observed-*value* store.
Monitors add one (`~/.agents/.history/monitors/<name>/state.json`) — this is what
replaces the hand-rolled markdown memory files ad-hoc watchers used to need.

## Monitor Config

```yaml
# ~/.agents/monitors/ci-red.yml
name: ci-red
enabled: true
source:
  type: poll                 # command | poll | poll-http | file | device | ws | webhook
  command: gh pr checks 1119 --json name,bucket
  interval: 30s              # seconds supported (unlike routines' minute-granularity)
condition:
  mode: match                # on-change (default) | match | every
  match: fail                # required for match mode (a regex)
  dedupeKey: build (\d+)     # optional: first match is the "same event" signature
action:
  type: run                  # run | routine | notify | webhook-out
  agent: claude
  prompt: "CI failed on #1119: {event}. Diagnose and fix."
  mode: auto
device: yosemite-s0          # OWNER — the single machine that evaluates + fires (exactly-once)
rateLimit:                   # firehose guard — auto-pause if exceeded
  max: 5
  per: 1m
```

## Definition vs. running state

Two different things wear the word "monitor", and they live in different places
on purpose:

| | Path | Checked in? |
|---|---|---|
| **Definition** — what to watch, when, what to do | `~/.agents/monitors/<name>.yml` (user), `~/.agents/.system/monitors/` (built-in) | yes — it should ride the repo to every box |
| **Running state** — last-seen value, fire history, rate-limit counters | `~/.agents/.history/monitors/<name>/state.json` + `fires/<id>/` | no — it is per-machine and regenerable |

Nothing but the definition is ever written into `monitors/`: the only writers of
that directory are the monitor file's read, write, and delete. Runtime lives
under `.history/`, which is excluded, so the split needs no extra rules.

### The double-trigger guard

**A monitor's NAME is not its identity.** Two watchers polling the same source on
the same interval and firing the same action are one trigger fired twice,
whatever they are called — and `writeMonitor` overwrites by name, so nothing used
to notice. One real box accumulated `open-pr-watch`, `pr-ci-fail`, three stale
`pr2222-*` watchers and an agent-added lander, all polling the same PR queue,
added without a single warning.

The check runs **across the fleet**, not just this box — reusing the same
cross-machine fan-out `sessions --active` uses. Two agents on two machines
creating a watcher for the same work item is the case a local check cannot see.
When a peer is unreachable the command says which ones it could not consult,
rather than treating that as "no duplicate".

`agents monitors add` refuses two collisions:

- **Same name** — adding would overwrite an existing monitor.
- **Same behavior** — an existing monitor (user *or* built-in) already watches
  that source and fires that action, under any name.

Identity is a fingerprint over the source, condition, and action. Name,
description, and `enabled` are excluded — a duplicate under a new name is exactly
the case being caught, and a paused duplicate is still a duplicate. **Placement
(`device`/`devices`/`runOn`) is excluded too**: placement is who executes, not
what runs, and hashing it would let the same watcher be re-added N times by
varying only the owner.

Pass `--force` when the duplication is deliberate.

## Commands

```bash
# Create (auto-starts the daemon; then WAITS for the engine's first poll and
# reports whether it was actually picked up — config acceptance is not "running")
agents monitors add ci-red \
  --poll 'gh pr checks 1119 --json name,bucket' 30s --match fail \
  --run claude --prompt 'CI failed on #1119: {event}. Diagnose and fix.' \
  --device yosemite-s0

# The SSL watcher, reduced to config (replaces a 70-line prompt)
agents monitors add cert-issued \
  --poll-http 'https://secure.ssl.com/team/.../co-ec1l5dgjofa' 8h \
  --match issued --notify telegram --device zion

agents monitors list                  # all monitors, source, action, owner, liveness (checked Nx / never polled / STALLED / fired)
agents monitors view <name>           # full config + liveness + current watched-state + recent fires
agents monitors test <name>           # DRY-RUN: evaluate once, print event + would-fire (no action)
agents monitors edit <name>           # $EDITOR on the YAML
agents monitors logs <name>           # action run logs (run actions; reuses routines run history)
agents monitors runs <name>           # fire history
agents monitors pause / resume <name> # disable / re-enable
agents monitors device <name> --set X # (re)pin the owner device; --clear to unrestrict
agents monitors remove <name>
```

### Sources (`add` flags — exactly one)

| Flag | Source | Observation |
|---|---|---|
| `--watch '<cmd>'` | command | the command's stdout |
| `--poll '<cmd>' <interval>` | poll | stdout, re-run every interval |
| `--poll-http <url> <interval>` | poll-http | `<status>\n<body>` every interval |
| `--watch-file <path>` | file | file content (or dir listing) + mtime |
| `--watch-device <name>` | device | fleet device reachability + headroom bucket |
| `--ws <url>` | ws | each WebSocket frame (push) |
| `--on <src:event>` | webhook | a signed github/linear delivery (push) |

### Conditions (how an observation becomes a fire)

- `--on-change` (default) — fire when the observation differs from last-seen. The
  first observation establishes a **silent baseline**; a later change fires.
- `--match '<regex>'` — fire when the observation matches; de-duped so it fires
  **once** per distinct matched token (silent while the match is unchanged).
- `--every` — fire on every observation (no dedupe). Rate-limit this.
- `--dedupe-key '<regex>'` — the first match is the "same event" signature
  (default: the full observation).

### Actions (exactly one; the event is injected as `{event}`)

- `--run <agent> --prompt '…'` — spawn an agent (shares `--mode`/`--effort`/
  `--action-timeout` with routines), dispatched through `executeJobDetached`.
  Takes a native harness id or a custom harness name (`agents harness list`);
  a custom harness is delegated to `agents run <name>` and pins its own host
  version and auth. The sandboxed child inherits this host's GitHub CLI auth
  (`GH_CONFIG_DIR` / `~/.config/gh`) the same way interactive `agents run`
  does — a `--run` that shells out to `gh` is not a hollow success when the
  daemon user is already logged in (RUSH-2860; see [routines.md §Sandbox
  Isolation](routines.md#sandbox-isolation)).
- `--routine <name>` — fire an existing routine (attach a monitor to a routine).
- `--notify [channel]` — notify the owner through the one channel seam
  (`lookupTransport` → provider). The recipient and normal channel come from
  `humans.yaml`; `[channel]` overrides that channel for this dispatch.
  A channel with no registered provider fails that one dispatch (`ok: false`, the
  reason logged) and leaves the daemon evaluating every other monitor — the daemon
  never exits on a bad channel name.
- `--webhook-out <url>` — POST the event JSON.

### Placement (pin-to-one)

- `--device <name>` — the **OWNER**: the single machine whose daemon evaluates the
  source and fires. This is the exactly-once guarantee for v1 (no distributed
  lock). If the owner is down, the monitor is down. A device/fleet is itself a
  valid watch source (`--watch-device`).
- `--devices <list>` — allowlist (advanced): each listed device fires
  independently, like routines' `devices`.
- `--run-on <host>` — execute the ACTION on a different machine over SSH, distinct
  from the owner that fires it. With no owner pin, it pins the owner to this
  machine to avoid duplicate fires across the fleet.
- `--cwd <path>` — working directory for a `--run` action, home-relative or
  `~/…`. Defaults to the execution target's home, which stays portable across a
  `--run-on` hop. A monitor owns no project, so without this the run would be
  blocked at readiness with `execution_context_missing` (RUSH-2681).

## The `test` dry-run (the DX centerpiece)

`agents monitors test <name>` evaluates the source **once** and prints the emitted
event plus the would-fire decision — **without acting and without writing state**:

```
Dry-run: ci-red

  poll: gh pr checks 1119 --json name,bucket @30s  ·  [match]  ·  run claude

Observation
  ... name ... bucket=fail ...
  meta: {"exitCode":0}

Would fire: yes

Emitted event
  summary: fail
  → would run claude

(dry run — no action taken, no state written)
```

## Liveness & health (is it actually polling?)

A monitor can be enabled, owned by this box, and listed as `on` while the engine
never touches it — and until it fires nothing on disk proved otherwise, because
change-detection `state.json` is written **only** on a fire or a baseline. A
`--match` monitor that polled steadily but matched nothing therefore showed
`state: null`, indistinguishable from a monitor the engine never ran (RUSH-2485).

The engine now writes a **liveness heartbeat** (`liveness.json`) on **every**
poll — fire or not, match or not — so "never checked" is visibly distinct from
"checked N times, not matching":

```
agents monitors list
  ci-red      on  poll: gh pr checks 1119 … @30s
                  [match] → run claude   owner: yosemite-s0   checked 42x · last 12 sec ago · no match yet
  cert-issued on  poll-http: … @8h
                  [match] → notify       owner: zion          never polled          <- yellow: engine hasn't touched it
  stale-one   on  poll: … @60s
                  [on-change] → notify   owner: yosemite-s0   STALLED — last poll 2 hours ago   <- red
```

- **`never polled`** (yellow) — the engine has no heartbeat for it. If it persists
  after a few seconds, the daemon didn't pick it up: `agents routines status`.
- **`checked Nx · last <ago> · no match yet`** — alive and polling, condition just
  hasn't matched. This is the state that used to look dead.
- **`STALLED — last poll <ago>`** (red) — an enabled, locally-owned monitor whose
  last poll is more than three intervals behind. The engine has stopped checking it
  (dead engine, wedged source) even though it's still marked `on`.
- **`checked Nx · error: <msg>`** (red) — the source is erroring every poll.

`agents monitors view <name>` shows the same under a **Liveness** block
(`last checked`, `checks`, `last error`), and both commands expose it in `--json`
as `lastCheckedAt`, `checkCount`, `lastError`, `consecutiveErrors`, and `stalled`.

**Drought escalation.** After **5 consecutive failed checks** — a source that
errors every poll, or an action that fails every fire — the engine notifies the
owner **once** that the monitor is doing nothing (the streak clears, and can
escalate again, on the first good check).

## Fleet / device semantics (pin-to-one, v1)

- `--device <name>` = the owner. Only that machine's daemon evaluates and fires.
  Everywhere else the monitor is inert (`monitorRunsOnThisDevice` returns false).
- `~/.agents/monitors/` rides the user repo, so a monitor syncs to every machine;
  the owner pin is what makes it fire exactly once.
- **Remote management** (`--device <device>` on a monitors subcommand, like routines)
  is a follow-up: the top-level `--device` flag names the OWNER here, which
  collides with the `--device` routing flag, so monitors
  interpret `--device` locally rather than routing.
- **The owner pin is the ONLY ownership gate a monitor action passes.** A `run`
  action synthesizes a one-off job and hands it to the routines dispatch seam
  (`executeJobDetached`), which normally also checks the per-device ROUTINES
  activation manifest (`~/.agents/devices/<machine>/agents.yaml` → `routines:`).
  A monitor is not a routine and can never be a member of that list, so the
  synthesized job carries `dispatchedBy: 'monitor'` and `jobRunsOnThisDevice`
  (lib/routines.ts) skips the manifest for it — without that marker every monitor
  action was refused as `wrong_owner` with an empty allowlist and never ran
  (RUSH-2681). A `routine` action fires a REAL routine, which keeps its
  activation gate: a routine defined but not activated on this device is still
  refused. Monitor names are never written into the routines manifest.

## Hygiene

- **Rate-limit / firehose guard** — `rateLimit: { max, per }` auto-pauses a monitor
  that fires more than `max` times per `per`.
- **Notify-on-change discipline** — `on-change` is the default; silent on no-change.
- **Coverage lint** on `add` — warns when a `--match` names only a success token
  (e.g. `issued`), since "silence is not success" if the source breaks.

## v1 scope

The engine evaluates the **poll model**: `command`, `poll`, `poll-http`, `file`,
and `device` sources. Push sources (`ws`, `webhook`) are accepted and validated but
deliver through a persistent subscription / the webhook receiver, wired in a
follow-up. Distributed single-owner lease + failover (true HA across `--devices`)
and monitor→monitor chaining are also out of scope for v1.

## Key Functions

| Function | File | Purpose |
|---|---|---|
| `validateMonitor()` | lib/monitors/config.ts | Hand-rolled config validation |
| `writeMonitor()` / `readMonitor()` | lib/monitors/config.ts | Persist monitor config |
| `monitorRunsOnThisDevice()` | lib/monitors/config.ts | Owner-device eligibility gate |
| `hasChanged()` / `writeState()` | lib/monitors/state.ts | Native state-diff store (fire/baseline only) |
| `recordCheck()` / `readLiveness()` | lib/monitors/state.ts | Per-poll liveness heartbeat (every poll) |
| `MonitorEngine.runMonitor()` | lib/monitors/engine.ts | One poll: evaluate → decide → fire → record heartbeat |
| `shouldEscalateDrought()` | lib/monitors/engine.ts | Drought predicate: notify owner after N failed checks |
| `evaluateSource()` | lib/monitors/sources/index.ts | Source-type → evaluator |
| `decideFire()` | lib/monitors/engine.ts | Apply the condition to an observation |
| `dispatchAction()` | lib/monitors/dispatch.ts | Fire the action via executeJobDetached / notify / POST |
| `MonitorEngine` | lib/monitors/engine.ts | The tick/evaluate loop inside the daemon |
