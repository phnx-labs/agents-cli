---
kind: report
template: report.v1
title: "Menu bar NEW DEVICES: why 20 boxes reappeared, and why Ignore looked broken"
summary: "reconcilePendingSentinels only subtracted the ignore-list, never the registered roster; a redirected-registry writer could poison the live pending-sentinel dir with already-registered fleet boxes. Fixed and merged (PR #2615); ignore-list persistence was never actually broken."
status: complete
human: "Owner"
host: "worker"
session: "[redacted]"
---

## Summary

The macOS menu bar's **NEW DEVICES (20)** section was listing ~20 tailnet
nodes as unapproved — most of them already-registered fleet machines — and
"Ignore" appeared not to stick. Both symptoms trace to **one bug**: the
daemon's pending-sentinel writer, `reconcilePendingSentinels`, filtered
incoming candidates against the ignore-list only, never against the
registered device roster. A process whose registry view was
redirected/empty (a hermetic test run) could still write to the live
sentinel directory the menu bar polls — from that process's point of view,
*every* tailnet node looked unknown, so it rewrote a "new" sentinel for
names that were already registered **and** for names the user had already
ignored, since that write path never consulted the real ignore-list either.
That is why a device the user had just dismissed could still resurface: not
because the dismissal failed to save, but because a later, unrelated write
overwrote the sentinel without checking what was already dismissed.

Separately: the CLI's actual ignore-list persistence was never broken. It
lives at `~/.agents/.history/devices/ignored.json` (confirmed present,
populated, and correctly maintained throughout) — no production code path
reads or writes any other location for it. An earlier pass of this
investigation checked a different, unrelated path
(`~/.agents/devices/<machine>/`, which exists for per-machine version pins,
not ignores) and concluded the ignore-list was missing; that was an
investigator error, not a CLI defect.

