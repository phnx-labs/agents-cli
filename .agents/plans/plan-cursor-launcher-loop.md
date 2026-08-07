---
kind: plan
title: Repair Cursor launcher recursion
summary: Cursor itself is healthy, but agents-cli imported a mutable launcher that adoption later redirected into the agents shim. The repair stores and restores the canonical native executable so both CLI and Factory launches open Cursor's interactive TUI.
status: implementing
tracking: RUSH-2345
project: agents-cli
repository: phnx-labs/agents-cli
harness: Codex
agent: root
host: zion
session: current
date: 2026-08-06
facts:
  - The native Cursor 2026.08.04-aaa8809 executable opens a prompt-less TUI.
  - The broken managed path resolved back into the agents cursor-agent shim.
---

## Purpose

Running `agents run cursor` or launching Cursor from Factory must display Cursor's interactive prompt instead of a blank terminal.

<div class="artifact-callout"><strong>Root cause:</strong> the managed version linked to <code>~/.local/bin/cursor-agent</code>; launcher adoption later redirected that path to the agents shim, creating an execution cycle.</div>

<figure>
<svg viewBox="0 0 900 250" role="img" aria-labelledby="flow-title flow-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="flow-title">Cursor launcher repair flow</title>
  <desc id="flow-desc">Before, the managed binary and agents shim formed a cycle. After, the managed binary points directly at the native Cursor executable.</desc>
  <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#a3e635"/></marker></defs>
  <text x="25" y="30" fill="currentColor" font-size="18" font-weight="700">Before: recursive dispatch</text>
  <rect x="25" y="55" width="190" height="56" rx="8" fill="#252525" stroke="#f97316"/><text x="45" y="89" fill="#fff">managed Cursor</text>
  <rect x="270" y="55" width="190" height="56" rx="8" fill="#252525" stroke="#f97316"/><text x="290" y="89" fill="#fff">local launcher</text>
  <rect x="515" y="55" width="190" height="56" rx="8" fill="#252525" stroke="#f97316"/><text x="535" y="89" fill="#fff">agents shim</text>
  <path d="M215 83 H265 M460 83 H510 M610 115 C610 155 120 155 120 116" fill="none" stroke="#f97316" stroke-width="3" marker-end="url(#arrow)"/>
  <text x="25" y="195" fill="currentColor" font-size="18" font-weight="700">After: canonical native target</text>
  <rect x="270" y="205" width="190" height="36" rx="8" fill="#252525" stroke="#a3e635"/><text x="289" y="229" fill="#fff">managed Cursor</text>
  <rect x="560" y="205" width="250" height="36" rx="8" fill="#252525" stroke="#a3e635"/><text x="579" y="229" fill="#fff">native Cursor executable</text>
  <path d="M460 223 H555" fill="none" stroke="#a3e635" stroke-width="3" marker-end="url(#arrow)"/>
</svg>
<figcaption>Launcher identity is resolved before registration; the durable adoption record repairs existing installations.</figcaption>
</figure>

## Proposed Changes

| Area | Change | Result |
| --- | --- | --- |
| Launcher discovery | Resolve symlink targets and reject candidates inside the agents shim directory | PATH discovery returns the native executable |
| Import and migration | Store the canonical target and rerun schema migration v16 | Existing and future Cursor installs avoid the cycle |
| Generated shim | Refuse to execute a managed target that resolves to the shim | Corrupt state fails over to the recorded native executable |
| Capability registry | Mark current Cursor builds as prompt-less interactive | `agents run auto` and explicit Cursor launches match live behavior |

## Public Interface

No flags or configuration change. The repaired commands remain:

```sh
agents run cursor --interactive --strategy balanced --mode auto
```

Factory continues to call the same command through its shared launch engine.

## Validation

- Reproduce the two-hop symlink topology in migration tests and verify idempotent repair.
- Verify imports retain the native target after the mutable launcher is redirected.
- Verify generated Cursor shims contain the self-recursion guard.
- Install the development CLI and visibly open Cursor through `agents run cursor`.
- Run the scripted build, focused regression tests, CI, and an independent review.

## Risks

| Risk | Control |
| --- | --- |
| A forged adoption record points back to the shim | Canonicalize and reject targets inside the shim directory |
| Migration repeatedly rewrites correct installations | Leave native links untouched and test the second run |
| Factory gains harness-specific behavior | Make no Factory code change; repair the shared CLI boundary |

## Tracking

- [RUSH-2345](https://linear.app/getrush/issue/RUSH-2345/fix-cursor-blank-terminal-caused-by-self-referential-launcher-shim)
