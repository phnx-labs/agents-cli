# Fleet profile sync (`agents apply`)

Reconcile every machine you own to one declared profile: which agents are
installed, which config scopes are synced, and whether logins propagate. One
host set up the way you like it becomes the template for the whole fleet.

`agents apply` (alias `ag apply`) is the fleet-wide counterpart to
[resource sync](02-resource-sync.md): resource sync reconciles resources within
one machine's version homes; `apply` reconciles *machines* against a profile,
over the same [SSH transport](09-ssh-transport.md) every `--host` command uses.

Source: `src/commands/apply.ts` (command + plan render),
`src/lib/fleet/{types,manifest,apply,auth-sync}.ts` (schema, reconcile engine,
credential propagation).

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
| `defaults.login` | `sync` propagates logins where the credential is portable; `skip` probes and reports but takes no login action. |

`login` accepts **`sync`** or **`skip`** only. (An interactive per-agent
`prompt` mode is intentionally not offered — it was removed rather than accepted
as a silent no-op.)

Two more additive, capture-only fields let a fresh machine reconstruct the whole
environment — both are **names only, never values**:

| Field | Meaning |
|---|---|
| `secrets.bundles` | Secrets-bundle **names** to ensure exist. Values live in the OS keychain and are never captured or pushed; `apply` surfaces missing bundles to recreate manually. |
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
agents fleet capture --from-pins  # record per-device agents from devices/<name>/agents.yaml
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
set of actions across four dimensions:

- **agents-cli** — `install-cli` if absent, `upgrade-cli` on a version mismatch.
- **agents** — `add-agent` for any profile agent not installed.
- **config** — `sync-config` for the declared `sync:` scopes.
- **login** — `push-login` where a portable credential can be propagated;
  `needs-login` where the login is desired but genuinely can't be (see below).

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

## Login propagation

`login: sync` seeds a fresh machine from an already-signed-in one — the point of
the feature. It turns "6 hosts × ~8 harnesses = ~48 OAuth flows" into a single
login on the source.

Portable credential files are captured on the source and streamed to each target
over the encrypted SSH channel (`sshExec` **stdin** — never shell-interpolated) by
an internal `--recv-auth` receiver that materializes them at `0600` and rejects
path traversal. Agents with a portable credential:

> `claude`, `codex`, `gemini`, `grok`, `kimi`, `opencode`, `droid`, `antigravity`

**Honest boundary — never faked.** macOS keychain-bound tokens (`claude`,
`antigravity`) can't be read from the ACL-locked keychain on a **macOS target**,
and a token that is keychain-bound on the **source** can't be extracted to push.
Those cases surface as a one-time **manual login** in the plan, not a fake
success. Agents with no portable credential (e.g. `cursor`), and a source that
simply isn't signed into an agent, produce no login action at all — the same on
every OS.

## Flags

| Flag | Effect |
|---|---|
| `-f, --file <path>` | Manifest carrying the `fleet:` block (default `agents.yaml`). |
| `--plan`, `--dry-run` | Show the reconcile plan and exit; change nothing. |
| `-y, --yes` | Skip the confirmation prompt. |
| `--device <name>` | Scope the apply to a single device. |
| `--only <dims>` | Limit to a comma list of `agents,config,login`. |
| `--no-login` | Do not propagate logins (equivalent to `login: skip` everywhere). |

## Security

Credential transport rides the existing SSH transport and passes bundles via real
stdin, so credentials never appear in a command line or process list. The receiver
validates paths and writes at `0600`. Consistent with the repo's rule to never
transfer auth files without authorization, the live propagation path only runs on
an explicit (non-`--plan`) `apply`.
