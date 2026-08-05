# ci-runner — the shared phnx-labs CI runner pool

One standing Hetzner box (`ci-runner-fsn1`, cpx62) is the CI runner pool for the
org. It replaced the per-repo runner on yosemite-s0 and removed the need for
per-run cloud leases for CI.

## Layout

- **4 ephemeral runners** (`runner@1-4.service`) serve `muqsitnawaz/agents`
  (labels `self-hosted,linux,x64`) — the original bootstrap, untouched.
- **2 persistent org runners** (`runner-phnx@1-2.service`) serve the phnx-labs
  org runner group `crabbox-ci` (selected repos: agents-cli, agi-cli) with
  labels `self-hosted,linux,x64,crabbox-ci,tailnet`. Created by
  `provision-phnx-runners.sh`.
- **Janitor** (`/etc/cron.d/ci-janitor` → `janitor.sh` daily): docker prune,
  stale `_work` sweep, journald vacuum, apt autoremove.
- **Supervisor** (launchd `com.phnx-labs.ci-supervise` on mac-mini, every 10
  min → `supervise.sh`): box reachability, unit states, GitHub-side runner
  status (when gh has org-admin), tailnet + win-mini probe from the box, disk,
  and the **crabbox idle-reaper** (deletes crabbox-leased servers idle > 6h —
  direct-provider crabbox has no coordinator, so nothing else reaps them).

## Security invariants

- The `crabbox-ci` label may only appear in workflows with **trusted triggers**
  (push to main / schedule / workflow_dispatch). Never on `pull_request`:
  agents-cli is public; a self-hosted runner reachable from fork PRs is
  RCE-on-our-infra.
- The org runner group `crabbox-ci` is restricted to selected repos; adding a
  repo is an org-admin action.
- The box's muqsitnawaz/agents runners are ephemeral (`--once` + re-register);
  the phnx-labs org runners are persistent (no standing GitHub credential on
  the box for the org — registration tokens are minted via `gh` and pushed over
  SSH only when (re)registering).

## Operating it

```sh
# health snapshot (from any machine with the ops key + gh)
CI_BOX_KEY=~/.ssh/ci-runner-ops bash scripts/ci-runner/supervise.sh

# box access
ssh -i ~/.ssh/ci-runner-ops root@78.46.183.46

# re-register a dead phnx runner (the supervisor does this automatically when
# gh has org rights): see supervise.sh
```

Box rebuilds are manual: lease a fresh cpx62 in fsn1, copy
`~/.ssh/ci-runner-ops.pub` into `/root/.ssh/authorized_keys`, install tailscale
+ join the tailnet, then run `provision-phnx-runners.sh` (phnx pool) — the
muqsitnawaz/agents pool comes from the original infra-ci bootstrap (see the
box's `/etc/runner.env` + `register-runner.sh`).

## Files

| File | Runs where | Purpose |
|---|---|---|
| `provision-phnx-runners.sh` | on the box (via ssh) | fresh-install + register the 2 org runners, systemd units |
| `supervise.sh` | mac-mini (launchd, 10 min) | health checks, heal ladder, crabbox idle-reaper |
| `janitor.sh` | on the box (cron, daily) | docker/_work/journal/apt hygiene |
