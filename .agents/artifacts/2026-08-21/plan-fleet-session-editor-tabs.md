---
kind: plan
surface: native
title: "Fleet opens every tabless session as an agent editor tab"
summary: >
  Replace AGI EXT Fleet's raw SSH/tmux bottom-panel terminals with one registered
  editor tab per tabless session. The extension owns presentation; the hidden CLI
  lifecycle dispatcher decides whether the tab attaches to a live pane or recovers
  an ended session on its origin device.
status: proposed
tracking: "RUSH-2783"
project: "AGI"
repository: "phnx-labs/agents-cli"
harness: "Codex"
agent: "Codex"
host: "anonymized fleet worker"
session: "plan-only"
date: "2026-08-21"
links:
  - label: "Linear · RUSH-2783"
    url: "https://linear.app/getrush/issue/RUSH-2783/agi-ext-fleet-resume-reopens-remote-sessions-as-panel-terminals-not"
facts:
  - "Initial code-path evidence was captured at 804d796c6; session-module paths were rechecked after PR #2847 merged at 0250072f7."
  - "Current Fleet handlers create unregistered bottom-panel terminals and hand-roll SSH/tmux commands."
  - "The registered editor-tab constructor already exists in apps/ext/src/vscode/extension.ts."
  - "Direct sessions resume by id is strict recovery today; Fleet therefore needs the lifecycle-focused sessions focus path, not a blind resume substitution."
---

## Focus for review

- **Visible contract:** an existing AGI EXT tab still says **Focus**; every session without a tab says **Open in agent tab**; bulk selection says **Open N in agent tabs**.
- **One-tab invariant:** one click creates at most one registered editor tab. Concurrent clicks coalesce behind one in-flight open keyed by session id; later clicks focus the registered tab.
- **Lifecycle ownership:** AGI EXT chooses the surface; `agents sessions focus <id> --in-place` chooses live attach versus origin-side recovery.
- **Failure contract:** a row with no canonical session id is disabled inline; an unreachable origin or unsupported harness fails visibly inside the opened tab.
- **Compatibility:** no new public command or extension setting. `--in-place` is an internal option on the already-hidden `sessions focus` dispatcher.

## Intent

When a person reopens work from AGI EXT Fleet, the agent should return where agents normally live: a named, icon-bearing **editor tab**. It should not appear as a small raw shell in VS Code's bottom panel, and Fleet should not decide how to reach or recover the process.

The requested scope is all tabless sessions, local or remote, in any lifecycle state. If the tab already exists, Fleet focuses it. If the row is tabless and has a session id, Fleet opens an agent tab and lets the CLI resolve the correct attach or recovery path.

## Current architecture

