---
kind: visual
title: Trace debugger — one shell-exec-tool predicate
summary: The "is this tool a shell command?" decision lived as six hand-synced copies across the trace cluster and had drifted apart. They collapse to one case-insensitive isShellExecTool in shell-programs.ts. Behavior-preserving plus the drift fix; 518 session tests green.
status: draft
context: agents-cli apps/cli/src/lib/session refactor
facts:
  - "6 call sites -> 1 predicate; net -24 lines of source"
  - "Drift: the indexer treated Codex exec/execute + run_command as shell; the model, state scan, and both renderers did not"
  - "After: buildTrajectory over exec/Execute/Bash/run_command resolves git/npm/git/rg — npm 84% · git 13% · rg 2%"
---

## Story

The trace debugger answers one question in six places: **is this harness tool a shell command?** Each place spelled it differently — the tool-call indexer used a lowercase 7-name set, the trajectory model and the directory-touched scan used a case-sensitive 6-name array, the stream renderer checked two names, the HTML renderer used a `.includes('exec')` substring, and `trajectory.ts` alone carried **two** different forms. A hand-written *"kept in lockstep"* docblock was doing the job a shared function should — and the copies had already drifted: the indexer recognized Codex's `exec`/`execute` and Grok's `run_command`, but the model, the state scan, and both renderers didn't, so the same session's shell steps were **indexed one way and rendered another**.

The fix is the smallest one on the deletion ladder that works: one case-insensitive `isShellExecTool` in the leaf module `shell-programs.ts` (already imported by both `trajectory.ts` and `tool-calls.ts`, and sitting beside the distinct `SHELL_WRAPPERS`), consumed by all six sites.

## Figure

