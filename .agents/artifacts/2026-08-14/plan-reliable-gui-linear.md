---
kind: plan
surface: native
title: Make GUI Linear ticket creation use the supported CLI
summary: MenubarHelper and AGI EXT still invoke a retired skill-local Linear executable. Resolve the standalone CLI deterministically, fail before agent work when it is absent, and preserve the real process error.
status: implementing
tracking: RUSH-2657
facts:
  - zion has /opt/homebrew/bin/linear and no ~/.agents/skills/linear/scripts/linear
  - Cmd-Shift-O currently discards the Process.run launch error
  - AGI EXT Foreman has the same obsolete executable path
---

## Focus for review

- Prefer the official `~/.local/bin/linear` installation, then Apple Silicon and Intel Homebrew locations.
- Do not restore the retired skill path or add a compatibility shim.
- Stop before dispatching the ticket agent when the CLI is unavailable.
- Show the CLI's own actionable error instead of a generic failure.

## Intent

The Cmd-Shift-O capture flow must create a real Linear ticket for users running the packaged macOS helper. The same executable contract must work in the Dock-launched AGI EXT host.

## Current architecture

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="mockup">
    <h3>Current notification</h3>
    <p><strong>Ticket creation failed</strong></p>
    <p>linear create exited with an error.</p>
    <p>The helper already spent an agent run and hides the missing executable.</p>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <h3>Proposed notification</h3>
    <p><strong>Cannot create ticket</strong></p>
    <p>Linear CLI not found. Install it at ~/.local/bin/linear.</p>
    <p>CLI failures instead show the final actionable stderr line.</p>
  </div>
</div>

<figure class="artifact-figure artifact-figure-diagram">
<svg class="artifact-diagram" viewBox="0 0 980 280" role="img" aria-label="Before and after ticket creation data flow">
  <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0 0L0 6L9 3z" fill="#8b938c"/></marker></defs>
  <g font-family="system-ui" font-size="15">
    <text x="20" y="28" fill="#e87979" font-weight="700">CURRENT</text>
    <rect x="20" y="46" width="190" height="72" rx="12" fill="#18201b" stroke="#64748b"/><text x="115" y="78" text-anchor="middle" fill="#e8eee9">Agent investigates</text><text x="115" y="100" text-anchor="middle" fill="#8b938c">time + tokens spent</text>
    <path d="M215 82H290" stroke="#8b938c" stroke-width="3" marker-end="url(#arrow)"/>
    <rect x="300" y="46" width="330" height="72" rx="12" fill="#2b1818" stroke="#dc2626"/><text x="465" y="77" text-anchor="middle" fill="#fca5a5">retired ~/.agents/skills path</text><text x="465" y="100" text-anchor="middle" fill="#e87979">Process.run throws; detail discarded</text>
    <path d="M635 82H710" stroke="#8b938c" stroke-width="3" marker-end="url(#arrow)"/>
    <rect x="720" y="46" width="240" height="72" rx="12" fill="#20221f" stroke="#64748b"/><text x="840" y="78" text-anchor="middle" fill="#e8eee9">Generic notification</text><text x="840" y="100" text-anchor="middle" fill="#8b938c">no recovery path</text>
    <text x="20" y="160" fill="#a3e635" font-weight="700">PROPOSED</text>
    <rect x="20" y="178" width="240" height="72" rx="12" fill="#18201b" stroke="#a3e635"/><text x="140" y="208" text-anchor="middle" fill="#e8eee9">Resolve standalone CLI</text><text x="140" y="231" text-anchor="middle" fill="#a3e635">before agent dispatch</text>
    <path d="M265 214H340" stroke="#8b938c" stroke-width="3" marker-end="url(#arrow)"/>
    <rect x="350" y="178" width="280" height="72" rx="12" fill="#18201b" stroke="#a3e635"/><text x="490" y="208" text-anchor="middle" fill="#e8eee9">Absolute executable + stdin</text><text x="490" y="231" text-anchor="middle" fill="#8b938c">stdout and stderr retained</text>
    <path d="M635 214H710" stroke="#8b938c" stroke-width="3" marker-end="url(#arrow)"/>
    <rect x="720" y="178" width="240" height="72" rx="12" fill="#18201b" stroke="#a3e635"/><text x="840" y="208" text-anchor="middle" fill="#e8eee9">Created RUSH-####</text><text x="840" y="231" text-anchor="middle" fill="#a3e635">or actionable failure</text>
  </g>
