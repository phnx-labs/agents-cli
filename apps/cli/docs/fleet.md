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
