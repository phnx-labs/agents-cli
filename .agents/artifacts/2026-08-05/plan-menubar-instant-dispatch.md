---
kind: plan
template: plan.v1
title: Keep the menu open and make Quick Dispatch instant
summary: |
  Replace the status menu's close-and-reopen accordion with an in-place AppKit interaction.
  Remove repository, screenshot, and ticket loading from the Cmd-Shift-O presentation path.
status: implemented
tracking: "#2051"
project: agents-cli
context: macOS menu-bar helper interaction and latency fixes
repository: phnx-labs/agents-cli
branch: fix/menubar-instant-dispatch
harness: codex
agent: root
human: Owner
host: worker-s1
session: unavailable
date: 2026-08-05
links:
  - "https://github.com/phnx-labs/agents-cli/issues/2051"
facts:
  - "workstation measured agents sessions --all --limit 40 --json at 1.21 seconds"
  - "the current project toggle closes the NSMenu and synthesizes a second status-item click"
  - "Cmd-Shift-O remains the global Quick Dispatch shortcut"
---

# Keep the menu open and make Quick Dispatch instant

`agents-cli` · Codex · worker-s1 · session unavailable · 2026-08-05

## Purpose

Two macOS interactions currently interrupt the user:

1. Selecting an ACTIVE project ends native `NSMenu` tracking. The helper then activates itself and clicks its own status item to recreate the menu.
2. `Cmd-Shift-O` waits for recent-session discovery, screenshot enumeration and decoding, and Linear cache rendering before the Quick Dispatch panel is ordered front.

The result should preserve the current inline project layout while making Quick Dispatch usable before its secondary data refreshes.

## Proposed Changes

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 920 330" role="img" aria-labelledby="flow-title flow-desc">
  <title id="flow-title">Before and after interaction flow</title>
  <desc id="flow-desc">The existing project path closes and reopens the menu, while the new path updates it in place. The existing Quick Dispatch path waits for data, while the new path paints and focuses first.</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker>
  </defs>
  <text x="20" y="28" fill="#d8d8d8" font-family="JetBrains Mono, monospace" font-size="14">CURRENT</text><rect x="15" y="40" width="890" height="105" rx="10" fill="none" stroke="#666" stroke-width="1"/>
  <rect x="35" y="70" width="145" height="48" rx="8" fill="#351515" stroke="#ef4444" stroke-width="2"/><text x="53" y="98" fill="#d8d8d8" font-family="JetBrains Mono, monospace" font-size="12">project click</text>
  <path d="M180 94H255" fill="none" stroke="#d8d8d8" stroke-width="2" marker-end="url(#arrow)"/><rect x="255" y="70" width="160" height="48" rx="8" fill="#351515" stroke="#ef4444" stroke-width="2"/><text x="276" y="98" fill="#d8d8d8" font-family="JetBrains Mono, monospace" font-size="12">menu closes</text>
  <path d="M415 94H490" fill="none" stroke="#d8d8d8" stroke-width="2" marker-end="url(#arrow)"/><rect x="490" y="70" width="180" height="48" rx="8" fill="#351515" stroke="#ef4444" stroke-width="2"/><text x="510" y="98" fill="#d8d8d8" font-family="JetBrains Mono, monospace" font-size="12">performClick(nil)</text>
  <path d="M670 94H745" fill="none" stroke="#d8d8d8" stroke-width="2" marker-end="url(#arrow)"/><rect x="745" y="70" width="140" height="48" rx="8" fill="#351515" stroke="#ef4444" stroke-width="2"/><text x="765" y="98" fill="#d8d8d8" font-family="JetBrains Mono, monospace" font-size="12">menu reopens</text>
  <text x="20" y="183" fill="#d8d8d8" font-family="JetBrains Mono, monospace" font-size="14">AFTER</text><rect x="15" y="195" width="890" height="105" rx="10" fill="none" stroke="#666" stroke-width="1"/>
  <rect x="35" y="225" width="145" height="48" rx="8" fill="#132a18" stroke="#a3e635" stroke-width="2"/><text x="53" y="253" fill="#d8d8d8" font-family="JetBrains Mono, monospace" font-size="12">project click</text>
  <path d="M180 249H315" fill="none" stroke="#d8d8d8" stroke-width="2" marker-end="url(#arrow)"/><rect x="315" y="225" width="220" height="48" rx="8" fill="#132a18" stroke="#a3e635" stroke-width="2"/><text x="339" y="253" fill="#d8d8d8" font-family="JetBrains Mono, monospace" font-size="12">update rows in place</text>
  <path d="M535 249H670" fill="none" stroke="#d8d8d8" stroke-width="2" marker-end="url(#arrow)"/><rect x="670" y="225" width="215" height="48" rx="8" fill="#132a18" stroke="#a3e635" stroke-width="2"/><text x="697" y="253" fill="#d8d8d8" font-family="JetBrains Mono, monospace" font-size="12">same menu stays open</text>
</svg>
<figcaption>Red is the dismiss-and-reopen path being removed; lime is the retained menu-tracking path.</figcaption>
</figure>

| Area | Change |
| --- | --- |
| ACTIVE accordion | Use a view-backed project row and insert/remove cached session items without selecting an actionable menu item. |
| Quick Dispatch presentation | Build static chrome early; order and focus the panel before any secondary hydration. |
| Repository choices | Derive from the background recent-session cache instead of running `sessions --all` in `summon()`. |
| Screenshots and tickets | Refresh off the AppKit main thread and publish results after first paint. |
| Obsolete workaround | Delete accordion reopen flags, synthetic status-item clicks, and temporary debug logging. |

## Public Interface

No command, configuration, or shortcut changes. `Cmd-Shift-O` remains Quick Dispatch and Factory retains `Cmd-Shift-T` for reopening the last session.

```text
Cmd-Shift-O -> MenubarHelper -> PromptPanelController.summon()
```

## Validation

- Run the helper self-tests and prescribed CLI remote suite.
- Measure hotkey-to-visible and hotkey-to-editor-ready against the real panel on workstation.
- Expand and collapse several projects while recording that the same dropdown remains continuously visible.
- Install the packaged helper, repeat both paths, attach visual proof to the PR, and repeat after release.

## Risks

- A custom menu-item view owns its drawing and accessibility. Match the existing row height, labels, highlight state, tooltips, and keyboard semantics.
- Asynchronous hydration must preserve the current repository, agents, screenshot selections, mode, and draft instead of resetting controls.
- Panel focus is load-bearing. Keep the existing first-keystroke protection unless the real timing test proves a replacement preserves immediate typing.

## Tracking

- [GitHub issue #2051](https://github.com/phnx-labs/agents-cli/issues/2051)

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> AppKit presentation and text focus complete before repository, screenshot, or ticket hydration begins.</aside>