<div class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 1180 430" role="img" aria-label="Current and proposed architecture for opening Fleet sessions" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow-neutral" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L9,5 L0,10 z" fill="#7d8992"/></marker>
    <marker id="arrow-bad" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L9,5 L0,10 z" fill="#f87171"/></marker>
    <marker id="arrow-good" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L9,5 L0,10 z" fill="#a3e635"/></marker>
  </defs>

  <text x="22" y="28" fill="#f87171" font-family="Inter, system-ui, sans-serif" font-size="15" font-weight="700">CURRENT — Fleet owns both the UI surface and remote transport</text>
  <rect x="22" y="48" width="205" height="74" rx="10" fill="#1a1414" stroke="#f87171"/>
  <text x="38" y="77" fill="#e8e8e8" font-family="JetBrains Mono, monospace" font-size="13">SessionsPane</text>
  <text x="38" y="100" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="12">Resume / Focus click</text>
  <line x1="227" y1="85" x2="276" y2="85" stroke="#f87171" stroke-width="2" marker-end="url(#arrow-bad)"/>
  <rect x="278" y="48" width="230" height="74" rx="10" fill="#1a1414" stroke="#f87171"/>
  <text x="294" y="77" fill="#e8e8e8" font-family="JetBrains Mono, monospace" font-size="13">openTerminalForAgent</text>
  <text x="294" y="100" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="12">chooses terminal / tmux / focus</text>
  <line x1="508" y1="85" x2="557" y2="85" stroke="#f87171" stroke-width="2" marker-end="url(#arrow-bad)"/>
  <rect x="559" y="48" width="270" height="74" rx="10" fill="#1a1414" stroke="#f87171"/>
  <text x="575" y="77" fill="#e8e8e8" font-family="JetBrains Mono, monospace" font-size="13">settings.vscode.ts</text>
  <text x="575" y="100" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="12">raw ssh / tmux command builder</text>
  <line x1="829" y1="85" x2="878" y2="85" stroke="#f87171" stroke-width="2" marker-end="url(#arrow-bad)"/>
  <rect x="880" y="48" width="278" height="74" rx="10" fill="#2a0f0f" stroke="#f87171" stroke-width="2"/>
  <text x="896" y="77" fill="#fecaca" font-family="JetBrains Mono, monospace" font-size="13">VS Code bottom panel</text>
  <text x="896" y="100" fill="#fca5a5" font-family="Inter, system-ui, sans-serif" font-size="12">unregistered · stale route · duplicate path</text>

  <text x="22" y="184" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="15" font-weight="700">PROPOSED — extension owns the tab; CLI owns lifecycle and routing</text>
  <rect x="22" y="204" width="205" height="74" rx="10" fill="#111810" stroke="#a3e635"/>
  <text x="38" y="233" fill="#e8e8e8" font-family="JetBrains Mono, monospace" font-size="13">SessionsPane</text>
  <text x="38" y="256" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="12">Open in agent tab</text>
  <line x1="227" y1="241" x2="276" y2="241" stroke="#a3e635" stroke-width="2" marker-end="url(#arrow-good)"/>
  <rect x="278" y="204" width="230" height="74" rx="10" fill="#111810" stroke="#a3e635"/>
  <text x="294" y="233" fill="#e8e8e8" font-family="JetBrains Mono, monospace" font-size="13">openFleetSession</text>
  <text x="294" y="256" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="12">typed presentation intent</text>
  <line x1="508" y1="241" x2="557" y2="241" stroke="#a3e635" stroke-width="2" marker-end="url(#arrow-good)"/>
  <rect x="559" y="204" width="270" height="74" rx="10" fill="#111810" stroke="#a3e635"/>
  <text x="575" y="233" fill="#e8e8e8" font-family="JetBrains Mono, monospace" font-size="13">openAgentSessionTerminal</text>
  <text x="575" y="256" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="12">editor tab · register · dedupe</text>
  <line x1="829" y1="241" x2="878" y2="241" stroke="#a3e635" stroke-width="2" marker-end="url(#arrow-good)"/>
  <rect x="880" y="204" width="278" height="74" rx="10" fill="#14200e" stroke="#a3e635" stroke-width="2"/>
  <text x="896" y="232" fill="#d9f99d" font-family="JetBrains Mono, monospace" font-size="13">agent editor tab</text>
  <text x="896" y="255" fill="#bef264" font-family="Inter, system-ui, sans-serif" font-size="12">agents sessions focus ID --in-place</text>

  <line x1="1019" y1="278" x2="1019" y2="323" stroke="#7d8992" stroke-width="2" marker-end="url(#arrow-neutral)"/>
  <rect x="752" y="326" width="406" height="77" rx="10" fill="#101418" stroke="#7d8992"/>
  <text x="768" y="353" fill="#e8e8e8" font-family="JetBrains Mono, monospace" font-size="13">CLI lifecycle dispatcher</text>
  <text x="768" y="376" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="12">live pane → attach · ended pane → origin-side recovery</text>
  <text x="768" y="394" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="12">no raw routing or session classification in the webview</text>
</svg>
</div>

The bug is the lower-level ownership boundary, not just terminal placement. The renderer picks a tmux rail, the VS Code host builds transport commands, and the terminal is created without an editor location or AGI EXT registration. That creates four user-visible failures from one architectural violation: bottom-panel placement, missing agent identity, stale SSH routing, and duplicate lifecycle logic.

| Current component | Evidence on fresh `origin/main` | Problem |
| --- | --- | --- |
| `UnifiedAgentsPane.tsx` | `openTerminalForAgent` prioritizes `focusRemoteSession`, then `focusSession` | Renderer chooses transport rather than expressing “open this session.” |
| `settings.vscode.ts` | `focusRemoteSession` builds `ssh -t … tmux attach`; remote `focusSession` creates another panel terminal | Extension duplicates CLI routing and creates the wrong surface. |
| `remoteSessions.ts` | `buildRemoteFocusCommand` hand-builds remote `sessions resume … --local` | A second lifecycle command path can drift from the CLI contract. |
| `extension.ts` | `openResumedSessionTerminal` already uses `location: viewColumn.Active`, registration, icon, host and session metadata | The correct editor-tab presentation exists but Fleet bypasses it. |
| `sessions-resume.ts` | direct id defaults to strict resume unless lifecycle flags are present | Blindly changing Fleet to `resume --vscodium` can fork a live copy. |

