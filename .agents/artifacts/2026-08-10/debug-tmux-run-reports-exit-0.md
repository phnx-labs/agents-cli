---
kind: report
title: An interactive run killed mid-work reported exit 0
surface: cli
---

# An interactive run killed mid-work reported exit 0

**A remote interactive `agents run` died at an approval prompt and the CLI reported success.** The tmux server hosting the run went away; `runInTmux` could no longer read the agent pane, and every path where tmux cannot report a status fell back to `exitCode: 0`. The failure banner printed `exit 1` while the caller received `0`.

## Summary

### Focus for review

- The fix changes an **exit code** on a path that previously always returned `0`. Anything scripting `agents run` in a tmux-wrapped interactive context will now see `1` where it saw `0` — for runs whose outcome was genuinely unknown.
- A clean `Ctrl-b d` detach still exits `0`. That is the one case with positive proof the pane is alive.
- Two of the three symptoms in the original report are **environmental, not code** — named below so they are not silently folded into "fixed".

### Intent vs observed

| | |
|---|---|
| **Intended** | Run codex interactively on a worker box: `agents run codex --interactive --device <worker>`. |
| **Observed** | The agent stalled at an approval prompt, the terminal printed `[server exited unexpectedly]` / `[detached (from session …)]`, and the CLI printed `agents: codex exited (exit 0).` |
| **Delta** | A run that was killed mid-work — the agent never answered the approval it was blocked on — was reported to the caller as a **successful** run. |

## Findings

### Root cause

`runInTmux` recovers the wrapped agent's exit code by asking tmux for the pane's `#{pane_dead} #{pane_dead_status}` after the attach client returns. `paneExitStatus` collapses two very different answers into one value:

```ts
// apps/cli/src/lib/tmux/session.ts:441-455
export async function paneExitStatus(pane: string, socket?: string): Promise<PaneExit> {
  let res;
  try {
    res = await runTmux({ socket, args: ['display-message', '-pt', pane, '-p', '#{pane_dead} #{pane_dead_status}'], throwOnError: false });
  } catch {
    return { found: false, dead: false };   // tmux never answered
  }
  if (res.code !== 0) return { found: false, dead: false };   // ...same value
  ...
}
```

`{ dead: false }` therefore means *either* "the pane is alive" *or* "tmux could not tell us". The three return paths in `runInTmux` then treated the second as success:

```ts
// apps/cli/src/lib/exec.ts (before)
return { exitCode: before.status ?? 0, stderr: '', stdout: '' };   // :1779  dead pane, no status
return { exitCode: after.status  ?? 0, stderr: '', stdout: '' };   // :1805  dead pane, no status
return { exitCode: 0,                  stderr: '', stdout: '' };   // :1816  pane unreadable
```

The banner printed immediately above those returns already used the opposite default:

```ts
// apps/cli/src/lib/exec.ts:1758
process.stderr.write(`\nagents: ${headline} (exit ${status ?? 1}).\n`);
```

So in exactly the unknown case the message said `exit 1` and the function returned `0`.

