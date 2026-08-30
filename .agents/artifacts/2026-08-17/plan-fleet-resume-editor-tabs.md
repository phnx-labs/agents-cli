---
kind: plan
surface: native
title: "Fleet Resume reopens remote sessions as panel terminals, not agent tabs"
summary: >
  The AGI EXT Fleet "Resume" buttons reopen orphaned/crashed remote sessions as small
  bottom-panel terminals running a hand-rolled `ssh -t <host> 'tmux … attach'`, bypassing
  the editor-tab agent-terminal path the command-palette Resume already uses. Route the
  webview's remote opens through that existing correct path and delete the ad-hoc handlers.
status: draft
tracking: "RUSH-new"
facts:
  - "Root checkout is on tmp-pr337-review, 5134 commits behind origin/main and missing apps/ext — do the work in a fresh worktree off origin/main."
  - "The correct path already exists: openResumedSessionTerminal (extension.ts:2593) opens an editor tab and runs `agents sessions resume <id> --vscodium`."
  - "The bug: settings.vscode.ts case 'focusRemoteSession' (:3033) calls createTerminal with no location => panel, plus a raw ssh that bypasses CLI fleet routing (the 192.168.1.101 timeout)."
---

## Focus for review

- **The gap in one line:** the Fleet **Sessions** webview "Resume" buttons hand-roll
  `ssh -t <host> 'tmux -S <sock> attach'` into a default `createTerminal(...)` (bottom panel),
  bypassing the editor-tab agent-terminal machinery the command-palette Resume already uses.
- **Recommended fix:** route the webview's remote-session opens through the existing
  `openResumedSessionTerminal` → `agents sessions resume <id> --vscodium`, and delete the two
  raw ssh/tmux-attach panel handlers. One correct way to open a remote agent session.
- **Scope I'm treating as in-scope:** this also fixes the single-card remote "focus/open" click
  and the `focusSession` remote fallback — the same defect in sibling handlers.
- **Bonus it fixes:** the `ssh: connect to host 192.168.1.101 … timed out` in the screenshot.
  The raw ssh resolved `yosemite-m1` to a stale LAN IP because it never went through CLI fleet
  routing. `agents sessions resume <id>` does.

## Intent

> "I tried resuming using the AGI Ext menu (click Resume) after my IDE closed … it resumed them
> in the terminals. It should probably open them as tabbed agent terminals which open up when you
> normally create these new agent sessions." — the user.

## Purpose

The Fleet "Resume" action exists to bring back sessions that stopped progressing (orphaned,
crashed, abandoned) after an editor restart. Its whole value is returning them to the exact place
new agent sessions live — **editor tabs** with a harness icon and title. Today it dumps them into
small bottom-panel terminals running a raw ssh command, so the recovered work looks nothing like a
running agent, loses tab identity, and (because it skips CLI routing) can fail to connect at all.

## Current architecture — two Resume paths, one is wrong

<div class="artifact-figure-diagram">
<svg viewBox="0 0 900 320" role="img" aria-label="Two resume paths: command palette opens editor tabs; webview opens panel terminals" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#5a6b76"/></marker></defs>

  <text x="20" y="24" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#a3e635">CORRECT — command palette "Agents: Resume"</text>
  <rect x="20" y="36" width="180" height="46" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="30" y="58" font-family="JetBrains Mono, monospace" font-size="12" fill="#d7e0e6">agents.resume</text>
  <text x="30" y="74" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">resumeSessionsBatch</text>
  <line x1="200" y1="59" x2="252" y2="59" stroke="#5a6b76" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="252" y="36" width="210" height="46" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="262" y="58" font-family="JetBrains Mono, monospace" font-size="12" fill="#d7e0e6">openResumedSessionTerminal</text>
  <text x="262" y="74" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">extension.ts:2593</text>
  <line x1="462" y1="59" x2="514" y2="59" stroke="#5a6b76" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="514" y="36" width="366" height="46" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="524" y="55" font-family="JetBrains Mono, monospace" font-size="11" fill="#d7e0e6">createTerminal({ location: viewColumn.Active })</text>
  <text x="524" y="74" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">EDITOR TAB · icon · registered · agents sessions resume &lt;id&gt; --vscodium</text>

  <text x="20" y="150" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#f87171">BUGGY — Fleet "Sessions" webview "Resume all / selected"</text>
  <rect x="20" y="162" width="180" height="46" rx="8" fill="#16120a" stroke="#f87171" stroke-width="1.5"/>
  <text x="30" y="184" font-family="JetBrains Mono, monospace" font-size="12" fill="#d7e0e6">SessionsPane</text>
  <text x="30" y="200" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">Resume buttons</text>
  <line x1="200" y1="185" x2="252" y2="185" stroke="#5a6b76" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="252" y="162" width="210" height="46" rx="8" fill="#16120a" stroke="#f87171" stroke-width="1.5"/>
  <text x="262" y="184" font-family="JetBrains Mono, monospace" font-size="12" fill="#d7e0e6">openTerminalForAgent</text>
  <text x="262" y="200" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">postMessage focusRemoteSession</text>
  <line x1="462" y1="185" x2="514" y2="185" stroke="#5a6b76" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="514" y="162" width="366" height="46" rx="8" fill="#16120a" stroke="#f87171" stroke-width="1.5"/>
  <text x="524" y="181" font-family="JetBrains Mono, monospace" font-size="11" fill="#d7e0e6">createTerminal({ name: "attach …" })  // no location</text>
  <text x="524" y="200" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">PANEL · ssh -t &lt;host&gt; 'tmux -S &lt;sock&gt; attach' (raw, no CLI routing)</text>

  <text x="20" y="250" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#f87171">SAME DEFECT — settings.vscode.ts case 'focusSession' remote fallback (:3159)</text>
  <rect x="20" y="262" width="860" height="40" rx="8" fill="#16120a" stroke="#f87171" stroke-width="1.5"/>
  <text x="30" y="287" font-family="JetBrains Mono, monospace" font-size="11" fill="#d7e0e6">createTerminal({ name: "attach &lt;id8&gt;" }) + buildRemoteFocusCommand(...)  → PANEL terminal</text>