## Behavior — current and proposed

<div class="artifact-behavior">
  <div class="artifact-behavior-panel artifact-panel" data-state="current" data-evidence="mockup">
    <h4>Current — “Resume” opens attach shells in the bottom panel</h4>
    <svg viewBox="0 0 560 360" role="img" aria-label="Mockup of current AGI EXT session card and raw attach terminals in VS Code bottom panel" xmlns="http://www.w3.org/2000/svg">
      <rect width="560" height="360" rx="12" fill="#0a0a0a"/>
      <rect x="0" y="0" width="560" height="34" rx="12" fill="#181818"/>
      <circle cx="18" cy="17" r="5" fill="#f87171"/><circle cx="35" cy="17" r="5" fill="#facc15"/><circle cx="52" cy="17" r="5" fill="#a3e635"/>
      <text x="76" y="22" fill="#888" font-family="Inter, system-ui, sans-serif" font-size="12">AGI EXT · Fleet</text>
      <rect x="14" y="48" width="532" height="106" rx="8" fill="#141414" stroke="#333"/>
      <text x="28" y="73" fill="#e8e8e8" font-family="JetBrains Mono, monospace" font-size="13">CX  Fix session recovery</text>
      <text x="28" y="94" fill="#888" font-family="Inter, system-ui, sans-serif" font-size="11">worker-a · crashed · 18 minutes ago</text>
      <rect x="422" y="66" width="105" height="32" rx="5" fill="#a3e635"/>
      <text x="447" y="87" fill="#0a0a0a" font-family="Inter, system-ui, sans-serif" font-weight="700" font-size="12">Resume</text>
      <text x="28" y="128" fill="#fca5a5" font-family="Inter, system-ui, sans-serif" font-size="11">Click creates an unregistered panel shell</text>
      <rect x="0" y="172" width="560" height="188" fill="#1a0f0f"/>
      <rect x="0" y="172" width="560" height="28" fill="#222"/>
      <text x="14" y="190" fill="#bbb" font-family="Inter, system-ui, sans-serif" font-size="10">PROBLEMS   OUTPUT   DEBUG CONSOLE   <tspan fill="#f87171">TERMINAL</tspan></text>
      <text x="16" y="226" fill="#f5d0d0" font-family="JetBrains Mono, monospace" font-size="10">$ ssh -t 'worker-a' 'tmux -S … attach'</text>
      <text x="16" y="250" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="10">ssh: connection timed out</text>
      <rect x="390" y="203" width="170" height="157" fill="#231111"/>
      <text x="402" y="227" fill="#fca5a5" font-family="JetBrains Mono, monospace" font-size="10">attach fix-session</text>
      <text x="402" y="250" fill="#d6b4b4" font-family="JetBrains Mono, monospace" font-size="10">attach release</text>
      <text x="402" y="273" fill="#d6b4b4" font-family="JetBrains Mono, monospace" font-size="10">attach tests</text>
    </svg>
  </div>

  <div class="artifact-behavior-panel artifact-panel" data-state="proposed" data-evidence="mockup">
    <h4>Proposed — “Open in agent tab” creates one normal agent editor tab</h4>
    <svg viewBox="0 0 560 360" role="img" aria-label="Mockup of proposed AGI EXT session card and registered agent editor tab" xmlns="http://www.w3.org/2000/svg">
      <rect width="560" height="360" rx="12" fill="#0a0a0a"/>
      <rect x="0" y="0" width="560" height="34" rx="12" fill="#181818"/>
      <circle cx="18" cy="17" r="5" fill="#f87171"/><circle cx="35" cy="17" r="5" fill="#facc15"/><circle cx="52" cy="17" r="5" fill="#a3e635"/>
      <text x="76" y="22" fill="#888" font-family="Inter, system-ui, sans-serif" font-size="12">AGI EXT · Fleet</text>
      <rect x="14" y="48" width="532" height="106" rx="8" fill="#141414" stroke="#333"/>
      <text x="28" y="73" fill="#e8e8e8" font-family="JetBrains Mono, monospace" font-size="13">CX  Fix session recovery</text>
      <text x="28" y="94" fill="#888" font-family="Inter, system-ui, sans-serif" font-size="11">worker-a · crashed · 18 minutes ago</text>
      <rect x="383" y="66" width="144" height="32" rx="5" fill="#a3e635"/>
      <text x="397" y="87" fill="#0a0a0a" font-family="Inter, system-ui, sans-serif" font-weight="700" font-size="11">Open in agent tab</text>
      <text x="28" y="128" fill="#bef264" font-family="Inter, system-ui, sans-serif" font-size="11">Repeated click focuses this same tab</text>
      <rect x="0" y="172" width="560" height="188" fill="#0d1510"/>
      <rect x="0" y="172" width="560" height="31" fill="#1b241e"/>
      <rect x="8" y="176" width="184" height="27" rx="5" fill="#26372a" stroke="#a3e635"/>
      <text x="20" y="194" fill="#d9f99d" font-family="JetBrains Mono, monospace" font-size="10">CX · Fix session recovery</text>
      <rect x="198" y="176" width="133" height="27" rx="5" fill="#171f19"/>
      <text x="210" y="194" fill="#8da694" font-family="JetBrains Mono, monospace" font-size="10">CC · Release</text>
      <text x="18" y="237" fill="#e8e8e8" font-family="JetBrains Mono, monospace" font-size="10">$ agents sessions focus ag-codex-8c21 --in-place</text>
      <text x="18" y="265" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">Attached to live pane on origin device</text>
      <text x="18" y="293" fill="#888" font-family="JetBrains Mono, monospace" font-size="10">session ag-codex-8c21 · registered · editor tab</text>
    </svg>
  </div>