<div class="artifact-behavior">
<div class="artifact-behavior-panel" data-state="current" data-evidence="grep: SHELL_TOOLS / shell-tool idioms on origin/main">
<svg viewBox="0 0 440 320" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Inter, system-ui, sans-serif" role="img" aria-label="Six drifting copies of the shell-tool decision">
<text x="220" y="20" font-size="13" font-weight="800" text-anchor="middle" fill="currentColor">BEFORE — 6 copies, drifted</text>
<rect x="16" y="40" width="192" height="40" rx="5" stroke="currentColor" fill="none"/><text x="24" y="58" font-size="10.5" fill="currentColor">tool-calls.ts:19  · indexer</text><text x="24" y="72" font-size="9" fill="#16a34a">lowercase · 7: +exec +execute +run_command</text>
<rect x="232" y="40" width="192" height="40" rx="5" stroke="currentColor" fill="none"/><text x="240" y="58" font-size="10.5" fill="currentColor">trajectory.ts:138 · program</text><text x="240" y="72" font-size="9" fill="#dc2626">exact-case · 6 · no run_command</text>
<rect x="16" y="92" width="192" height="40" rx="5" stroke="currentColor" fill="none"/><text x="24" y="110" font-size="10.5" fill="currentColor">trajectory.ts:206 · arg extract</text><text x="24" y="124" font-size="9" fill="#dc2626">lower + .includes('exec') · 3rd form</text>
<rect x="232" y="92" width="192" height="40" rx="5" stroke="currentColor" fill="none"/><text x="240" y="110" font-size="10.5" fill="currentColor">state.ts:285 · dir-touched</text><text x="240" y="124" font-size="9" fill="#dc2626">exact-case · 6 · no run_command</text>
<rect x="16" y="144" width="192" height="40" rx="5" stroke="currentColor" fill="none"/><text x="24" y="162" font-size="10.5" fill="currentColor">stream-render.ts · color</text><text x="24" y="176" font-size="9" fill="#dc2626">only Bash + exec_command (2)</text>
<rect x="232" y="144" width="192" height="40" rx="5" stroke="currentColor" fill="none"/><text x="240" y="162" font-size="10.5" fill="currentColor">trajectory-html.ts · color</text><text x="240" y="176" font-size="9" fill="#dc2626">.includes('exec') substring</text>
<text x="220" y="214" font-size="10.5" text-anchor="middle" fill="#8a8a8a">…kept aligned by a "// in lockstep with state.ts" docblock</text>
<rect x="60" y="236" width="320" height="64" rx="6" stroke="#dc2626" fill="none" stroke-dasharray="4 3"/>
<text x="220" y="260" font-size="11" text-anchor="middle" fill="#dc2626" font-weight="700">Same Codex `exec` step</text>
<text x="220" y="278" font-size="10" text-anchor="middle" fill="currentColor">indexed as shell ✓  ·  program-resolved ✗  ·  colored ✗</text>
<text x="220" y="292" font-size="10" text-anchor="middle" fill="currentColor">Grok `run_command`: known to indexer only</text>
</svg>
</div>
<div class="artifact-behavior-panel" data-state="proposed" data-evidence="derived: all 6 sites call isShellExecTool()">
<svg viewBox="0 0 440 320" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Inter, system-ui, sans-serif" role="img" aria-label="One shared predicate">
<text x="220" y="20" font-size="13" font-weight="800" text-anchor="middle" fill="currentColor">AFTER — 1 source of truth</text>
<rect x="120" y="40" width="200" height="48" rx="6" stroke="#16a34a" fill="none" stroke-width="2"/><text x="220" y="60" font-size="11" text-anchor="middle" fill="#16a34a" font-weight="800">shell-programs.ts</text><text x="220" y="76" font-size="10" text-anchor="middle" fill="currentColor">isShellExecTool() · case-insensitive · 7 names</text>
<rect x="16" y="140" width="120" height="34" rx="5" stroke="currentColor" fill="none"/><text x="76" y="161" font-size="9.5" text-anchor="middle" fill="currentColor">tool-calls</text>
<rect x="146" y="140" width="120" height="34" rx="5" stroke="currentColor" fill="none"/><text x="206" y="161" font-size="9.5" text-anchor="middle" fill="currentColor">trajectory ×2</text>
<rect x="276" y="140" width="148" height="34" rx="5" stroke="currentColor" fill="none"/><text x="350" y="161" font-size="9.5" text-anchor="middle" fill="currentColor">state.ts</text>
<rect x="60" y="196" width="150" height="34" rx="5" stroke="currentColor" fill="none"/><text x="135" y="217" font-size="9.5" text-anchor="middle" fill="currentColor">stream-render</text>
<rect x="230" y="196" width="150" height="34" rx="5" stroke="currentColor" fill="none"/><text x="305" y="217" font-size="9.5" text-anchor="middle" fill="currentColor">trajectory-html</text>
<path d="M180 88 L76 140" stroke="#16a34a" fill="none"/><path d="M210 88 L206 140" stroke="#16a34a" fill="none"/><path d="M250 88 L350 140" stroke="#16a34a" fill="none"/><path d="M170 88 L135 196" stroke="#16a34a" fill="none" opacity="0.7"/><path d="M270 88 L305 196" stroke="#16a34a" fill="none" opacity="0.7"/>
<rect x="60" y="256" width="320" height="46" rx="6" stroke="#16a34a" fill="none"/>
<text x="220" y="276" font-size="10.5" text-anchor="middle" fill="#16a34a" font-weight="700">exec→git · Execute→npm · Bash→git · run_command→rg</text>
<text x="220" y="292" font-size="10" text-anchor="middle" fill="currentColor">indexed = resolved = colored, every harness</text>
</svg>
</div>
</div>

## Data

| Site | `file:line` | Role | Was | Now |
|---|---|---|---|---|
| indexer | `tool-calls.ts:19,254` | command indexing | lowercase Set (7) | `isShellExecTool` |
| model | `trajectory.ts:138,320` | program resolution | exact-case Set (6) | `isShellExecTool` |
| model | `trajectory.ts:206` | command-arg extraction | `.includes('exec')` chain | `isShellExecTool` |
| state | `state.ts:285` | directory-touched scan | exact-case array (6) | `isShellExecTool` |
| stream | `stream-render.ts:19` | tool color | `Bash \|\| exec_command` | `isShellExecTool` |
| html | `trajectory-html.ts:26` | bar color | `.includes('exec')` chain | `isShellExecTool` |

Net **-24 source lines**. Out of scope by design: the per-harness parser blocks in `parse.ts` (each knows its own tool's arg field) and the Bash-syntax bucketer in `digest.ts` — different concepts, not the shell-tool set.
