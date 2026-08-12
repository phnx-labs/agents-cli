---
kind: report
title: QM (Y Combinator) vs agent-rooms — two answers to "multiplayer agents"
surface: internal
human: redacted
host: redacted
session: redacted
---

# QM (Y Combinator) vs agent-rooms — two answers to "multiplayer agents"

## Summary

Y Combinator's QM (open-sourced July 31, 2026) and the agent-rooms demo (built Aug 11 on Cloudflare Durable Objects) both call themselves multiplayer agent systems, and they mean different things by it. QM is a ~100k-LOC org harness — one agent for a whole company, with identity, per-scope sandboxes, policy postures, and Postgres durability; it took a model key, a Docker sandbox image, and four local processes to reach its first verified turn on a dev Mac. agent-rooms is a 1,478-LOC live canvas — humans and the agent co-editing one CRDT document with visible cursors, deployed keyless in one `wrangler deploy`. QM has no live co-editing or agent presence; agent-rooms has no identity, policy, or durable execution. Both were run and verified during this comparison.

## Focus for review

- QM was cloned, updated to latest `origin/main` (3cb5623, Aug 12), booted locally on a dev Mac, and driven end-to-end: a live Claude Code turn executed `uname -a; whoami` inside its Docker sandbox.
- The two systems use the word "multiplayer" for different things: QM means **one org agent, many people, scoped state**; agent-rooms means **many people and the agent live-editing one document**.
- Neither subsumes the other. QM has no live co-editing, presence, or agent-as-visible-peer; agent-rooms has no identity, policy, sandbox, or durability beyond one Durable Object.

## Intent

Understand the current landscape: run the QM release from Y Combinator locally and see how it differs from the multiplayer agent-rooms demo built on Cloudflare Durable Objects (session `2838ac7c`, deployed at agent-rooms.muqsitnawaz.workers.dev).

## What QM is