</div>

### The visible state model

<div class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 1180 500" role="img" aria-label="Decision flow for opening or focusing a Fleet session" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="flow-arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L9,5 L0,10 z" fill="#7d8992"/></marker></defs>
  <rect x="32" y="198" width="160" height="64" rx="10" fill="#141414" stroke="#a3e635"/>
  <text x="58" y="226" fill="#e8e8e8" font-family="JetBrains Mono, monospace" font-size="13">Fleet action</text>
  <text x="52" y="247" fill="#888" font-family="Inter, system-ui, sans-serif" font-size="11">one row or bulk</text>
  <line x1="192" y1="230" x2="253" y2="230" stroke="#7d8992" stroke-width="2" marker-end="url(#flow-arrow)"/>

  <polygon points="330,152 407,230 330,308 253,230" fill="#101418" stroke="#a3e635"/>
  <text x="287" y="224" fill="#e8e8e8" font-family="Inter, system-ui, sans-serif" font-size="12">registered tab</text>
  <text x="311" y="243" fill="#e8e8e8" font-family="Inter, system-ui, sans-serif" font-size="12">exists?</text>
  <line x1="330" y1="152" x2="330" y2="91" stroke="#7d8992" stroke-width="2" marker-end="url(#flow-arrow)"/>
  <text x="342" y="126" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="11">yes</text>
  <rect x="250" y="28" width="160" height="62" rx="10" fill="#14200e" stroke="#a3e635"/>
  <text x="286" y="54" fill="#d9f99d" font-family="JetBrains Mono, monospace" font-size="13">Focus tab</text>
  <text x="274" y="75" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="11">no new process</text>
  <line x1="407" y1="230" x2="474" y2="230" stroke="#7d8992" stroke-width="2" marker-end="url(#flow-arrow)"/>
  <text x="426" y="219" fill="#facc15" font-family="Inter, system-ui, sans-serif" font-size="11">no</text>

  <polygon points="550,152 627,230 550,308 473,230" fill="#101418" stroke="#a3e635"/>
  <text x="514" y="224" fill="#e8e8e8" font-family="Inter, system-ui, sans-serif" font-size="12">canonical</text>
  <text x="514" y="243" fill="#e8e8e8" font-family="Inter, system-ui, sans-serif" font-size="12">session id?</text>
  <line x1="550" y1="308" x2="550" y2="383" stroke="#7d8992" stroke-width="2" marker-end="url(#flow-arrow)"/>
  <text x="562" y="352" fill="#f87171" font-family="Inter, system-ui, sans-serif" font-size="11">no</text>
  <rect x="463" y="386" width="174" height="72" rx="10" fill="#1a1414" stroke="#f87171"/>
  <text x="490" y="413" fill="#fecaca" font-family="JetBrains Mono, monospace" font-size="12">Disable action</text>
  <text x="480" y="436" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="11">refresh-and-retry reason</text>
  <line x1="627" y1="230" x2="694" y2="230" stroke="#7d8992" stroke-width="2" marker-end="url(#flow-arrow)"/>
  <text x="646" y="219" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="11">yes</text>

  <rect x="696" y="189" width="194" height="82" rx="10" fill="#14200e" stroke="#a3e635"/>
  <text x="715" y="218" fill="#d9f99d" font-family="JetBrains Mono, monospace" font-size="12">Create + register tab</text>
  <text x="715" y="241" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="11">icon · title · cwd · host</text>
  <text x="715" y="258" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="11">one session-id key</text>
  <line x1="890" y1="230" x2="950" y2="230" stroke="#7d8992" stroke-width="2" marker-end="url(#flow-arrow)"/>

  <rect x="952" y="174" width="198" height="112" rx="10" fill="#101418" stroke="#a3e635"/>
  <text x="970" y="204" fill="#e8e8e8" font-family="JetBrains Mono, monospace" font-size="12">CLI focus --in-place</text>
  <text x="970" y="230" fill="#bef264" font-family="Inter, system-ui, sans-serif" font-size="11">live rail → attach</text>
  <text x="970" y="252" fill="#bef264" font-family="Inter, system-ui, sans-serif" font-size="11">ended rail → recover</text>
  <text x="970" y="274" fill="#fca5a5" font-family="Inter, system-ui, sans-serif" font-size="11">error → visible in tab</text>

  <rect x="696" y="329" width="454" height="129" rx="10" fill="#0f0f0f" stroke="#333"/>
  <text x="714" y="357" fill="#888" font-family="JetBrains Mono, monospace" font-size="11">Invariant</text>
  <text x="714" y="383" fill="#e8e8e8" font-family="Inter, system-ui, sans-serif" font-size="12">The webview never asks “tmux or resume?”</text>
  <text x="714" y="407" fill="#e8e8e8" font-family="Inter, system-ui, sans-serif" font-size="12">The extension never asks “local or SSH?”</text>
  <text x="714" y="431" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="12">The CLI re-checks live state at execution time.</text>
