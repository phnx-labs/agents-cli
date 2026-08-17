# Fleet profile sync (`agents apply`)

Reconcile every machine you own to one declared profile: which agents are
installed, which config scopes are synced, and which boxes still need local
authentication. Native logins are never copied.

`agents apply` (alias `ag apply`) is the fleet-wide counterpart to
[resource sync](resource-sync.md): resource sync reconciles resources within
one machine's version homes; `apply` reconciles *machines* against a profile,
over the same [SSH transport](ssh-transport.md) every `--device` command uses.

Source: `src/commands/apply.ts` (command + plan render),
`src/lib/fleet/{types,manifest,apply,auth-sync}.ts` (schema, reconcile engine,
login readiness inventory).

## The `fleet:` block

The profile is an additive `fleet:` block in `agents.yaml` (or any file passed
with `-f`). It never affects the existing `agents:` version pins — those stay
project-local.

```yaml
fleet:
  devices: all                # 'all' online registered devices (minus this one),
                              # or an explicit map of device-name -> override
  defaults:
    agents: [claude@latest, codex@latest, gemini@latest]
    sync: [user]              # config scopes to reconcile on each device
    login: sync               # 'sync' | 'skip'
  # Per-device overrides inherit from defaults; any omitted field falls through.
  # devices:
  #   yosemite-s0: { agents: [claude@latest], login: skip }
```

| Field | Meaning |
|---|---|
| `devices` | `all` — every online, registered device except the source machine — or a map of `device-name: {override}`. |
| `defaults.agents` | Agent specs to ensure installed, e.g. `claude@latest`. Missing agents are installed; version drift is left to the pins. |
| `defaults.sync` | Config sync scopes to reconcile on each device (e.g. `user`). |
| `defaults.login` | `sync` reports missing device-local login/account readiness; `skip` omits that dimension. Neither copies native OAuth. |

`login` accepts **`sync`** or **`skip`** only. (An interactive per-agent
`prompt` mode is intentionally not offered — it was removed rather than accepted
as a silent no-op.)

Two more additive, capture-only fields let a fresh machine reconstruct the whole
environment — both are **names only, never values**:

| Field | Meaning |
|---|---|
| `secrets.bundles` | Secrets-bundle **names** to ensure exist. By default `apply` only *surfaces* them to recreate manually; `--provision-secrets` pushes them (see below). |
| `routines` | Routine **names** that should be active on the fleet (the routine files themselves sync via the repo). |

> Browser profiles are **not** captured into `fleet:` — the central `browser:`
> block already syncs verbatim via `agents repo push/pull`, and its `ssh://`
> endpoints can carry `user@host`, which must never be copied into a second
> location.

## Capturing the profile (`agents fleet capture`)

Hand-authoring `fleet:` is optional — `agents fleet capture` (alias of
`agents devices capture`) snapshots the live environment into it:

```
agents fleet capture              # write agents.yaml → fleet:
agents fleet capture --dry-run    # print the block, write nothing
agents fleet capture --from-pins  # also record THIS machine's pinned agents (pins are machine-local, never synced)
```

It records device **names** (the roster), the source machine's own agents as
`defaults`, secrets-bundle **names**, and routine **names** — and writes them to
the central, portable `fleet:` block via `updateMeta`. It never touches the
per-device `agents:` pins, and never writes an IP or username. Source:
`src/commands/fleet-capture.ts`, `src/lib/fleet/capture.ts`.

**Fresh-machine bootstrap.** The roster (`~/.agents/.history/devices/registry.json`)
is machine-local and gitignored — so a freshly-cloned `agents.yaml` names devices
this machine has never registered. `agents apply` handles that: for any device in
an explicit `devices:` map that isn't in the local registry, it resolves the name
**live from Tailscale** (`ensureDevicesRegistered`, `src/lib/devices/sync.ts`) and
registers it before reconciling. So `git clone` + `agents apply` reconstructs the
fleet with zero committed connection details. Names not on the tailnet are
reported as unresolved rather than aborting the run.

## What a reconcile does

For each targeted, reachable device `apply` probes state, then plans the minimal
set of actions across five dimensions:

- **agents-cli** — `install-cli` if absent, `upgrade-cli` on a version mismatch.
- **agents** — `add-agent` for any profile agent not installed. A bare/`@latest`
  spec diffs at agent granularity (install once, latest wins); a **version-pinned**
  spec (`claude@2.1.207`) diffs per version — it installs when that exact version
  is absent, even if some other claude is already there. Version-pinned specs
  trigger a per-device `agents view --json` probe to read the installed version set.
- **config** — `sync-config` for the declared `sync:` scopes.
- **login** — always `needs-login` when a login is desired. A native OAuth /
  session login is never copied between devices (SING-1b, RUSH-2527), so `apply`
  does not propagate one: log in on the
  box itself, or sync a portable provider account (`agents accounts sync`).
