# RUSH-2149 — independent baseline (Claude, worker-s1)

Captured 2026-08-05/06 before Codex's persistent-client fix (session `019fd53b`,
still doing source inspection with `mq` at time of capture — no PR/branch yet).

Script: `apps/cli/scripts/bench-browser-loop.sh` (this worktree, `rush-2149-bench` branch).
n=5 per layer, median reported. All runs against a real, already-open browser task
(`agents browser start --profile <p> --task rush2149-bench`) — no cold-start cost
folded into the medians.

## worker-s1 (this host, linux, load avg ~7-9) — no browser installed

No CDP session possible here (headless box, no chrome/chromium/comet). Measured
the CLI-boot layer only, which independently confirms the ticket's diagnosis that
the fat is in **invocation**, not CDP:

| Layer | Median (n=5) | Raw (ms) |
| --- | --- | --- |
| bare `node -e ""` | 19 ms | 19,18,19,19,19 |
| `agents --version` | 97 ms | 97,92,91,108,115 |
| `agents browser status` (**no daemon running** — error path) | 245 ms | 243,244,245,247,258 |

Even with **zero CDP work and no daemon to talk to**, `browser status` still costs
~245 ms — in the same band as the ticket's 226 ms "daemon IPC, no CDP work" figure.
That's CLI boot (~97 ms) + the daemon-probe/IPC-connect path
(`apps/cli/src/lib/browser/ipc.ts:53` `probeDaemon`, `:609` `sendIPCRequest`),
independent of whether a daemon exists to answer. Confirms: the persistent-client
fix needs to eliminate the boot, not just speed up CDP dispatch.

## [worker] (macos, load avg ~3, Comet daemon live) — clean baseline, closest to ticket conditions

| Layer | Median (n=5) | Raw (ms) |
| --- | --- | --- |
| bare `node -e ""` | 42 ms | 42,42,44,43,41 |
| `agents --version` | 143 ms | 140,139,143,146,146 |
| `agents browser status` | 266 ms | 265,265,266,272,269 |
| `agents browser screenshot` | 356 ms | 355,352,360,368,356 |
| `agents browser click --at 10,10` | 368 ms | 363,368,381,358,369 |
| **screenshot + click loop (2 CLI calls)** | **730 ms** | 740,730,735,717,711 |

agents 1.22.20. Directly comparable in shape to the ticket's workstation table (bare node
39ms→42ms, `--version` 105ms→143ms, `status` 226ms→266ms) — same layer ordering,
same conclusion, slightly higher absolute numbers (older CLI build + this box's
baseline being naturally slower than workstation idle).

## workstation (macos, load avg ~112-136 — heavily loaded during this run)

| Layer | Median (n=5) | Raw (ms) |
| --- | --- | --- |
| bare `node -e ""` | 140 ms | 140,155,176,130,140 |
| `agents --version` | 985 ms | 619,809,3636,2205,985 |
| `agents browser status` | 1626 ms | 1908,2128,1626,1500,1464 |
| `agents browser screenshot` | 1320 ms | 1912,1837,1320,839,605 |
| `agents browser click --at 10,10` | 595 ms | 572,652,767,563,595 |
| **screenshot + click loop (2 CLI calls)** | **909 ms** | 938,954,909,847,834 |

workstation is under real load right now (fleet snapshot at session start: 1058% CPU,
confirmed by `uptime` load averages 112-136). Absolute numbers here are inflated
by host contention, not representative of the ticket's original "warm, idle"
measurement — kept for the record and because the after-fix run should also land
on workstation for an apples-to-apples same-host comparison, but **[worker] is the more
credible reference baseline** for the loop shape.

## Takeaways for the fix

1. Independently reproduces the ticket's core claim: `agents browser status` with
   **no CDP work and (on worker-s1) no daemon at all** still costs ~245-266 ms —
   confirms the fat is CLI boot + IPC/daemon-probe path, not the CDP op.
2. The persistent-client fix should be benchmarked on the **same host** as its
   baseline (host load swings the absolute numbers by 2-3x here); [worker]
   (idle, Comet daemon live) is the cleanest host available on this fleet right
   now for a same-host before/after.
3. Re-run `apps/cli/scripts/bench-browser-loop.sh` against Codex's branch on
   [worker] once a PR/branch exists, using the same `rush2149-bench` task.