The fix is merged to `main` (PR #2615, commit `d940ddb0c`), tested, documented,
and the immediate symptom has already been remediated live on the affected
machines ahead of the next scheduled release.

## Findings

### How NEW DEVICES gets populated

<svg viewBox="0 0 900 320" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect x="20" y="20" width="220" height="70" fill="none" stroke="currentColor" stroke-width="1.5" rx="8"/>
  <text x="35" y="45" font-size="13">daemon device-probe</text>
  <text x="35" y="63" font-size="11" opacity="0.7">runs every ~3 min (daemon.ts)</text>

  <rect x="330" y="20" width="260" height="70" fill="none" stroke="currentColor" stroke-width="1.5" rx="8"/>
  <text x="345" y="45" font-size="13">reconcilePendingSentinels(pending)</text>
  <text x="345" y="63" font-size="11" opacity="0.7">devices/pending.ts</text>

  <rect x="670" y="20" width="210" height="70" fill="none" stroke="currentColor" stroke-width="1.5" rx="8"/>
  <text x="685" y="45" font-size="13">~/.agents/.cache/state/</text>
  <text x="685" y="62" font-size="13">devices-pending/*</text>

  <path d="M240,55 H330" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)" fill="none"/>
  <path d="M590,55 H670" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)" fill="none"/>

  <rect x="330" y="140" width="260" height="90" fill="none" stroke="currentColor" stroke-width="1.5" rx="8" stroke-dasharray="4,3"/>
  <text x="345" y="163" font-size="13">BEFORE FIX: filter subtracted</text>
  <text x="345" y="181" font-size="13">only the ignore-list —</text>
  <text x="345" y="199" font-size="13">never the registered roster</text>

  <rect x="670" y="140" width="210" height="90" fill="none" stroke="currentColor" stroke-width="1.5" rx="8"/>
  <text x="685" y="163" font-size="13">menu bar polls</text>
  <text x="685" y="181" font-size="13">devices-pending/ every</text>
  <text x="685" y="199" font-size="13">~10s -&gt; NEW DEVICES</text>

  <path d="M460,140 V110" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)" fill="none"/>
  <path d="M775,140 V110" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)" fill="none"/>

  <rect x="20" y="140" width="260" height="90" fill="none" stroke="currentColor" stroke-width="1.5" rx="8" stroke-dasharray="2,2" opacity="0.85"/>
  <text x="35" y="163" font-size="13">Hermetic test run</text>
  <text x="35" y="181" font-size="11" opacity="0.7">AGENTS_DEVICES_DIR redirected</text>
  <text x="35" y="199" font-size="11" opacity="0.7">(registry looks empty to it)</text>
  <text x="35" y="217" font-size="11" opacity="0.7">but still writes the LIVE</text>
  <text x="35" y="235" font-size="11" opacity="0.7">devices-pending/ dir</text>
  <path d="M150,140 V110" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)" fill="none"/>
  <path d="M280,185 H330" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)" fill="none"/>

  <text x="20" y="290" font-size="13" font-weight="600">Result: registered AND already-ignored boxes get rewritten as "new" sentinels — the ignore action itself never failed, an unrelated later write just clobbered it.</text>
</svg>

### Root cause — pending-sentinel pollution explains both symptoms

`reconcilePendingSentinels` (`apps/cli/src/lib/devices/pending.ts`) built its
"still pending" set by subtracting only the persisted ignore-list, never the
registered roster. A test/hermetic process that redirects
`AGENTS_DEVICES_DIR` (so its own registry view is empty) still writes to the
**live** `~/.agents/.cache/state/devices-pending/` directory — that path is
governed by a separate override (`AGENTS_STATE_DIR` / `getRuntimeStateDir()`)
that isn't redirected by the same env var. From that process's point of view
every tailnet node looked unregistered *and* undismissed, so it rewrote a
sentinel for all of them: already-registered fleet boxes appeared as "new,"
and — critically — a device the user had *just ignored* could also be
rewritten as "new" by this same unrelated write, since that write path never
consulted the real ignore-list at all. Nothing about the user's ignore action
failed; a later, unrelated write simply clobbered the sentinel it had cleared.

A companion daemon-level gap made this worse: on a soft-fail probe tick (no
live tailscale), the pre-fix code returned immediately without pruning
anything, so any polluted sentinels could sit for a full 3-minute interval
before the next clean tick had a chance to self-heal them.

### The ignore-list itself was never broken

`agents devices ignore <name>` (`apps/cli/src/commands/ssh.ts:1170-1177`)
correctly calls `removeDevice` -> `addIgnored` -> `clearPendingSentinel`. The
ignore-list's real path is resolved by `getDevicesDir()`
(`apps/cli/src/lib/state.ts`), which returns
`path.join(HISTORY_DIR, 'devices')` — **`~/.agents/.history/devices/`**. On
the affected machine, the real ignore-list file exists and is populated with
~10 dismissed personal/test devices, most recently updated within the hour of
this investigation — confirming persistence worked correctly the whole time.
(An earlier pass of this investigation checked
`~/.agents/devices/<machine>/`, a directory that exists for a different,
unrelated purpose — per-machine version pins — and mistook its absence there
for a missing ignore-list. No production code reads or writes the ignore-list
at that path; this was investigator error, not a CLI defect.)

### Which of the 20 were real vs. test/ephemeral

| Category | Examples | Why |
|---|---|---|
| **Real fleet device** | The CLI-managed compute fleet (Mac and Linux boxes named in this repo's own Host & Fleet vocabulary) | Present in the device registry; these are the machines the fleet actually schedules work on |
| Real, CI-only | A CI runner tailnet node | Legitimately registered, not a personal device |
| **Test / personal / ephemeral** | Personal phones, tablets, and laptops on the same tailnet | Now on the ignore-list; not fleet-managed compute |

None of the 20 were phantom or fabricated — the bug was misclassification, not
invented devices.

## Evidence

**The fix (merged):** [PR #2615](https://github.com/phnx-labs/agents-cli/pull/2615),
commit `d940ddb0c`, `fix(devices): stop NEW DEVICES listing registered/ignored boxes`.

```diff
- let ignored: Set<string>;
- try { ignored = await loadIgnored(); } catch { ignored = new Set(); }
  const want = new Map(
    pending
-     .filter((p) => isSafeName(p.name) && !ignored.has(p.name))
+     .filter((p) => isSafeName(p.name) && !dismissed.has(p.name))  // dismissed = ignored ∪ registered
      .map((p) => [p.name, p.platform]),
  );
```

- `reconcilePendingSentinels` re-subtracts **registered + ignored** names, not just ignored.
- New `pruneDismissedPendingSentinels()` runs on daemon start and on every
  soft-fail probe tick (no live tailscale required), so leftover pollution
  clears without waiting on the 3-minute interval.
- 2 new real-filesystem tests in `pending.test.ts` reproduce the
  registered-device leak and the soft-fail prune path — real `mkdtemp` HOME,
  no mocking. `bun test src/lib/devices/pending.test.ts` -> 8 pass / 0 fail.
- Docs (`apps/cli/docs/menubar.md`) and a changelog fragment
  (`apps/cli/.changelog/next/pending-devices-registry-filter.md`) updated.
- CI green on every shard (gitleaks, scope, preflight, 3 test shards, docs).
- Merged to `main` 2026-08-10T18:55:40Z.

### Before / after (live-verified, this investigation)

| Signal | Before | After |
|---|---|---|
| Pending sentinel count on the affected machine | 20 | **0** |
| Device registry entries | 30 (14 test/phantom) | **16** real devices |
| Ignore-list correctness | Correctly populated the whole time (never actually broken) | Confirmed via direct read, unaffected by the fix |

### Independent verification

Two blind subagent reviews (separate contexts, no shared conclusions, each
reasoning only from source) independently confirmed the core mechanism: the
choke point `reconcilePendingSentinels` filtered only against the ignore-list,
never the registered roster. One reviewer went further and empirically
reproduced the bug — reverted the fix in a scratch worktree, reran the new
test, and confirmed it fails exactly as predicted (`expected ['newbox', 'zion']
to deeply equal ['newbox']`) — and additionally established that no
production code path reads or writes the ignore-list at any location other
than `~/.agents/.history/devices/ignored.json`, which this report's final
draft now reflects: the ignore-list was never actually broken, and its
apparent reappearance is explained by the same pollution mechanism, not a
separate wrong-path bug.

## Recommendations

- **No further code change needed.** The fix is complete, tested, and merged.
- **Shipping:** this repo runs a release train (`release-train` routine, every
  4h) — a feature agent's job ends at merged-to-main + changelog fragment, both
  already done. The next train publishes to npm and rolls the fix to every
  reachable fleet host; no manual release was taken here.
- **Immediate relief:** the user-facing symptom (phantom NEW DEVICES) was
  already remediated live on the affected machines ahead of the release, by
  pruning the stale sentinel files directly — a safe, idempotent operation,
  since the daemon's own probe recomputes the same result once the release
  ships.
- **Tracking:** [RUSH-2551](https://linear.app) filed and closed with proof,
  linked to PR #2615 and this report.
