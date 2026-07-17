# Monitors (Event-Triggered Watchers)

A **monitor** watches a SOURCE, detects a CONDITION change, and fires an ACTION.

> **A monitor is a routine whose trigger is a *watched source* instead of a *clock*.**
> `Monitor : routines :: event-triggered : time-triggered` — one daemon, one
> dispatch seam. The monitor owns only the source → condition → action layer;
> everything below it (spawning the agent, device placement, run history, the
> daemon lifecycle) is the [routines](03-routines.md) backbone, reused verbatim.

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
      state.json                       # last-seen value/hash + fire bookkeeping
      fires/<id>/event.json            # fire history
```

Each monitor is a YAML file in `~/.agents/monitors/`. The same background daemon
that runs routines (`agents routines start`) hosts a **monitor engine** beside the
cron scheduler. On each tick it evaluates every enabled, device-owned monitor that
is due, applies the condition through the native state-diff store, and on a fire
dispatches the action through the exact `executeJobDetached` path cron and webhook
fires use.

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

## Commands

```bash
# Create (auto-starts the daemon, like routines)
agents monitors add ci-red \
  --poll 'gh pr checks 1119 --json name,bucket' 30s --match fail \
  --run claude --prompt 'CI failed on #1119: {event}. Diagnose and fix.' \
  --device yosemite-s0

# The SSL watcher, reduced to config (replaces a 70-line prompt)
agents monitors add cert-issued \
  --poll-http 'https://secure.ssl.com/team/.../co-ec1l5dgjofa' 8h \
  --match issued --notify telegram --device zion

agents monitors list                  # all monitors, source, action, owner, last fire
agents monitors view <name>           # full config + current watched-state + recent fires
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
- `--routine <name>` — fire an existing routine (attach a monitor to a routine).
- `--notify [channel]` — send via the openclaw Telegram path (default: telegram).
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

## Fleet / device semantics (pin-to-one, v1)

- `--device <name>` = the owner. Only that machine's daemon evaluates and fires.
  Everywhere else the monitor is inert (`monitorRunsOnThisDevice` returns false).
- `~/.agents/monitors/` rides the user repo, so a monitor syncs to every machine;
  the owner pin is what makes it fire exactly once.
- **Remote management** (`--host <device>` on a monitors subcommand, like routines)
  is a follow-up: the top-level `--device` flag names the OWNER here, which
  collides with the shared `--host`/`--device` routing alias, so monitors
  interpret `--device` locally rather than routing.

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
| `hasChanged()` / `writeState()` | lib/monitors/state.ts | Native state-diff store |
| `evaluateSource()` | lib/monitors/sources/index.ts | Source-type → evaluator |
| `decideFire()` | lib/monitors/engine.ts | Apply the condition to an observation |
| `dispatchAction()` | lib/monitors/dispatch.ts | Fire the action via executeJobDetached / notify / POST |
| `MonitorEngine` | lib/monitors/engine.ts | The tick/evaluate loop inside the daemon |
