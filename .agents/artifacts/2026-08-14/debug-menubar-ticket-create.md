---
kind: report
template: report.v1
title: Menubar ticket creation fails before Linear starts
summary: The macOS helper invokes a removed skill-local executable instead of the installed Linear CLI. The launch fails before authentication or an API request, and the helper discards the launch error.
project: agents-cli
context: Cmd-Shift-O quick-ticket flow on zion
repository: phnx-labs/agents-cli
branch: origin/main
tracking: RUSH-2653
status: confirmed
date: '2026-08-14'
facts:
  - zion has /opt/homebrew/bin/linear 0.16.0
  - zion does not have ~/.agents/skills/linear/scripts/linear
  - the running helper contains the obsolete skill-local path
links:
  - https://linear.app/getrush/issue/RUSH-2653/factory-app-menubar-extension-ux-and-reliability
---

## Summary

The quick-ticket agent successfully got far enough for the helper to enter its `linear create` phase. The helper then tried to execute `/Users/user/.agents/skills/linear/scripts/linear`, which does not exist on zion. The supported CLI exists at `/opt/homebrew/bin/linear`.

<div class="artifact-callout"><strong>Root cause:</strong> `linearSkillBinary()` hard-codes a retired skill path. `Process.run()` throws for the missing executable, and the callback maps every launch failure to the generic “linear create exited with an error.”</div>

<svg viewBox="0 0 920 220" role="img" aria-label="Ticket creation failure flow">
  <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#64748b"/></marker></defs>
  <g font-family="system-ui" font-size="15">
    <rect x="20" y="55" width="180" height="92" rx="14" fill="#e0f2fe" stroke="#0284c7"/><text x="110" y="88" text-anchor="middle" font-weight="700">Agent JSON draft</text><text x="110" y="116" text-anchor="middle">parsed successfully</text>
    <path d="M205 101 H300" stroke="#64748b" stroke-width="3" marker-end="url(#arrow)"/>
    <rect x="310" y="35" width="285" height="132" rx="14" fill="#fee2e2" stroke="#dc2626"/><text x="452" y="70" text-anchor="middle" font-weight="700">Hard-coded executable</text><text x="452" y="100" text-anchor="middle" font-family="monospace" font-size="12">~/.agents/skills/linear/</text><text x="452" y="120" text-anchor="middle" font-family="monospace" font-size="12">scripts/linear</text><text x="452" y="146" text-anchor="middle" fill="#b91c1c">missing on zion</text>
    <path d="M600 101 H695" stroke="#64748b" stroke-width="3" marker-end="url(#arrow)"/>
    <rect x="705" y="55" width="195" height="92" rx="14" fill="#f1f5f9" stroke="#64748b"/><text x="802" y="88" text-anchor="middle" font-weight="700">Generic notice</text><text x="802" y="116" text-anchor="middle">stderr discarded</text>
    <text x="452" y="202" text-anchor="middle" fill="#475569">The Linear CLI and API are never reached.</text>
  </g>
</svg>

## Findings

| Point | Confirmed evidence | Consequence |
| --- | --- | --- |
| Executable selection | `AgentsCLI.swift:269-270` returns `~/.agents/skills/linear/scripts/linear` | The helper ignores the installed CLI on PATH |
| Live zion state | Exact path is absent; `/opt/homebrew/bin/linear` is executable and reports `linear-cli 0.16.0` | Launch fails locally before auth/API |
| Failure mapping | `AgentsCLI.swift:778-793` reports an empty failed result when `Process.run()` throws | Underlying “file not found” is lost |
| User notification | `AgentsCLI.swift:563-568` maps `createOk == false` to the screenshot’s exact message | Notification cannot explain or recover from the failure |
| Test gap | `IssueSelfTest.swift:167-191` compares argv against `linearSkillBinary()` itself | The test blesses the obsolete path and never launches it |

## Evidence

The live checks were read-only:

```text
HOME=/Users/user
skill_binary_executable_rc=1
/opt/homebrew/bin/linear
-rwxr-xr-x ... /opt/homebrew/bin/linear
ls: /Users/user/.agents/skills/linear: No such file or directory
```

The running helper binary contains both strings:

```text
/.agents/skills/linear/scripts/linear
linear create exited with an error.
```

Current TypeScript already follows the standalone CLI contract: `apps/cli/src/lib/linear-projects.ts:121-138` invokes `linear` on PATH and tells users to install it with Homebrew and authenticate with `linear auth login`. The Swift bridge did not migrate with that contract.

## Recommendations

1. Replace `linearSkillBinary()` with GUI-safe resolution for the standalone `linear` executable, using explicit macOS locations in the same style as the existing `agents` resolver.
2. Make the process launcher return the thrown launch error and show that concrete error in the failure notification.
3. Add a Swift self-test that resolves and launches a real executable from a controlled fixture path; do not assert an argv built from the same resolver under test.
4. Exercise `Cmd-Shift-O` end to end on a packaged helper and confirm a real ticket ID is recorded before shipping.

No code was changed in this diagnosis.