</svg>
<figcaption>Resolution happens before expensive work; process truth reaches the user.</figcaption>
</figure>

## Purpose

The standalone `phnx-labs/linear-cli` is the supported contract. Two GUI consumers were left on a removed resource path, and the menubar's process callback erased the evidence needed to recover.

<div class="artifact-callout"><strong>Invariant:</strong> every live GUI ticket creator receives an absolute, executable `linear` path or fails before dispatch. There is no unresolved command-name fallback.</div>

## Proposed Changes

| Subsystem | Change | User outcome |
| --- | --- | --- |
| MenubarHelper | Deterministic resolver + preflight | Missing CLI is immediate and actionable |
| Process runner | Capture stderr and launch exceptions | Real auth/API/launch failures are visible |
| AGI EXT | Reuse its existing GUI-safe executable resolver | Foreman creates tickets without the skill repo |
| Tests/docs | Real executable fixtures, packaged macOS run, release note | The contract cannot silently drift again |

```diff
-static func linearSkillBinary() -> String {
-    "\(home)/.agents/skills/linear/scripts/linear"
-}
+static func linearBinary() -> String? {
+    resolveExecutable(name: "linear", directories: linearSearchDirectories())
+}
```

```diff
-const LINEAR_SCRIPT_PATH = path.join(homedir(), '.agents/skills/linear/scripts/linear');
+const linearBin = resolveLinearBinary();
+if (!linearBin) return { ok: false, message: LINEAR_NOT_FOUND };
```

```diff
-DispatchQueue.main.async { onFinish("", false) }
+DispatchQueue.main.async { onFinish(error.localizedDescription, false) }
```

## Public Interface

No flags, schemas, configuration keys, or APIs change. The native notification becomes actionable:

```text
Cannot create ticket
Linear CLI not found. Install it at ~/.local/bin/linear.
```

## Plan

- [x] Confirm the runtime failure and both obsolete-path consumers.
- [x] Create and claim RUSH-2657 from current origin/main.
- [ ] Implement deterministic resolution and error propagation.
- [ ] Add Swift and TypeScript regression tests.
- [ ] Update menubar docs and the next-version changelog fragment.
- [ ] Build and run the complete macOS helper gate.
- [ ] Drive Cmd-Shift-O against Linear before merge and capture proof.
- [ ] Open PR, clear independent review and CI, merge, and close RUSH-2657.

## Validation

```bash
apps/cli/menubar/scripts/test-menubar.sh <fresh MenubarHelper binary>
bun test apps/ext/src/core/linearBin.test.ts
bun run compile:ext
```

The final acceptance is the installed native path: Cmd-Shift-O produces `Created RUSH-####`, the issue contains the submitted description and image, and Recent Tickets opens that issue.

## Risks

| Risk | Handling |
| --- | --- |
| Both `~/.local` and Homebrew copies exist | Prefer the official `~/.local/bin` install deterministically |
| Executable disappears after preflight | Preserve `Process.run`'s localized launch error |
| Linear exits nonzero | Show the final non-empty stderr/stdout line, capped for notifications |
| Success emits harmless stderr | Ticket completion still parses the created identifier from combined output |
| Release binary differs from source build | Run self-tests on the staged signed helper and repeat after the release train installs it |

## Tracking

- [RUSH-2657](https://linear.app/getrush/issue/RUSH-2657/fix-gui-linear-ticket-creation-after-skill-path-removal)
- Parent reliability initiative: RUSH-2653