</svg>
</div>

## Purpose

This restores the product boundary documented by both components:

- AGI EXT is a thin presentation client. It owns editor tabs, titles, icons, registration and focus.
- agents-cli owns session discovery, live-rail validation, device routing and recovery policy.

The design also closes the race the older plan left open. A pane can die after Fleet renders it. If Fleet constructs a raw tmux attach command, the user gets a dead terminal. If Fleet blindly runs strict resume, a live headless process can be copied. The hidden in-place dispatcher re-reads current state after the editor tab exists, then attaches or recovers in that same tab.

<div class="artifact-callout">
The key change is not “put the terminal in a different location.” It is “create exactly one normal agent tab, then let the CLI perform the authoritative lifecycle decision inside it.”
</div>

## Proposed changes

### 1. Add an internal in-place lifecycle mode to the CLI

`apps/cli/src/commands/focus.ts` remains the single attach/recover decision. Add the internal `--in-place` option to the already-hidden `focus` command. It changes only the no-attach fallback: recover in the current TTY instead of asking the terminal engine to create another tab.

```diff
 export interface FocusOptions {
   local?: boolean;
   attachOnly?: boolean;
+  inPlace?: boolean;
 }

 const cmd = program
   .command('focus', { hidden: true })
+  .option('--in-place', 'Internal: recover in this terminal; never open another surface')

-export function selectFallback(attachOnly: boolean | undefined): UnreachableFallback {
-  return attachOnly ? refuseFallback : resumeInNewTab;
+export function selectFallback(opts: Pick<FocusOptions, 'attachOnly' | 'inPlace'>): UnreachableFallback {
+  if (opts.attachOnly && opts.inPlace) {
+    throw new Error('--attach-only and --in-place cannot be combined');
+  }
+  if (opts.attachOnly) return refuseFallback;
+  if (opts.inPlace) return recoverInCurrentTerminal;
+  return resumeInNewTab;
 }
```

Extract the existing origin-side recovery body so the ordinary exact-id path and the race fallback share it rather than duplicating a third recovery implementation.

```diff
+async function recoverResolvedInCurrentTerminal(meta: SessionMeta, remote?: string): Promise<void> {
+  if (remote) {
+    const rc = await runOnPeer(sessionRecoveryRunArgs(meta), remote, { tty: true });
+    if (rc === 'no-target') failUnreachableOrigin(meta, remote);
+    return;
+  }
+  await resumeSessionInPlace(meta);
+}

+const recoverInCurrentTerminal: UnreachableFallback = async (active, remote) => {
+  const meta = await richMetaById(active.sessionId ?? '');
+  if (!meta) return failMissingSession(active.sessionId);
+  await recoverResolvedInCurrentTerminal(meta, remote);
+};
```