QM ("Quartermaster") is the multiplayer agent harness YC open-sourced on **July 31, 2026** (MIT, [yc-software/qm](https://github.com/yc-software/qm), 13,155 stars as of Aug 12). YC says it runs the company on it — accounting, legal, events, engineering. It runs in Slack and on the web. Each person and each room gets scoped memory, files, keychain view, permissions, crons, web apps, and a durable sandbox. Four harness drivers share one core: Pi, OpenCode, Codex, Claude Code.

Scale on disk: ~77k lines of TypeScript in `src/`, ~23k more in `plugins/` (web UI, admin, portal, auth, onboarding), 28 runtime dependencies. Fastify HTTP core on Node, Postgres for all durable state, Bolt for Slack, Lit + Vite for the web UI.

## Running it locally — what it took, verified

The repo carries a real local dev path (`npm run dev-instance`) that production docs do not advertise (deployment assumes Fly.io or AWS plus Postgres). Local boot on a dev Mac:

```bash
git worktree add .agents/worktrees/run-latest origin/main   # 3cb5623
npm install
HARNESS=claude CLAUDE_CODE_OAUTH_TOKEN=<token> \
  bash scripts/dev-instance.sh up --no-slack --sandbox local
npm run sandbox:local:build                                  # 446MB Docker image
```

The dev instance self-hosts everything: it starts a `qm-dev-postgres` Docker container (port 55432), then four Node processes — core (8081), web (8097), admin (8113), portal (8129) — behind a portal that owns sign-in. Boot output:

```
[ok] dev instance up -- slot pool1 (browser only -- Slack off)
   portal : http://localhost:8129  -> prod-style front door
   core   : http://localhost:8081  (org=acme, session_store=postgres, run_store=postgres)
```

Two gates before the first turn:

| Gate | What cleared it |
| --- | --- |
| Web UI hard-redirects to `/admin/onboarding` until a model-provider key is saved (`plugins/portal/src/index.ts:1058`) | Saved an Anthropic API key in the admin onboarding form; portal validated it and marked the provider Ready |
| `execute` turns fail without the sandbox image | `npm run sandbox:local:build` (Debian 12 base, 446MB) |

Then a real turn, end to end — the agent ran `uname -a; whoami` in its sandbox and answered: container `54720281605f`, Debian 12 inside, running as `root`, persistent workspace at `/root/workspace`.

- [QM web app — chats, files, crons, keychain, memory, skills; Opus 5 + Claude Code pickers](https://share.agents-cli.sh/muqsitnawaz/agents-cli-qm-web-app-f9caa6e3db3bb49c)
- [The sandbox turn result](https://share.agents-cli.sh/muqsitnawaz/agents-cli-qm-sandbox-result-aab62bbb9c52cb01)
- [Admin onboarding after the key validated](https://share.agents-cli.sh/muqsitnawaz/agents-cli-qm-onboarding-ready-8ce121f4b572b535)

## What agent-rooms is

The demo from session `2838ac7c` (Aug 11): "Discord for agents." One Cloudflare Durable Object per room is simultaneously the CRDT server (Yjs), the presence server, the transcript store, and the agent's runtime. Humans and the agent co-edit one shared brief with live named cursors; the agent is a visible peer — square avatar, a caret parked on the line it is reading, typing its output into the document in front of everyone. A bridge (`bridge/bridge.ts`) joins the same WebSocket as a human and pipes a real local `agents run claude --json` session into the room, relaying steers back into the live session.

Scale on disk: **1,478 lines** total. Zero infrastructure: no database, no socket server, no queue, no key required (Workers AI `gpt-oss-120b` is the keyless default; binding `ANTHROPIC_API_KEY` upgrades the same room to `claude-sonnet-5`). Deploy is `bunx wrangler deploy`. Live at [agent-rooms.muqsitnawaz.workers.dev](https://agent-rooms.muqsitnawaz.workers.dev) — [fresh room opened during this comparison](https://share.agents-cli.sh/muqsitnawaz/agents-cli-agent-rooms-live-749606dad1c53d4f).

## Architecture, side by side

<figure>
<svg viewBox="0 0 920 430" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QM centralized core versus agent-rooms single Durable Object" font-family="ui-monospace,monospace">
  <defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6" fill="none" stroke="#888"/></marker></defs>

  <text x="20" y="28" font-size="14" font-weight="700" fill="currentColor">QM — one core, many scopes</text>
  <rect x="20" y="48" width="180" height="54" rx="6" fill="rgba(99,102,241,.12)" stroke="#6366f1" stroke-width="1.2"/>
  <text x="32" y="70" font-size="13" font-weight="600" fill="currentColor">Portal + Web UI</text>
  <text x="32" y="88" font-size="11" fill="#888">auth, admin, onboarding</text>
  <rect x="20" y="130" width="180" height="54" rx="6" fill="rgba(99,102,241,.12)" stroke="#6366f1" stroke-width="1.2"/>
  <text x="32" y="152" font-size="13" font-weight="600" fill="currentColor">Slack plugin</text>
  <text x="32" y="170" font-size="11" fill="#888">channels, DMs, projects</text>
  <rect x="250" y="82" width="190" height="72" rx="6" fill="rgba(99,102,241,.12)" stroke="#6366f1" stroke-width="1.2"/>
  <text x="262" y="106" font-size="13" font-weight="600" fill="currentColor">Headless core</text>
  <text x="262" y="124" font-size="11" fill="#888">identity · policy · scheduler</text>
  <text x="262" y="140" font-size="11" fill="#888">harness drivers ×4</text>
  <rect x="250" y="190" width="190" height="46" rx="6" fill="none" stroke="#888" stroke-width="1.2"/>
  <text x="262" y="210" font-size="13" font-weight="600" fill="currentColor">Postgres</text>
  <text x="262" y="227" font-size="11" fill="#888">sessions · memory · queue</text>
  <rect x="250" y="262" width="190" height="60" rx="6" fill="none" stroke="#888" stroke-width="1.2"/>
  <text x="262" y="284" font-size="13" font-weight="600" fill="currentColor">Per-scope sandbox</text>
  <text x="262" y="301" font-size="11" fill="#888">Docker/Fly/AWS · durable</text>
  <text x="262" y="315" font-size="11" fill="#888">files · tools · logins</text>
  <path d="M200 75 H240 V95 H250" fill="none" stroke="#888" stroke-width="1.1" marker-end="url(#a)"/>
  <path d="M200 157 H240 V130 H250" fill="none" stroke="#888" stroke-width="1.1" marker-end="url(#a)"/>
  <path d="M345 154 V190" fill="none" stroke="#888" stroke-width="1.1" marker-end="url(#a)"/>
  <path d="M345 236 V262" fill="none" stroke="#888" stroke-width="1.1" marker-end="url(#a)"/>
  <text x="20" y="370" font-size="11" fill="#888">many people · one org agent · scoped state</text>
  <text x="20" y="388" font-size="11" fill="#888">needs: Node + Postgres + Docker + model key</text>

  <line x1="470" y1="20" x2="470" y2="410" stroke="#444" stroke-dasharray="4 5"/>

  <text x="500" y="28" font-size="14" font-weight="700" fill="currentColor">agent-rooms — one object per room</text>
  <rect x="500" y="60" width="150" height="46" rx="6" fill="none" stroke="#888" stroke-width="1.2"/>
  <text x="512" y="80" font-size="13" font-weight="600" fill="currentColor">Human A</text>
  <text x="512" y="97" font-size="11" fill="#888">browser tab</text>
  <rect x="500" y="130" width="150" height="46" rx="6" fill="none" stroke="#888" stroke-width="1.2"/>
  <text x="512" y="150" font-size="13" font-weight="600" fill="currentColor">Human B</text>
  <text x="512" y="167" font-size="11" fill="#888">browser tab</text>
  <rect x="500" y="200" width="150" height="46" rx="6" fill="none" stroke="#888" stroke-width="1.2"/>
  <text x="512" y="220" font-size="13" font-weight="600" fill="currentColor">Bridge (laptop)</text>
  <text x="512" y="237" font-size="11" fill="#888">agents run claude --json</text>
  <rect x="710" y="88" width="190" height="140" rx="6" fill="rgba(163,230,53,.10)" stroke="#a3e635" stroke-width="1.2"/>
  <text x="722" y="112" font-size="13" font-weight="600" fill="currentColor">Durable Object</text>
  <text x="722" y="132" font-size="11" fill="#888">Yjs CRDT brief</text>
  <text x="722" y="148" font-size="11" fill="#888">presence + live carets</text>
  <text x="722" y="164" font-size="11" fill="#888">transcript (SQLite)</text>
  <text x="722" y="180" font-size="11" fill="#888">in-room agent runtime</text>
  <text x="722" y="196" font-size="11" fill="#888">Workers AI / Claude</text>
  <path d="M650 83 H700 V110 H710" fill="none" stroke="#888" stroke-width="1.1" marker-end="url(#a)"/>
  <path d="M650 153 H710" fill="none" stroke="#888" stroke-width="1.1" marker-end="url(#a)"/>
  <path d="M650 223 H700 V196 H710" fill="none" stroke="#888" stroke-width="1.1" marker-end="url(#a)"/>
  <text x="500" y="370" font-size="11" fill="#888">many people + agent · one live document · one object</text>
  <text x="500" y="388" font-size="11" fill="#888">needs: a Cloudflare account, nothing else</text>
</svg>
<figcaption>QM routes every turn through a central Fastify core backed by Postgres, with per-scope Docker sandboxes. agent-rooms collapses room, document, presence, and agent into one addressable Durable Object at the edge.</figcaption>
</figure>

## Findings

| Dimension | QM | agent-rooms |
| --- | --- | --- |
| "Multiplayer" means | Many people share one org agent; each person/room has scoped memory, files, keychain, permissions | Many people and the agent co-edit one live document with presence and cursors |
| Agent visibility | Turn-based chat; tool calls fold into a "1 tool call" disclosure | Agent is a peer: visible caret on the line it reads, output typed into the doc live |
| Identity & policy | Portal auth, admin/org config, 3 security postures (Strict/Auto/Dangerous), command-policy denials, audit | None — the room URL is the credential |
| Execution | Durable per-scope sandbox (Docker locally; Fly/AWS in prod); tools stay installed | In-room model turns (Workers AI or Claude API); real coding agents join only via the local bridge |
| Harnesses | Pi, OpenCode, Codex, Claude Code drive one core | Any `agents run` harness via the bridge; in-room agent is model-API only |
| State | Postgres: sessions, memory, queue, grants, budgets, audit | One DO: Yjs doc + SQLite transcript; `runFiber` checkpoints survive ~70–140s DO evictions |
| Steering mid-run | Send a message; posture may pause for approval | Edit the brief or type a steer; agent re-reads on next step |
| Surfaces | Web app, admin panel, portal, Slack (channels, group DMs) | One web page; share the URL |
| Setup to first turn | Node + Postgres + Docker + model key; admin onboarding gate (measured: ~15 min on a dev Mac including sandbox image build) | `bunx wrangler deploy`, keyless (measured in the Aug 11 session: minutes) |
| Footprint | ~100k LOC TS, 4 processes + Postgres + sandbox containers | 1,478 LOC, zero servers |
| License / stars | MIT · 13,155 stars · released 2026-07-31 | Personal demo · deployed 2026-08-11 |

Two details worth naming precisely:

- **QM's positioning against agents-cli was already scanned** — `.agents/artifacts/2026-08-10/agent-router-market-scan.md` places QM as an *adjacent harness, not an L3 router competitor*: its `harness-router.ts` (5KB) resolves an org/scope allowlist, with no scoring, quota reads, account rotation, or cross-harness failover.
- **The two demos answer different questions.** QM answers "how does a company run one agent for everyone, safely" — identity, scopes, audit, durable sandboxes. agent-rooms answers "what does it feel like to work *with* an agent in real time" — presence, live cursors, the agent visibly typing. QM's chat hides the work behind a disclosure triangle; agent-rooms makes the work the interface. Nothing in QM today does live co-editing, and nothing in agent-rooms today does identity or policy.

## Evidence

- QM run: worktree at `~/src/github.com/yc-software/qm/.agents/worktrees/run-latest` (3cb5623); boot log quoted above; sandbox turn screenshot linked above; sandbox image `qm-sandbox-local:latest` (446MB).
- Web-UI gate: `plugins/portal/src/index.ts:1055-1062` (`modelProviderConfigured === false` → 302 `/admin/onboarding`).
- Dev-instance env rules: `scripts/dev/lib/envctx.ts:128-149` (HARNESS=claude accepted with native CLI auth; pi/opencode require `ANTHROPIC_API_KEY`; mock only behind `DEV_INSTANCE_ALLOW_MOCK=1`).
- agent-rooms: `src/server.ts:1-9` (one DO = CRDT + presence + transcript + agent), `bridge/bridge.ts:1-16`, README; live room screenshot linked above.
- QM release context: [YC open-sources QM (MarkTechPost, 2026-08-03)](https://www.marktechpost.com/2026/08/03/y-combinator-open-sources-qm-multiplayer-ai-agent-harness/), [repo](https://github.com/yc-software/qm).
