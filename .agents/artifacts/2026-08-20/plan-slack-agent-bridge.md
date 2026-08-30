---
kind: plan
surface: cli
title: "Slack → agent on my box: tag @agents with a project, it resumes your local session and replies in-thread"
summary: >
  Today you can only reach the agent that holds your context by sitting at the machine
  (SSH to the box, agents sessions -p <project>, resume/message it). This adds a slack
  inbound source to the existing agents-daemon webhook receiver so a Slack mention or
  slash command routes to the right local session, runs headlessly with its prior
  context, and posts the result back into the same Slack thread.
status: draft
tracking: "RUSH-new (AGI)"
facts:
  - "Inbound already exists: the agents-daemon hosts an HMAC-signed receiver on 127.0.0.1:8787, but its path regex is hard-locked to ^/hooks/(github|linear)/?$ (lib/triggers/webhook.js:407)."
  - "Slack is outbound-only today: a Rush-backed 'slack' channel exists for agents send (lib/channels/providers/rush.js:11); there is no slack.js provider and no inbound slack code."
  - "Talking to a local session already works: agents sessions -p <project> (FTS5 db.js:1), agents run --resume <id> [prompt] (exec.js:510), agents message <id> <text> routes mailbox/inject/resume (message.js:170)."
  - "Public ingress already supported: Tailscale Funnel publicPort 443/8443/10000 (funnel.js:2, daemon-webhooks.js:44) — Slack's Request URL points at it."
  - "The change lands in the TS source (apps/cli/src/lib/triggers/*.ts); this checkout ships only compiled dist/, so file:line evidence below is dist/."
---

## Focus for review

Four genuine forks are yours to pick — everything else follows from them:

- **Reply mechanism** — Slack **bot token** (`chat.postMessage` with `thread_ts`, survives a long agent run) vs **`response_url`** (no bot scope, but dies after 30 min / 5 posts). I recommend the bot token.
- **How you invoke it in Slack** — **slash command** `/agents AGI …` (explicit, no bot-in-channel needed) vs **@mention** `@agents AGI …` (natural, needs the bot in the channel + Events API). I recommend shipping slash first, mention second.
- **Which box runs the work (v1)** — **pin to zion** (the interactive box holds most of your context; one Funnel, one receiver) vs **fleet-route by `session.machine`** (the daemon SSH-dispatches to whichever box owns that project's session). I recommend pin-to-zion for v1, fleet-route as a follow-up.
- **How a message names its project** — explicit `PROJECT:` prefix, a Slack **channel → project** map (`#agi` ⇒ AGI), or the `~/.agents/projects` named overlay. I recommend `PROJECT:` + the named overlay now, channel-map as a convenience later.

## Intent

> "Agent Silla has webhooks, but how can I have a webhook in my Slack and have it be triggered like an agent on my computer? A lot of my context is on this computer in different sessions. I want to tag an agent and give it a project name, and it can check the sessions and make a reply there. How can we enable that within agents-cli?" — the user.

Restated: a Slack message like `@agents AGI: rebase my open PR and check CI` should reach the agent **on your machine** that already holds the AGI project's context, let it act with that context, and answer back **in the Slack thread** — no SSH, no terminal, from your phone if you want.

## Current architecture — inbound exists, but only for GitHub/Linear, and Slack is outbound-only

The `agents-daemon` already runs a signed webhook receiver and a dispatch path. It is 90% of what you asked for; it is simply blind to Slack in three specific places, and the reply direction is one-way.

<div class="artifact-figure-diagram">
<svg viewBox="0 0 900 360" role="img" aria-label="Today: GitHub and Linear reach the daemon receiver and dispatch an agent; Slack has no inbound path and only receives outbound sends" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#5a6b76"/></marker>
    <marker id="arg" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#a3e635"/></marker>
    <marker id="arr" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#f87171"/></marker>
  </defs>

  <text x="20" y="24" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#a3e635">WORKS — GitHub / Linear inbound</text>
  <rect x="20" y="36" width="150" height="44" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="30" y="58" font-family="JetBrains Mono, monospace" font-size="12" fill="#d7e0e6">GitHub · Linear</text>
  <text x="30" y="73" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">signed POST</text>
  <line x1="170" y1="58" x2="236" y2="58" stroke="#a3e635" stroke-width="1.5" marker-end="url(#arg)"/>
  <rect x="236" y="30" width="240" height="58" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="246" y="52" font-family="JetBrains Mono, monospace" font-size="11" fill="#d7e0e6">agents-daemon :8787</text>
  <text x="246" y="68" font-family="JetBrains Mono, monospace" font-size="11" fill="#d7e0e6">/hooks/(github|linear)</text>
  <text x="246" y="82" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">HMAC verify · webhook.js:407,255</text>
  <line x1="476" y1="58" x2="540" y2="58" stroke="#a3e635" stroke-width="1.5" marker-end="url(#arg)"/>
  <rect x="540" y="30" width="340" height="58" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="550" y="52" font-family="JetBrains Mono, monospace" font-size="11" fill="#d7e0e6">match routine/handler → executeJobDetached</text>
  <text x="550" y="68" font-family="JetBrains Mono, monospace" font-size="11" fill="#d7e0e6">→ claude -p &lt;prompt&gt;</text>
  <text x="550" y="82" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">handlers.js:347 · runner.js:1727</text>

  <text x="20" y="150" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#f87171">MISSING — Slack inbound (receiver 404s any path but github/linear)</text>
  <rect x="20" y="162" width="150" height="44" rx="8" fill="#16120a" stroke="#f87171" stroke-width="1.5"/>
  <text x="30" y="184" font-family="JetBrains Mono, monospace" font-size="12" fill="#d7e0e6">Slack event</text>
  <text x="30" y="199" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">mention / slash</text>
  <line x1="170" y1="184" x2="236" y2="184" stroke="#f87171" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#arr)"/>
  <rect x="236" y="164" width="240" height="42" rx="8" fill="#16120a" stroke="#f87171" stroke-width="1.5"/>
  <text x="246" y="182" font-family="JetBrains Mono, monospace" font-size="11" fill="#d7e0e6">POST /hooks/slack</text>
  <text x="246" y="198" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#f87171">404 — sourceFromPath rejects it</text>

  <text x="20" y="264" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#e0b341">ONE-WAY — Slack outbound only</text>
  <rect x="236" y="278" width="240" height="44" rx="8" fill="#191307" stroke="#e0b341" stroke-width="1.5"/>
  <text x="246" y="300" font-family="JetBrains Mono, monospace" font-size="11" fill="#d7e0e6">agents send --channel slack</text>
  <text x="246" y="315" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">via rush gateway · rush.js:11 (send-only)</text>
  <line x1="476" y1="300" x2="640" y2="300" stroke="#e0b341" stroke-width="1.5" marker-end="url(#ar)"/>
  <rect x="640" y="278" width="240" height="44" rx="8" fill="#191307" stroke="#e0b341" stroke-width="1.5"/>
  <text x="650" y="304" font-family="JetBrains Mono, monospace" font-size="12" fill="#d7e0e6">Slack (message arrives)</text>
</svg>
</div>

The three blind spots, each a named file:line:

| What is blind | Where | Fix shape |
| --- | --- | --- |
| Path regex accepts only `github\|linear` | `lib/triggers/webhook.js:407` (`sourceFromPath`) | add `slack` to the alternation |
| No Slack signature verifier | `lib/triggers/webhook.js:255,260` (`verifyGithubSignature` / `verifyLinearSignature`) | add `verifySlackSignature` (`v0:` HMAC) + URL-verification echo |
| Secret resolution knows 2 keys | `lib/daemon-webhooks.js:111` (`GITHUB_/LINEAR_WEBHOOK_SECRET`) | add `SLACK_SIGNING_SECRET` (+ `SLACK_BOT_TOKEN`) |
| Dispatch matcher knows 2 sources | `lib/triggers/webhook.js:182` / `handlers.js:206` (`github_event` / `linear_event`) | add a `slack_event` source |
| Reply is one-way | `lib/channels/providers/rush.js:11` (send only) | thread the reply with `{channel, thread_ts}` |

## Behavior — current vs proposed

<div class="artifact-behavior">
  <div class="artifact-panel" data-state="current" data-evidence="mockup">
    <h4>Current — you must be at the machine</h4>
    <svg viewBox="0 0 460 250" role="img" aria-label="A terminal on zion: SSH in, list sessions for a project, resume one by hand" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="460" height="250" fill="#0d1117"/>
      <rect x="0" y="0" width="460" height="22" fill="#161b22"/>
      <circle cx="14" cy="11" r="4" fill="#ff5f56"/><circle cx="28" cy="11" r="4" fill="#ffbd2e"/><circle cx="42" cy="11" r="4" fill="#27c93f"/>
      <text x="120" y="15" fill="#8b98a5" font-family="Inter, system-ui, sans-serif" font-size="11">zion — you, at the desk</text>
      <text x="12" y="52" fill="#7ee787" font-family="JetBrains Mono, monospace" font-size="11">$ agents sessions -p AGI --active</text>
      <text x="12" y="72" fill="#adbac7" font-family="JetBrains Mono, monospace" font-size="11">71bb3b3b  claude  AGI  ~/src/agents-cli  idle 9m</text>
      <text x="12" y="92" fill="#adbac7" font-family="JetBrains Mono, monospace" font-size="11">a1c40f22  codex   AGI  …/apps/cli        idle 40m</text>
      <text x="12" y="120" fill="#7ee787" font-family="JetBrains Mono, monospace" font-size="11">$ agents run --resume 71bb3b3b \</text>
      <text x="12" y="138" fill="#adbac7" font-family="JetBrains Mono, monospace" font-size="11">    "rebase my open PR and check CI"</text>
      <text x="12" y="176" fill="#f0883e" font-family="JetBrains Mono, monospace" font-size="11">↑ requires: SSH/terminal on the box.</text>
      <text x="12" y="194" fill="#f0883e" font-family="JetBrains Mono, monospace" font-size="11">  From Slack / your phone: no path.</text>
    </svg>
  </div>
  <div class="artifact-panel" data-state="proposed" data-evidence="mockup">
    <h4>Proposed — tag @agents in Slack, it replies in-thread</h4>
    <svg viewBox="0 0 460 250" role="img" aria-label="A Slack thread: you tag agents with a project, get a working ack, then a threaded reply from the agent" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="460" height="250" fill="#ffffff"/>
      <rect x="0" y="0" width="460" height="24" fill="#3f0e40"/>
      <text x="12" y="16" fill="#e8d7ea" font-family="Inter, system-ui, sans-serif" font-size="11" font-weight="bold"># agi-ops</text>
      <circle cx="24" cy="46" r="9" fill="#611f69"/>
      <text x="42" y="43" fill="#1d1c1d" font-family="Inter, system-ui, sans-serif" font-size="11" font-weight="bold">you</text>
      <text x="42" y="59" fill="#1d1c1d" font-family="Inter, system-ui, sans-serif" font-size="11.5"><tspan fill="#1264a3">@agents</tspan> AGI: rebase my open PR and check CI</text>
      <rect x="42" y="74" width="360" height="1" fill="#e8e8e8"/>
      <rect x="15" y="84" width="18" height="18" rx="4" fill="#2eb67d"/>
      <text x="20" y="97" fill="#fff" font-family="JetBrains Mono, monospace" font-size="10">◆</text>
      <text x="42" y="90" fill="#1d1c1d" font-family="Inter, system-ui, sans-serif" font-size="11" font-weight="bold">agents <tspan fill="#616061" font-weight="normal">APP</tspan></text>
      <text x="42" y="106" fill="#2eb67d" font-family="Inter, system-ui, sans-serif" font-size="11">🟢 claude on AGI · session 71bb3b3b · working…</text>
      <rect x="42" y="118" width="360" height="1" fill="#f0f0f0"/>
      <text x="42" y="140" fill="#1d1c1d" font-family="Inter, system-ui, sans-serif" font-size="11">Rebased <tspan fill="#1264a3">#2668</tspan> onto main (2 conflicts resolved),</text>
      <text x="42" y="156" fill="#1d1c1d" font-family="Inter, system-ui, sans-serif" font-size="11">pushed, CI is green. ✅</text>
      <text x="42" y="176" fill="#616061" font-family="Inter, system-ui, sans-serif" font-size="10">replied in-thread · thread_ts 171…842 · ran on zion</text>
      <rect x="15" y="206" width="430" height="30" rx="6" fill="#fff" stroke="#ddd"/>
      <text x="28" y="225" fill="#8d8d8d" font-family="Inter, system-ui, sans-serif" font-size="11">Reply in thread…</text>
    </svg>
  </div>
</div>

The proposed path, step by step (each hop uses a primitive that already exists):

<div class="artifact-figure-diagram">
<svg viewBox="0 0 900 250" role="img" aria-label="Slack event flows through Funnel to the daemon slack hook, which routes to a local session and replies in-thread" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#2eb67d"/></marker></defs>
  <rect x="14" y="40" width="118" height="52" rx="8" fill="#0f1613" stroke="#2eb67d" stroke-width="1.5"/>
  <text x="24" y="62" font-family="JetBrains Mono, monospace" font-size="11" fill="#d7e0e6">Slack</text>
  <text x="24" y="78" font-family="Inter, system-ui, sans-serif" font-size="9.5" fill="#8a8a8a">mention/slash</text>
  <line x1="132" y1="66" x2="176" y2="66" stroke="#2eb67d" stroke-width="1.5" marker-end="url(#a2)"/>
  <rect x="176" y="40" width="120" height="52" rx="8" fill="#0f1613" stroke="#2eb67d" stroke-width="1.5"/>
  <text x="186" y="60" font-family="JetBrains Mono, monospace" font-size="11" fill="#d7e0e6">TS Funnel</text>
  <text x="186" y="76" font-family="Inter, system-ui, sans-serif" font-size="9.5" fill="#8a8a8a">:443 → :8787</text>
  <line x1="296" y1="66" x2="340" y2="66" stroke="#2eb67d" stroke-width="1.5" marker-end="url(#a2)"/>
  <rect x="340" y="34" width="200" height="64" rx="8" fill="#0f1613" stroke="#2eb67d" stroke-width="1.5"/>
  <text x="350" y="54" font-family="JetBrains Mono, monospace" font-size="11" fill="#d7e0e6">/hooks/slack</text>
  <text x="350" y="70" font-family="Inter, system-ui, sans-serif" font-size="9.5" fill="#8a8a8a">verifySlackSignature</text>
  <text x="350" y="84" font-family="Inter, system-ui, sans-serif" font-size="9.5" fill="#8a8a8a">ack ≤3s · parse agent/project/prompt</text>
  <line x1="540" y1="66" x2="584" y2="66" stroke="#2eb67d" stroke-width="1.5" marker-end="url(#a2)"/>
  <rect x="584" y="26" width="300" height="80" rx="8" fill="#0f1613" stroke="#2eb67d" stroke-width="1.5"/>
  <text x="594" y="46" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#a3e635">resolveProjectSession(AGI)</text>
  <text x="594" y="63" font-family="JetBrains Mono, monospace" font-size="10" fill="#d7e0e6">alive → agents message &lt;id&gt;</text>
  <text x="594" y="78" font-family="JetBrains Mono, monospace" font-size="10" fill="#d7e0e6">parked → run --resume &lt;id&gt;</text>
  <text x="594" y="93" font-family="JetBrains Mono, monospace" font-size="10" fill="#d7e0e6">none → run &lt;agent&gt; -P AGI</text>
  <path d="M734 106 Q734 150 500 150 Q200 150 200 108" fill="none" stroke="#2eb67d" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#a2)"/>
  <text x="360" y="168" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">on completion → reply into the same thread (chat.postMessage thread_ts / agents send --channel slack --thread)</text>
</svg>
</div>

## The flow, message by message

Left is what you see in the Slack thread; right is the primitive that fires on your box at each tick. Nothing on the right is new plumbing — every step is a command that already ships.

<div class="artifact-figure-diagram">
<svg viewBox="0 0 920 496" role="img" aria-label="Message-by-message flow: each Slack message on the left maps to an existing CLI command on your box on the right" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dn" markerWidth="10" markerHeight="10" refX="5" refY="8" orient="auto"><path d="M1,1 L5,8 L9,1" fill="none" stroke="#3a5f4a" stroke-width="1.6"/></marker>
  </defs>
  <text x="30" y="24" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9fb2bd" font-weight="bold">IN SLACK — #agi-ops thread</text>
  <text x="500" y="24" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#9fb2bd" font-weight="bold">ON YOUR BOX (zion)</text>

  <!-- Row 1: you post -->
  <rect x="30" y="36" width="430" height="72" rx="8" fill="#ffffff" stroke="#e2e2e2" stroke-width="1"/>
  <rect x="30" y="36" width="5" height="72" fill="#4a154b"/>
  <circle cx="52" cy="60" r="8" fill="#611f69"/>
  <text x="70" y="58" font-family="Inter, system-ui, sans-serif" font-size="11" font-weight="bold" fill="#1d1c1d">you</text>
  <text x="112" y="58" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">10:42</text>
  <text x="70" y="80" font-family="Inter, system-ui, sans-serif" font-size="11.5" fill="#1d1c1d"><tspan fill="#1264a3">@agents</tspan> AGI: rebase my open PR onto main and check CI</text>
  <text x="70" y="97" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">(or the slash form: /agents AGI rebase my open PR and check CI)</text>
  <rect x="500" y="36" width="400" height="72" rx="8" fill="#0f1613" stroke="#2eb67d" stroke-width="1.3"/>
  <text x="514" y="58" font-family="JetBrains Mono, monospace" font-size="11" fill="#d7e0e6">POST /hooks/slack</text>
  <text x="514" y="76" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">verifySlackSignature → ack 200</text>
  <text x="514" y="94" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">within 3s, before any work · webhook.js:407,255</text>
  <line x1="700" y1="108" x2="700" y2="134" stroke="#3a5f4a" stroke-width="1.4" marker-end="url(#dn)"/>

  <!-- Row 2: ack -->
  <rect x="30" y="132" width="430" height="66" rx="8" fill="#ffffff" stroke="#e2e2e2" stroke-width="1"/>
  <rect x="46" y="146" width="18" height="18" rx="4" fill="#2eb67d"/>
  <text x="51" y="159" font-family="JetBrains Mono, monospace" font-size="10" fill="#fff">◆</text>
  <text x="72" y="152" font-family="Inter, system-ui, sans-serif" font-size="11" font-weight="bold" fill="#1d1c1d">agents <tspan font-weight="normal" fill="#8a8a8a">APP · 10:42</tspan></text>
  <circle cx="76" cy="176" r="4" fill="#2eb67d"/>
  <text x="88" y="180" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#1d1c1d">claude on AGI · session 71bb3b3b · working…</text>
  <rect x="500" y="130" width="400" height="70" rx="8" fill="#0f1613" stroke="#2eb67d" stroke-width="1.3"/>
  <text x="514" y="150" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#a3e635">resolveProjectSession('AGI')</text>
  <text x="514" y="170" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#d7e0e6">agents run --resume 71bb3b3b</text>
  <text x="514" y="186" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#d7e0e6">   "rebase my open PR…" --mode auto</text>
  <line x1="700" y1="200" x2="700" y2="224" stroke="#3a5f4a" stroke-width="1.4" marker-end="url(#dn)"/>

  <!-- Row 3: progress -->
  <rect x="30" y="222" width="430" height="60" rx="8" fill="#ffffff" stroke="#e2e2e2" stroke-width="1"/>
  <rect x="46" y="234" width="18" height="18" rx="4" fill="#2eb67d"/>
  <text x="51" y="247" font-family="JetBrains Mono, monospace" font-size="10" fill="#fff">◆</text>
  <text x="72" y="240" font-family="Inter, system-ui, sans-serif" font-size="10.5" fill="#8a8a8a">agents APP · 10:43 · in thread</text>
  <text x="72" y="262" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#1d1c1d">Rebased <tspan fill="#1264a3">#2668</tspan> onto main — 2 conflicts resolved, pushed.</text>
  <rect x="500" y="220" width="400" height="64" rx="8" fill="#0f1613" stroke="#5a6b76" stroke-width="1.3"/>
  <text x="514" y="242" font-family="Inter, system-ui, sans-serif" font-size="10.5" fill="#d7e0e6">the resumed session already holds your</text>
  <text x="514" y="260" font-family="Inter, system-ui, sans-serif" font-size="10.5" fill="#d7e0e6">context: the repo, the open PR, prior turns</text>
  <text x="514" y="276" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">this is the whole point — not a fresh chatbot</text>
  <line x1="700" y1="284" x2="700" y2="308" stroke="#3a5f4a" stroke-width="1.4" marker-end="url(#dn)"/>

  <!-- Row 4: final reply -->
  <rect x="30" y="306" width="430" height="70" rx="8" fill="#ffffff" stroke="#e2e2e2" stroke-width="1"/>
  <rect x="46" y="320" width="18" height="18" rx="4" fill="#2eb67d"/>
  <text x="51" y="333" font-family="JetBrains Mono, monospace" font-size="10" fill="#fff">◆</text>
  <text x="72" y="326" font-family="Inter, system-ui, sans-serif" font-size="10.5" fill="#8a8a8a">agents APP · 10:45 · in thread</text>
  <text x="72" y="348" font-family="Inter, system-ui, sans-serif" font-size="11.5" fill="#1d1c1d">CI is green (3m 12s). PR ready to merge. ✅</text>
  <text x="72" y="366" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">reply lands in the same thread you started</text>
  <rect x="500" y="304" width="400" height="72" rx="8" fill="#0f1613" stroke="#2eb67d" stroke-width="1.3"/>
  <text x="514" y="326" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#a3e635">on completion → reply to the thread</text>
  <text x="514" y="346" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#d7e0e6">agents send --channel slack</text>
  <text x="514" y="362" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#d7e0e6">   --to C0AGI --thread 171…842</text>

  <!-- reply loop back arrow -->
  <path d="M500 340 Q470 340 470 210 Q470 100 462 84" fill="none" stroke="#2eb67d" stroke-width="1.3" stroke-dasharray="5 4"/>
  <text x="392" y="200" font-family="Inter, system-ui, sans-serif" font-size="9.5" fill="#2eb67d" transform="rotate(-90 392 200)">reply threads back</text>

  <!-- time rail -->
  <text x="10" y="76" font-family="JetBrains Mono, monospace" font-size="9" fill="#5a6b76">t0</text>
  <text x="10" y="172" font-family="JetBrains Mono, monospace" font-size="9" fill="#5a6b76">+1s</text>
  <text x="10" y="256" font-family="JetBrains Mono, monospace" font-size="9" fill="#5a6b76">+60s</text>
  <text x="10" y="348" font-family="JetBrains Mono, monospace" font-size="9" fill="#5a6b76">+3m</text>
</svg>
</div>

<div class="artifact-callout">
The two things that make the reply useful, both visible above: the agent answering <strong>is the
session that already had your context</strong> (row 3, right), and its answer <strong>lands back in
the thread you started</strong> (row 4) — which needs the bot-token reply, because a 3-minute run
outlives a <code>response_url</code>. That is fork #1.
</div>

## One-time setup flow

You do this once per Slack workspace; after that every message just flows.

<div class="artifact-figure-diagram">
<svg viewBox="0 0 900 132" role="img" aria-label="One-time setup: create secrets bundle, declare the receiver, expose via Funnel, point the Slack app at the URL" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="s1" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#5a6b76"/></marker></defs>
  <rect x="14" y="40" width="196" height="60" rx="8" fill="#0f1613" stroke="#5a6b76" stroke-width="1.3"/>
  <text x="24" y="60" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#a3e635">1 · secrets bundle</text>
  <text x="24" y="78" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#d7e0e6">agents secrets add slack</text>
  <text x="24" y="92" font-family="Inter, system-ui, sans-serif" font-size="9" fill="#8a8a8a">SIGNING_SECRET · BOT_TOKEN</text>
  <line x1="210" y1="70" x2="238" y2="70" stroke="#5a6b76" stroke-width="1.4" marker-end="url(#s1)"/>
  <rect x="238" y="40" width="196" height="60" rx="8" fill="#0f1613" stroke="#5a6b76" stroke-width="1.3"/>
  <text x="248" y="60" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#a3e635">2 · declare receiver</text>
  <text x="248" y="78" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#d7e0e6">daemon/webhooks.yaml</text>
  <text x="248" y="92" font-family="Inter, system-ui, sans-serif" font-size="9" fill="#8a8a8a">source: slack · publicPort 443</text>
  <line x1="434" y1="70" x2="462" y2="70" stroke="#5a6b76" stroke-width="1.4" marker-end="url(#s1)"/>
  <rect x="462" y="40" width="196" height="60" rx="8" fill="#0f1613" stroke="#5a6b76" stroke-width="1.3"/>
  <text x="472" y="60" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#a3e635">3 · expose (Funnel)</text>
  <text x="472" y="78" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#d7e0e6">zion.&lt;tailnet&gt;.ts.net</text>
  <text x="472" y="92" font-family="Inter, system-ui, sans-serif" font-size="9" fill="#8a8a8a">/hooks/slack · already supported</text>
  <line x1="658" y1="70" x2="686" y2="70" stroke="#5a6b76" stroke-width="1.4" marker-end="url(#s1)"/>
  <rect x="686" y="40" width="200" height="60" rx="8" fill="#120f16" stroke="#611f69" stroke-width="1.3"/>
  <text x="696" y="60" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c98fd0">4 · Slack app</text>
  <text x="696" y="78" font-family="Inter, system-ui, sans-serif" font-size="9.5" fill="#d7e0e6">slash /agents + app_mention</text>
  <text x="696" y="92" font-family="Inter, system-ui, sans-serif" font-size="9" fill="#8a8a8a">Request URL → the Funnel</text>
</svg>
</div>

## Purpose

Your context is scattered across live and parked sessions on your boxes. The value of reaching it from Slack is not "a chatbot in Slack" — it is that the agent answering already **is** the session that has your repo, your open PR, your prior turns. The bridge's whole job is: take a Slack line, find the right existing session, hand it the prompt, and route the answer back to where you asked. Everything below reuses primitives that already ship; the net-new surface is one inbound source and one threaded reply.

## Proposed Changes

**1. Accept `slack` at the receiver** — `lib/triggers/webhook.js` (`sourceFromPath`, `:407`). Slack posts `application/x-www-form-urlencoded` (slash) or `application/json` (events); both land on one path.

```diff
-function sourceFromPath(pathname) {
-  const m = /^\/hooks\/(github|linear)\/?$/.exec(pathname);
-  return m ? m[1] : null;
-}
+function sourceFromPath(pathname) {
+  const m = /^\/hooks\/(github|linear|slack)\/?$/.exec(pathname);
+  return m ? m[1] : null;
+}
```

**2. Verify the Slack signature + answer the one-time URL challenge** — new `verifySlackSignature` beside the GitHub/Linear verifiers (`:255`). Slack signs `v0:{timestamp}:{rawBody}` with the signing secret; reject a timestamp older than 5 minutes (replay guard), then constant-time compare `X-Slack-Signature`.

```diff
+// Slack: basestring = `v0:${ts}:${rawBody}`, HMAC-SHA256 with signing secret,
+// hex, prefixed `v0=`. Compare against X-Slack-Signature; ts must be < 5 min old.
+function verifySlackSignature(secret, headers, rawBody) {
+  const ts = headers['x-slack-request-timestamp'];
+  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
+  const base = `v0:${ts}:${rawBody}`;
+  const mac = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
+  return timingSafeEqual(mac, headers['x-slack-signature'] || '');
+}
```

The handler answers Slack's install-time `type: url_verification` by echoing `challenge`, and acks every real event with **HTTP 200 within 3 s** (Slack retries otherwise) before doing any work — the receiver already uses this ack-then-dispatch shape for GitHub/Linear (`webhook.js:604`).

**3. Resolve the Slack secret(s)** — `lib/daemon-webhooks.js` (`:111`), same table that already resolves the GitHub/Linear secrets from a bundle.

```diff
   const wantGithub  = source === 'github';
   const wantLinear  = source === 'linear';
+  const wantSlack   = source === 'slack';
   // …
+  if (wantSlack) {
+    signingSecret = bundle.SLACK_SIGNING_SECRET;   // verify inbound
+    botToken      = bundle.SLACK_BOT_TOKEN;         // post the reply
+  }
```

**4. A `slack_event` dispatch source + a project→session router** — new `lib/triggers/slack.js`, matched the same way `github_event`/`linear_event` are (`webhook.js:182`, `handlers.js:206`). It parses the message, resolves the project's session with primitives that already exist, and dispatches:

```diff
+// parse: optional leading agent token, PROJECT: prefix (or channel→project map), rest = prompt
+const { agent = 'claude', project, prompt, channel, thread_ts } = parseSlackTrigger(payload);
+
+// find the session that holds this project's context (FTS5 + project-key fold)
+const sess = await resolveProjectSession(project);   // reuses getActiveSessions() + project-key.js
+
+if (sess?.alive)       await run('agents', ['message', sess.id, prompt]);              // steer live
+else if (sess)         await run('agents', ['run', '--resume', sess.id, prompt,        // resume parked
+                                            '--mode', 'auto']);
+else                   await run('agents', ['run', agent, prompt, '-P', project,       // fresh, in-project
+                                            '--mode', 'auto', '--name', `slack-${thread_ts}`]);
```

**5. Thread the reply back into Slack** — carry `{channel, thread_ts}` through the dispatch and, on completion, post to that thread. Preferred path is a bot-token `chat.postMessage`; kept in the outbound channel layer so replies stay unified (`lib/channels/providers/rush.js` / a small `slack.js` provider), reachable as:

```diff
+agents send --channel slack --to <channel_id> --thread <thread_ts> --text "<agent result>"
```

**6. Turn the source on (config, not code)** — declare the receiver and expose it. This is the only per-machine step.

```yaml
# ~/.agents/daemon/webhooks.yaml
receivers:
  - source: slack
    bundle: slack           # holds SLACK_SIGNING_SECRET + SLACK_BOT_TOKEN
    port: 8787
    publicPort: 443         # Tailscale Funnel — Slack posts to the public URL
```

## Public Interface

| Surface | New / changed | Notes |
| --- | --- | --- |
| Receiver path | `POST /hooks/slack` | slash (form) + Events API (JSON) on one path |
| Secrets bundle | `agents secrets add slack SLACK_SIGNING_SECRET …` and `SLACK_BOT_TOKEN …` | verify inbound / post reply |
| Daemon config | `slack` receiver stanza in `~/.agents/daemon/webhooks.yaml` | `publicPort: 443` for Funnel |
| Dispatch rule | `~/.agents/webhooks/slack-agent.yml` handler (`trigger: { slack_event: … }`, action `run`) | shipped example |
| Outbound send | `agents send --channel slack --to <channel> --thread <ts>` | `--thread` is the one new flag |
| Slack app | slash `/agents`, `app_mention` event, Request URL = `https://<box>.<tailnet>.ts.net/hooks/slack` | manifest committed under `docs/` |

Message grammar (what you type in Slack):

```text
/agents AGI rebase my open PR and check CI          # slash, project = AGI
@agents AGI: rebase my open PR and check CI          # mention, project = AGI
@agents codex AGI: run the perf bench on db.ts       # explicit agent = codex
@agents rebase my open PR                            # project inferred from #channel map
```

## Plan

- [ ] Worktree off `origin/main` (this checkout is 5k+ commits behind and ships only `dist/` — implement against `apps/cli/src`)
- [ ] `sourceFromPath` accepts `slack`; `verifySlackSignature` + `url_verification` echo; 200-ack ≤3s
- [ ] `SLACK_SIGNING_SECRET` / `SLACK_BOT_TOKEN` resolution in `daemon-webhooks`
- [ ] `lib/triggers/slack.js`: `parseSlackTrigger` + `resolveProjectSession` + dispatch (message / resume / fresh run)
- [ ] `--thread <ts>` on `agents send`; bot-token `chat.postMessage` reply in the outbound slack provider
- [ ] Ship `slack-agent.yml` handler + Slack app manifest + `agents secrets` doc
- [ ] Tests: signature verify (good/stale/forged fails closed), parse grammar, project→session resolution, url_verification echo
- [ ] Wire the real Slack app, Funnel on zion, drive a real `/agents AGI …` end-to-end and screenshot the in-thread reply
- [ ] CHANGELOG + docs (webhooks/README, a Slack setup doc); open PR with the screenshot

## Validation

```bash
# 1. Local signature + routing, no Slack account needed — forge a signed request:
TS=$(date +%s); BODY='payload=%7B%22type%22%3A%22url_verification%22%2C%22challenge%22%3A%22abc%22%7D'
SIG="v0=$(printf "v0:$TS:$BODY" | openssl dgst -sha256 -hmac "$SLACK_SIGNING_SECRET" | awk '{print $2}')"
curl -s -XPOST localhost:8787/hooks/slack -H "X-Slack-Request-Timestamp: $TS" \
  -H "X-Slack-Signature: $SIG" -H 'content-type: application/x-www-form-urlencoded' --data "$BODY"
# expect: abc   (url_verification echo)

# 2. A forged/absent signature must 401 (fail closed).
# 3. End-to-end: from Slack, "/agents AGI say hello" → threaded reply from the agent on zion.
```

<div class="artifact-callout">
The load-bearing insight: this is <strong>not a new server</strong>. The daemon, the signed
receiver, the Funnel, the dispatch-to-agent path, session search, resume, and message-into-session
all already ship. The feature is <strong>one inbound source</strong> (path + verifier + secret),
<strong>one router</strong> (project → existing session), and <strong>one threaded reply</strong>.
Slack was already a first-class <em>outbound</em> channel — we are closing the loop.
</div>

## Risks

| Risk | Mitigation |
| --- | --- |
| Slack's 3-second ack vs a long agent run | Ack 200 immediately; do all work after, reply later in-thread — needs the **bot-token** reply, not `response_url` (30-min cap). This is fork #1. |
| Public ingress on your box | Funnel exposes only `/hooks/slack`; every request is HMAC-verified and replay-guarded (5-min window). Reject → 401. Same posture the GitHub/Linear receiver already runs. |
| Wrong session picked for a project | `resolveProjectSession` prefers the most-recent *active* session in that project (`project-key.js` fold); the ack line names the session id so a wrong pick is visible and correctable. |
| Context lives on a different box than the receiver | v1 pins to zion (fork #3). Sessions are machine-stamped (`session.machine`); v2 SSH-dispatches to the owning box. Named as a follow-up, not folded into v1 "done". |
| Bot token scope creep | Reply needs only `chat:write`; slash needs `commands`; mention needs `app_mentions:read`. No `channels:history`. |
| Secret handling | `SLACK_SIGNING_SECRET` / `SLACK_BOT_TOKEN` live in an `agents secrets` bundle (keychain-backed), never env or config — resolved headlessly by the daemon. |

## Tracking

Open a RUSH ticket under **AGI** (this is a new inbound surface for the CLI, adjacent to the existing webhook receiver). Link this plan and the PR both ways. Suggested split: **PR 1** inbound source + signature + router (the four `lib/` changes), **PR 2** threaded reply + shipped Slack app manifest + docs.