The internal command AGI EXT runs is:

```bash
agents sessions focus <session-id> --in-place
```

### 2. Preserve the metadata the editor-tab constructor needs

`RemoteSessionLike` already carries `agentType` and `cwd`; `toFloorAgentFromRemote` drops them. Preserve both on `FloorAgent` and on every adapter. This is presentation metadata only, not lifecycle policy.

```diff
 export interface FloorAgent {
   id: string
   host: string
   sessionId?: string
+  agentType: string
+  cwd?: string
 }

 return {
   id,
   host: r.host,
   sessionId: r.sessionId,
+  agentType: r.agentType,
+  cwd: r.cwd,
 }
```

### 3. Replace transport-shaped messages with one typed intent

Add one renderer-to-host message to `apps/ext/ui/settings/shared/protocol.ts`. Remove the legacy `focusSession` variant and the untyped `focusRemoteSession` payload after every call site moves.

```diff
 export type FloorInbound =
-  | { type: 'focusSession'; sessionId: string; host?: string }
+  | {
+      type: 'openFleetSession'
+      sessionId: string
+      agentType: string
+      cwd?: string
+      host?: string
+    }
```

`UnifiedAgentsPane.tsx` becomes a surface decision with three outcomes only: focus an existing registered terminal, open a tab for an identified tabless session, or show a disabled action when no id exists.

```diff
 const openTerminalForAgent = useCallback((agent: FloorAgent) => {
   if (agent.reply.kind === 'terminal' && agent.reply.terminalId) {
     postMessage({ type: 'focusTerminal', terminalId: agent.reply.terminalId })
     return
   }
-  if (agent.reply.kind === 'tmux' && agent.reply.muxTarget) {
-    postMessage({ type: 'focusRemoteSession', ... })
-    return
-  }
   if (agent.sessionId) {
-    postMessage({ type: 'focusSession', sessionId: agent.sessionId, host: agent.host })
+    postMessage({
+      type: 'openFleetSession',
+      sessionId: agent.sessionId,
+      agentType: agent.agentType,
+      cwd: agent.cwd,
+      host: agent.host,
+    })
   }
 }, [])
```

### 4. Generalize the registered editor-tab constructor

Refactor `openResumedSessionTerminal` into a small shared constructor, `openAgentSessionTerminal`, that receives the command to run. Command-palette Resume still supplies `buildVersionedResumeCommand`; Fleet supplies `buildFocusInPlaceCommand`.

The dedupe boundary must cover both registered and **currently opening** terminals. `terminal.processId` is asynchronous, so a `getBySessionId` check followed by creation still lets two same-tick clicks allocate two terminals before either is registered. A module-owned `openingSessions` map installs a lazy promise before terminal creation begins; concurrent callers await that same promise, and `finally` releases only that exact reservation.

```diff
-async function openResumedSessionTerminal(context, session): Promise<boolean> {
-  const resumeCmd = buildVersionedResumeCommand(agentKey, session.id, session.version, session.host)
+const openingSessions = new Map<string, Promise<boolean>>()
+
+async function openAgentSessionTerminal(context, session, command): Promise<boolean> {
+  const registered = terminals.getBySessionId(session.id)
+  if (registered) {
+    registered.terminal.show(false)
+    return true
+  }
+  const pending = openingSessions.get(session.id)
+  if (pending) return pending
+
+  const opening = Promise.resolve().then(() =>
+    createAndRegisterAgentSessionTerminal(context, session, command),
+  )
+  openingSessions.set(session.id, opening)
+  try {
+    return await opening
+  } finally {
+    if (openingSessions.get(session.id) === opening) openingSessions.delete(session.id)
+  }
+}
+
+async function createAndRegisterAgentSessionTerminal(context, session, command): Promise<boolean> {
+  const terminal = vscode.window.createTerminal({
+    iconPath: agentConfig.iconPath,
+    location: { viewColumn: vscode.ViewColumn.Active },
+    name: title,
+    cwd: session.cwd,
+    env: buildAgentTerminalEnv(...),
+    isTransient: true,
+  })
+  const pid = await terminal.processId
+  terminals.register(terminal, terminalId, agentConfig, pid, context)
+  terminals.setSessionId(terminal, session.id)
+  terminals.setAgentType(terminal, agentKey)
+  terminal.sendText(command)
+  return true
+}
+
+const openResumedSessionTerminal = (context, session) =>
+  openAgentSessionTerminal(context, session, buildVersionedResumeCommand(...))
+
+const openFleetSessionTerminal = (context, session) =>
+  openAgentSessionTerminal(context, session, buildFocusInPlaceCommand(session.id))
```