</svg>
</div>

## Behavior — current vs proposed

<div class="artifact-behavior">
  <div class="artifact-panel" data-state="current" data-evidence="mockup">
    <h4>Current — bottom panel, "attach …" terminals</h4>
    <svg viewBox="0 0 460 250" role="img" aria-label="VS Code bottom terminal panel with attach terminals, one timed out" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="460" height="250" fill="#3a0d0d"/>
      <rect x="0" y="0" width="460" height="22" fill="#1f2a30"/>
      <text x="10" y="15" fill="#9fb2bd" font-family="Inter, system-ui, sans-serif" font-size="11">PROBLEMS  OUTPUT  DEBUG  TERMINAL  PORTS</text>
      <text x="12" y="52" fill="#e6b0b0" font-family="JetBrains Mono, monospace" font-size="11">$ ssh -t 'yosemite-m1' 'tmux -S …/server.sock attach'</text>
      <text x="12" y="72" fill="#ff8a8a" font-family="JetBrains Mono, monospace" font-size="11">ssh: connect to host 192.168.1.101:22: timed out</text>
      <rect x="330" y="26" width="130" height="200" fill="#2a0a0a"/>
      <text x="340" y="46" fill="#d7c2c2" font-family="JetBrains Mono, monospace" font-size="11">▷ attach zion…</text>
      <text x="340" y="66" fill="#d7c2c2" font-family="JetBrains Mono, monospace" font-size="11">▷ attach git st…</text>
      <text x="340" y="86" fill="#d7c2c2" font-family="JetBrains Mono, monospace" font-size="11">▷ attach crab…</text>
      <text x="340" y="106" fill="#d7c2c2" font-family="JetBrains Mono, monospace" font-size="11">▷ attach Do…</text>
      <text x="340" y="126" fill="#d7c2c2" font-family="JetBrains Mono, monospace" font-size="11">▷ attach Con…</text>
    </svg>
  </div>
  <div class="artifact-panel" data-state="proposed" data-evidence="mockup">
    <h4>Proposed — editor tabs, harness-titled agent terminals</h4>
    <svg viewBox="0 0 460 250" role="img" aria-label="VS Code editor area with agent terminal tabs" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="460" height="250" fill="#0e1a12"/>
      <rect x="0" y="0" width="460" height="26" fill="#16241a"/>
      <rect x="6" y="4" width="120" height="20" rx="4" fill="#1f3a28"/>
      <text x="14" y="18" fill="#bfe9cd" font-family="JetBrains Mono, monospace" font-size="11">◆ Claude · zion</text>
      <rect x="132" y="4" width="120" height="20" rx="4" fill="#14261b"/>
      <text x="140" y="18" fill="#9fd4b0" font-family="JetBrains Mono, monospace" font-size="11">◆ Codex · m1</text>
      <rect x="258" y="4" width="120" height="20" rx="4" fill="#14261b"/>
      <text x="266" y="18" fill="#9fd4b0" font-family="JetBrains Mono, monospace" font-size="11">◆ Claude · crab</text>
      <text x="14" y="54" fill="#cfe9d6" font-family="JetBrains Mono, monospace" font-size="11">$ agents sessions resume 71bb3b3b --vscodium</text>
      <text x="14" y="74" fill="#8fd6a3" font-family="JetBrains Mono, monospace" font-size="11">✔ resumed · CLI routed via tailnet · agent ready</text>
    </svg>
  </div>
</div>

## Proposed Changes

**1. Export the correct helper** — add `export` to `openResumedSessionTerminal`
(`apps/ext/src/vscode/extension.ts:2593`). `settings.vscode.ts:19` already imports from `./extension`.

**2. Carry agent type + cwd across the webview boundary** so the helper can resolve the harness:

```diff
   if (a.reply.kind === 'tmux' && a.reply.muxTarget) {
-    postMessage({ type: 'focusRemoteSession', host: a.reply.host, muxSocket: a.reply.muxSocket,
-                  muxTarget: a.reply.muxTarget, sessionId: a.reply.sessionId ?? a.sessionId, label: a.name })
+    postMessage({ type: 'resumeRemoteSession', sessionId: a.reply.sessionId ?? a.sessionId,
+                  agent: a.agentType, host: a.reply.host, cwd: a.cwd, version: a.version, label: a.name })
     return
   }
```

**3. Replace both raw-ssh panel handlers with the helper** in `apps/ext/src/vscode/settings.vscode.ts`
— `case 'focusRemoteSession'` (`:3033-3048`) and the remote branch of `case 'focusSession'`
(`:3167-3169`) both collapse to:

```diff
-  const attach = `tmux -S ${shq(socket)} attach`;
-  const cmd = host ? `ssh -t ${shq(host)} ${shq(attach)}` : attach;
-  const term = vscode.window.createTerminal({ name: `attach ${label}` });
-  term.sendText(cmd, true);
-  term.show(false);
+  await openResumedSessionTerminal(context, {
+    id: sessionId, shortId: sessionId.slice(0, 8), agent, host, cwd, version,
+  });
```

Keep the local fast path (`isLocalDeviceHost(host)` → `focusSessionInTerminal(sessionId)`), which is
already correct. Remove `buildRemoteFocusCommand` if it has no other caller (grep first).

## Public Interface

No new CLI flag, command, or public API. The change is internal to the extension: it swaps the
webview `postMessage` intent name (`focusRemoteSession` → `resumeRemoteSession`) and its payload
(adds `agent`, `cwd`, `version`; drops `muxSocket`/`muxTarget`), and reuses the existing
CLI verb the correct path already calls — `agents sessions resume <id> --vscodium`. User-visible
surface changes only in outcome: Resume now yields editor tabs instead of panel terminals.

## Files

| File | Change |
| --- | --- |
| `apps/ext/src/vscode/extension.ts` | `export` `openResumedSessionTerminal` (`:2593`); reference pattern `:2620-2631` |
| `apps/ext/src/vscode/settings.vscode.ts` | rewrite `case 'focusRemoteSession'` (`:3033`) + remote branch of `case 'focusSession'` (`:3159`); import helper (`:19`) |
| `apps/ext/ui/settings/components/mission-control/UnifiedAgentsPane.tsx` | `openTerminalForAgent` (`:1718`) payload; single-card poster (`:1969`) |
| Reused, unchanged | `buildVersionedResumeCommand` (`core/prewarm.ts:181`), `needsReconnect` (`floorModel.ts:220`), `SessionsPane` buttons (`:254/259/277`) |

## Plan

- [ ] Worktree off `origin/main`; export `openResumedSessionTerminal`
- [ ] Update webview `openTerminalForAgent` payload (agent + cwd + version)
- [ ] Rewrite both remote handlers in `settings.vscode.ts` to call the helper; drop raw ssh + dead `buildRemoteFocusCommand`
- [ ] Add ext test: webview remote-open intent maps to editor-tab resume (no panel `createTerminal`, no raw `ssh … tmux attach`)
- [ ] Build VSIX, install on zion, reproduce + verify editor tabs, screenshot
- [ ] CHANGELOG under next `apps/ext` version; update AGENTS.md/README if the flow is documented
- [ ] Open PR with before/after screenshots; merge on green

## Validation

```bash
# from the worktree
apps/ext/scripts/build.sh <version>
# install the VSIX into the editor on zion (never over the prod publish identity)
```

1. Start ≥2 agent sessions on remote hosts; let them go `orphaned`/`abandoned` (close tabs / restart window).
2. Fleet **Sessions** pane → **Resume all**.
3. **Expected:** each reopens as an **editor tab** (agent icon, harness-titled — not `attach <host>`),
   running `agents sessions resume <id> --vscodium`. No bottom-panel `ssh … tmux attach`, no
   `192.168.1.101` timeout.
4. Single-card **focus/open** on a remote session → same editor-tab result.

<div class="artifact-callout">
The correct behavior already exists (<code>openResumedSessionTerminal</code>). The fix deletes two
duplicate, wrong surfaces rather than adding a new one — and it fixes the ssh timeout for free,
because <code>agents sessions resume</code> owns fleet routing while the raw ssh did not.
</div>

## Risks

| Risk | Mitigation |
| --- | --- |
| Remote resume needs a tab chip without a local agent process | The `#2478` `meta` path already labels remote attach tabs; verify it resolves. |
| `focus` (join live pane) vs `resume` (recover) semantics differ | `agents sessions resume` already "decides attach vs recover"; both still open as editor tabs. File a follow-up if a distinct lightweight join is wanted. |
| Missing `cwd` on some FloorAgents | `openResumedSessionTerminal` already falls back to workspace/`process.cwd()`. |

## Tracking

Open a RUSH ticket for the fix (AGI project); link this plan and the PR both ways.