<figure>
<svg viewBox="0 0 860 300" role="img" aria-label="Flow from tmux server loss to a fabricated exit code zero" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#7b8794"/>
    </marker>
  </defs>
  <rect x="8" y="20" width="180" height="62" rx="8" fill="none" stroke="#7b8794" stroke-width="1.5"/>
  <text x="98" y="45" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="currentColor">agent blocked at</text>
  <text x="98" y="63" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="currentColor">approval prompt</text>

  <line x1="192" y1="51" x2="242" y2="51" stroke="#7b8794" stroke-width="1.5" marker-end="url(#ar)"/>

  <rect x="246" y="20" width="196" height="62" rx="8" fill="none" stroke="#d97706" stroke-width="1.5"/>
  <text x="344" y="45" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="currentColor">tmux server goes</text>
  <text x="344" y="63" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="currentColor">away under the run</text>

  <line x1="446" y1="51" x2="496" y2="51" stroke="#7b8794" stroke-width="1.5" marker-end="url(#ar)"/>

  <rect x="500" y="20" width="240" height="62" rx="8" fill="none" stroke="#7b8794" stroke-width="1.5"/>
  <text x="620" y="45" text-anchor="middle" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">paneExitStatus() -&gt;</text>
  <text x="620" y="63" text-anchor="middle" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">{found:false, dead:false}</text>

  <line x1="620" y1="86" x2="620" y2="124" stroke="#7b8794" stroke-width="1.5" marker-end="url(#ar)"/>

  <rect x="440" y="128" width="360" height="60" rx="8" fill="none" stroke="#7b8794" stroke-width="1.5" stroke-dasharray="4 3"/>
  <text x="620" y="152" text-anchor="middle" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">"pane alive" and "tmux did not answer"</text>
  <text x="620" y="170" text-anchor="middle" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">are the same value</text>

  <line x1="440" y1="158" x2="330" y2="158" stroke="#7b8794" stroke-width="1.5" marker-end="url(#ar)"/>

  <rect x="90" y="128" width="236" height="60" rx="8" fill="none" stroke="#dc2626" stroke-width="2"/>
  <text x="208" y="152" text-anchor="middle" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">BEFORE: status ?? 0</text>
  <text x="208" y="171" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="#dc2626">exit 0 (fabricated)</text>

  <line x1="208" y1="192" x2="208" y2="228" stroke="#7b8794" stroke-width="1.5" marker-end="url(#ar)"/>
  <rect x="60" y="232" width="296" height="52" rx="8" fill="none" stroke="#16a34a" stroke-width="2"/>
  <text x="208" y="255" text-anchor="middle" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">AFTER: tmuxRunExitCode(pane, alive)</text>
  <text x="208" y="273" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="#16a34a">exit 1 + "outcome unknown" banner</text>

  <rect x="440" y="232" width="360" height="52" rx="8" fill="none" stroke="#16a34a" stroke-width="1.5"/>
  <text x="620" y="255" text-anchor="middle" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">exit 0 reserved for: confirmed-alive pane</text>
  <text x="620" y="273" text-anchor="middle" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">(clean detach), or a status tmux really read</text>
</svg>
<figcaption>The unknown outcome and the clean detach shared one return value, so the unknown one inherited success.</figcaption>
</figure>

### The spec gap that let it through

`EXEC-23a (F3)` already covers this exact branch — but only its *session-teardown* consequence:

> An ambiguous result MUST `killSession` rather than keep the orphan.

It says nothing about the exit code, so nothing contradicted `?? 0`. Meanwhile the exit-code contract table in the same document already set the house rule for the analogous case:

| Path | Exit code |
|---|---|
| `--host`, followed to completion | the remote's own exit code, **or 1 if unknown** |

The fix adds **EXEC-23b** so the tmux path states the same rule, plus `GWT-E9` as its scenario.

### The fix

One pure decision, used by all three return paths, so the banner and the returned code cannot diverge again:

```ts
export function tmuxRunExitCode(pane: { dead: boolean; status?: number }, knownAlive: boolean): number {
  if (knownAlive) return 0;                                    // clean Ctrl-b d detach
  if (pane.dead && pane.status !== undefined) return pane.status;  // tmux really read a status
  return UNKNOWN_OUTCOME_EXIT_CODE;                            // 1 — outcome unknown
}
```

The unreadable-pane path also gains an explicit stderr banner naming what happened, instead of exiting mutely.

## Evidence

### Verification

Tests drive real tmux — a server is torn down under a live pane, and `paneExitStatus` is then genuinely unable to answer.

| Check | Result |
|---|---|
| `tmuxRunExitCode` suite against the OLD constant (`= 0`) | 2 failed — the regression is reproduced |
| `tmuxRunExitCode` suite with the fix | 5 passed |
| Real-tmux "server went away" test | 1 passed |
| `tsc --noEmit` | clean |

Four unrelated failures (`buildExecEnv` mailbox/autoupdater, two `orphan-reap` helper tests) reproduce identically on `main` at the same commit — pre-existing, not touched by this change.

### Named as environmental, NOT fixed here

Two symptoms in the original report are not code defects, and folding them into "fixed" would be wrong:

- **`ssh: Could not resolve hostname … Temporary failure in name resolution`** — DNS on the worker box is **intermittent** under the fleet's own SSH churn. Measured from inside the harness sandbox: one run failed to resolve both an internal name and `github.com`; a second, minutes later, resolved `github.com` to a real address through the same systemd-resolved stub. Transient resolver failure, not a sandbox network block.
- **`codex has no 'auto' mode; using 'edit'`** — expected, and printed by the CLI. It does mean an unattended interactive codex run will sit on approval prompts nobody answers.

**Not established:** *why* the tmux server went away. A shared tmux server was proven to survive its creating SSH session teardown (probe: session created, connection closed, server still serving 8s later), and the daemon's dead-pane reaper had not logged since hours before the incident. Whatever killed it, the exit-code defect above is what turned it into a silent success — and that is what this change fixes.