Keep command construction pure and testable beside the existing resume builder in `apps/ext/src/core/prewarm.ts`.

```diff
+export function buildFocusInPlaceCommand(sessionId: string): string {
+  return `agents sessions focus ${shellQuoteArg(sessionId)} --in-place`;
+}
```

### 5. Delete the duplicate transport path and update the visible copy

In `settings.vscode.ts`, replace both remote panel handlers with `openFleetSessionTerminal`. Delete `focusSessionInTerminal`, `buildRemoteFocusCommand`, its raw SSH tests, and every `focusRemoteSession` caller once `rg` proves there is no remaining consumer.

In Sessions and card actions:

| Row state | Primary action | Result |
| --- | --- | --- |
| Registered AGI EXT terminal exists | **Focus** | Show existing editor tab. |
| Tabless + canonical session id | **Open in agent tab** | Create one registered editor tab and run lifecycle focus inside it. |
| Bulk selection of N openable rows | **Open N in agent tabs** | One registered tab per unique session id. |
| No canonical session id | Disabled **Open in agent tab** | Inline reason: “Session ID unavailable; refresh and retry.” |

## Public interface

There is no new public command, command-palette item, config key or API. The implementation adds two internal contracts:

| Contract | Exact name | Stability |
| --- | --- | --- |
| CLI lifecycle option | `agents sessions focus <id> --in-place` | Internal; `focus` is already hidden. |
| Webview intent | `openFleetSession` | Internal typed renderer-to-extension protocol. |

Existing public surfaces remain unchanged:

```bash
# History/picker recovery remains the public user workflow.
agents sessions resume

# Existing internal lifecycle behavior remains attach-if-live, recover-if-ended.
agents sessions focus <session-id>
```

## Files

| File | Planned change |
| --- | --- |
| `apps/cli/src/commands/focus.ts` | Add internal `--in-place`; centralize current-terminal recovery; fail loud on contradictory options. |
| `apps/cli/src/commands/focus.test.ts` | Exercise real live/dead tmux rails and the in-place fallback without mocks. |
| `apps/ext/src/core/prewarm.ts` + existing colocated test | Add the quoted `buildFocusInPlaceCommand`. |
| `apps/ext/ui/settings/components/mission-control/floorModel.ts` + test | Preserve `agentType` / `cwd`; add the pure open-action resolver. |
| `apps/ext/ui/settings/components/mission-control/floorAdapter.ts` + test | Carry metadata through local and remote adapters. |
| `apps/ext/ui/settings/shared/protocol.ts` + protocol test | Add `openFleetSession`; remove stale focus messages. |
| `apps/ext/ui/settings/components/mission-control/UnifiedAgentsPane.tsx` | Route all tabless identified sessions through the typed open intent; update singular/bulk copy and unavailable state. |
| `apps/ext/src/vscode/extension.ts` | Generalize the registered editor-tab constructor; coalesce in-flight opens by session id before the first await; focus already-registered tabs. |
| `apps/ext/src/vscode/settings.vscode.ts` | Handle `openFleetSession`; remove both raw panel-terminal handlers. |
| `apps/ext/src/core/remoteSessions.ts` + test | Delete `buildRemoteFocusCommand` and isolated SSH quoting tests after the last caller moves. |
| `apps/ext/AGENTS.md`, `apps/ext/README.md`, `apps/ext/CHANGELOG.md` | Document Fleet's editor-tab behavior. |
| `apps/cli/AGENTS.md`, `apps/cli/docs/sessions.md`, `apps/cli/docs/specifications.md`, `apps/cli/CHANGELOG.md` | Record the hidden in-place lifecycle contract and its no-second-surface invariant. |

PR #2847 merged while this plan was under review (`0250072f7`). It moved session remote fan-out files without changing this Fleet behavior; `focus.ts` still reaches the compatibility export from `sessions-resume.ts`. Implementation must start from post-#2847 `origin/main` and re-run the import/caller audit rather than copying pre-merge paths from this plan.

## Plan

