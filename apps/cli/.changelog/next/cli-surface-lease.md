- **Lease command surface: reuse picker, devices section, step UI, and Tailscale net-mode (RUSH-1922/1923/1924).**
  Wires the command layer onto the merged crabbox-core lib:
  - **Reuse (F3).** On an interactive `agents run … --lease`, a picker lists your
    warm boxes (`ready` + unexpired, most-recently-touched first) and offers
    "Provision a fresh box" / "Always provision fresh (remember for this repo)".
    New flags: `--reuse` (scriptable — auto-pick the freshest warm box, else
    fresh) and `--bare` (skip copying your local `~/.agents` setup onto the box,
    i.e. `copySetup=false`). Headless / `--json` never blocks — it provisions
    fresh unless `--reuse`/`--box` is given. New subcommands `agents lease list`
    (`--json`) and `agents lease stop <slug>`.
  - **Step UI (F2).** The box-side setup now renders as a live checklist —
    each `___PHASE_<name>___` step from the lib's `onStep` stream prints via
    `renderStepLine` (✔ Step — detail (elapsed)). Non-TTY prints one line per
    step; `--json` emits `{phase:"setup",name,elapsedMs}` events. Host-side
    warmup/ready/teardown phases are unchanged.
  - **Devices (F4).** `agents devices` gains a live "Leased boxes (ephemeral ·
    via crabbox)" section computed from `crabboxList()` — never written into the
    device registry. `agents ssh <slug>` now resolves a leased-box slug and
    connects to `crabbox@<tailnet-or-ip>:2222`.
  - **Net-mode (F5).** New `--tailscale` / `--no-tailscale` on `agents run`.
    `netMode = (--tailscale || reuse-context) && !--no-tailscale` (a solo
    one-shot `--lease` stays public) is threaded into the lease so the lib leases
    onto the tailnet. `agents lease setup` now also captures a Tailscale auth key
    (EPHEMERAL, pre-authorized, `tag:crabbox`) into the `tailscale.com` secrets
    bundle as `CRABBOX_TAILSCALE_AUTH_KEY`; when Tailscale is requested with no
    key configured the run falls back to a public lease with an actionable hint.
    The final "box ready/kept" line surfaces the box's tailnet FQDN/IP.

  Source: `apps/cli/src/commands/exec.ts`, `apps/cli/src/commands/lease.ts`,
  `apps/cli/src/commands/ssh.ts` (+ `*.test.ts`).