- **secrets** — `push-secret` for a declared bundle when `--provision-secrets` is
  set and the gates below pass; `needs-secret` (a manual reminder) otherwise. Runs
  **last**, because it is the most sensitive mutation `apply` performs: every
  lower-risk step is already recorded before credential values move.

An unreachable device yields no actions. The whole run is idempotent — a device
already matching the profile plans nothing.

## The plan matrix

`--plan` (or `--dry-run`) renders a device × dimension matrix and exits without
changing anything:

```
Fleet profile · 10 device(s) · 3 agent(s) (claude, codex, gemini)
  device        agents-cli  agents              config    login
  yosemite-s0   ok 1.20.65  ok 3/3              ↑ sync    2 push · 1 manual
  win-mini      + install   + 3                 ↑ sync    0 push · 3 manual
  ...
```

Run without `--plan` to execute; `apply` confirms first, and `-y/--yes` skips
the prompt.

## Provisioning secrets (`--provision-secrets`)

`apply` can push the bundles `secrets.bundles` declares to each device. It is
**off by default** and it is a **flag, not a manifest field** — `agents.yaml` is
shared, so a file-level default would mean someone else's `apply -y` silently
ships credential values. That is the same shape of accident as RUSH-1968, where
the absence of any supported provisioning path led an operator to hand-export the
file store's master key across the fleet instead.

Three gates, in order. Every refusal still prints a `needs-secret` reminder, so a
skipped device is never silent:

| Gate | Refusal |
|---|---|
| `--provision-secrets` set? | reminder naming the flag |
| Device reachable? | ordinary manual reminder |
| Host key **pinned**? | `host key not pinned; run \`agents ssh <device>\` once to pin it` |

Credential values only move to a host whose key is already pinned. Enroll it
first with a non-secret `agents ssh <device>` connection.

**Backend follows the platform, and this is the load-bearing default:** `file` on
Linux, `keychain` on macOS/Windows. A headless Linux box has no keychain, and its
file store **auto-provisions its own machine-local key** — so each device ends up
with an unshared at-rest key and **no passphrase is forwarded**. That is the
direct alternative to a fleet-wide shared secret.

**Idempotence.** With provisioning on, `apply` runs one extra
`agents secrets list --json` per device (**metadata only** — names and timestamps,
never values) and skips a bundle the device already has. Without it every run
re-resolves the bundle locally, and a resolve can prompt for Touch ID, so a
converged fleet would nag on every apply. Known limitation, stated plainly: this
compares **presence**, not content — a bundle whose values changed locally still
reads as present. Use `--force` to re-push regardless.

## Login and account readiness

`login: sync` is now an inventory intent: `apply` reports `needs-login` for each
device that lacks a requested native login, but it never reads or copies a native
OAuth/session file. Fleet apply has no native-auth materialization receiver.
Complete an interactive login on that device, or create
a portable provider account and copy it explicitly with
`agents accounts sync <account> --device <device>`.

The custody decision is centralized in `src/lib/fleet/auth-sync.ts`:
`isCredentialSafeToPropagate` returns false for every native harness login.

## Flags

| Flag | Effect |
|---|---|
| `-f, --file <path>` | Manifest carrying the `fleet:` block (default `agents.yaml`). |
| `--plan`, `--dry-run` | Show the reconcile plan and exit; change nothing. |
| `-y, --yes` | Skip the confirmation prompt. |
| `--device <name>` | Scope the apply to a single device. |
| `--agent <specs...>` | Override the roster for the targeted device(s) — install exactly these specs instead of the manifest's. Pairs with `--device` to seed one box. See [§Replicating this machine's version set](#replicating-this-machines-version-set). |
| `--only <dims>` | Limit to a comma list of `agents,config,login`. |
| `--no-login` | Deprecated no-op; native logins are always device-local. |
| `--provision-secrets` | Push the declared `secrets.bundles` to each device. OFF by default; only to a device whose host key is pinned. See [§Provisioning secrets](#provisioning-secrets---provision-secrets). |
| `--force` | With `--provision-secrets`: re-push a bundle the device already has. |

## Replicating this machine's version set

The manifest roster is agent-granular — a fresh box gets one `claude@latest`. When
you keep **several claude versions** installed (e.g. one per Max account, to spread
rate-limit quota), clone that exact set onto another device with `--agent`:

```
# Install every claude version on THIS machine onto yosemite-s0
agents apply --agent claude@all --device yosemite-s0 -y

# A specific pinned version
agents apply --agent claude@2.1.207 --device yosemite-s0
```

`claude@all` expands **source-side** to one pinned spec per version installed here
(`claude@2.1.170`, `claude@2.1.207`, …); `apply` then installs each missing version
on the target and skips ones already present. `--agent` overrides the roster only
for the run — it doesn't rewrite `agents.yaml`. Config sync and login readiness
still run per the manifest. Without `--device`, the override
applies to every targeted device.

## Security

Provider-bundle transport rides SSH stdin, never argv, disables multiplexing, and
requires an already-pinned host key. Native OAuth/session files have no receiver
or materialization path in `apply`.