- [ ] Claim RUSH-2783 and create a feature worktree from freshly fetched `origin/main`.
- [ ] Add CLI `focus --in-place`, centralize recovery, and land the real lifecycle tests first.
- [ ] Carry `agentType` / `cwd` through Floor models and replace the transport-shaped protocol.
- [ ] Generalize the registered editor-tab constructor, add registered + in-flight session-id dedupe, and remove raw SSH/tmux handlers.
- [ ] Update **Focus** / **Open in agent tab** / **Open N in agent tabs** copy and the missing-id inline state.
- [ ] Update component docs, specifications and both changelogs; audit the companion `.agents-system` session guidance and record whether any consumer needs a change.
- [ ] Run CLI remote tests and extension tests/build; inspect the real AGI EXT surface on the interactive macOS host.
- [ ] Attach before/after proof to the implementation PR, obtain non-author review, merge on green, release the affected package/surface, and verify the installed version.

## Validation

### Automated

```bash
# CLI: canonical remote suite from apps/cli
bun run test:remote

# Extension: real package boundaries from apps/ext
bun test
bun run compile:ext
scripts/build.sh <version>
```

| Invariant | Test signal |
| --- | --- |
| Existing tab focuses | Terminal registry returns the same terminal; terminal count is unchanged. |
| Two opens in the same event-loop turn | A real extension-host integration sends two `openFleetSession` messages before `processId` resolves; both await one reservation, exactly one terminal is created and registered. |
| Live local tmux session | New editor tab attaches in place; no recovery command spawns. |
| Live remote tmux session | New editor tab connects through CLI focus and joins the pane; no raw Fleet SSH builder remains. |
| Pane dies between render and click | CLI liveness recheck recovers inside the already-created tab; no second tab. |
| Local or remote session with no attach rail | Origin-side recovery runs in the created tab; exactly one terminal is registered. |
| Crashed / closed / abandoned session | Recovery resolver chooses the healthy same-harness path on the origin device. |
| Missing id | Action is disabled with the inline refresh reason; nothing silently no-ops. |
| Bulk open | One tab per unique session id; re-running the action focuses existing tabs. |

### End to end on the installed extension

1. Capture the current Fleet behavior with a tabless remote session: card, click, and bottom-panel terminal.
2. Install the feature VSIX on the interactive macOS host without replacing the production `agents` CLI.
3. Exercise one existing tab, one local tabless session, one live remote tmux session, one crashed remote session, and one live no-tmux session.
4. Use the bulk action on a mixed selection, then repeat it.
5. Confirm the editor area contains one icon-bearing registered tab per session id, the bottom panel contains no `attach …` terminals, and Copy Session ID / Resume / Fork see the opened tabs.
6. After merge and extension release, repeat the flow against the installed Marketplace build and capture the deployed result.

## Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| “Resume” is replaced with a broader open action | A live tabless session is not being resumed; it is being attached or recovered. | Use **Open in agent tab** for tabless rows; reserve **Focus** for an existing tab. |
| Pane liveness changes after the UI snapshot | A precomputed tmux command can attach a dead pane. | CLI probes immediately before attach; `--in-place` keeps fallback in the same editor tab. |
| Double-click / repeated bulk action | Duplicate agent copies are costly and confusing; registry-only lookup races before `processId` and registration. | Reserve `openingSessions[sessionId]` before the first await, coalesce concurrent callers, then let `getBySessionId` own all later clicks. Renderer state is only an optimization. |
| Unsupported or missing agent type | The editor tab cannot get a trustworthy icon/config. | Preserve `agentType` from the CLI; fail visibly before creating a false shell tab. |
| Post-#2847 paths differ from the initial evidence | The session remote fan-out refactor merged while this plan was reviewed. | Start from post-merge `origin/main`, re-run the import/caller audit, and keep behavior changes in canonical owners rather than reviving compatibility shims. |
| Hidden CLI surface becomes accidental public API | Internal flags can escape into docs or autocomplete. | Keep `focus` hidden, document only in internal architecture/spec text, and expose no command-palette entry. |
| Companion guidance still teaches old behavior | Fleet agents may keep invoking a stale command. | Audit the `.agents-system` consumers of `sessions focus/resume`; link a companion PR only if the audit finds a caller. |

## Tracking

- [RUSH-2783 — AGI EXT: Fleet Resume reopens remote sessions as panel terminals, not agent editor tabs](https://linear.app/getrush/issue/RUSH-2783/agi-ext-fleet-resume-reopens-remote-sessions-as-panel-terminals-not)
- Plan source and rendered HTML live together under `.agents/artifacts/2026-08-21/` and will be committed in the plan PR.
- The implementation PR should link this plan and RUSH-2783; the Linear ticket should link both PRs so navigation works in both directions.
