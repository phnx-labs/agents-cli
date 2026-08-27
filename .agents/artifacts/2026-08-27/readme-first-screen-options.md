---
kind: visual
title: "agents-cli README first screen: three directions"
summary: "Three paste-ready README openings test pain-first, inventory-first, and a combined command-first promise against today's category-heavy baseline."
status: review
project: AGI
repository: phnx-labs/agi-cli
branch: docs/readme-first-screen-options
harness: codex
agent: gpt-5
host: zion
session: 01a043a1-5b39-7241-8235-ceae1405ad63
date: "2026-08-27"
links:
  - https://x.com/ClaudeDevs/status/2088014831605702937
  - https://x.com/flavioAd/status/2077118895635206291
  - https://happy.engineering/
  - https://www.ycombinator.com/launches/OHk-conductor-run-a-bunch-of-claude-codes-in-parallel
---

## Story

Today’s first screen explains the machinery before it gives a reader one reason to install it. All three alternatives keep the same product and install path, but force a different answer to the first question a visitor asks: **what can this do for me right now?**

<div class="artifact-callout">
<strong>Pick the promise, not the feature set.</strong> Every option names the six high-signal harnesses, says the user keeps their existing subscriptions, states that agents-cli never proxies tokens, and stops before the feature tables. The only variable is what earns the first sentence.
</div>

## Today

<figure class="artifact-figure">
<article class="artifact-panel">
<p><code>README.md · current first screen</code></p>
<h1>agi-cli</h1>
<p><strong>A framework for running a distributed agent factory.</strong> Dispatch Claude, Codex, Antigravity, Grok, and more across your own machines, in parallel, on your existing subscriptions. Measure every run with <code>agents perf</code> / <code>agents insights</code>, fold what you learn back into <code>AGENTS.md</code> and skills, then put the loop on a schedule with routines and monitors. Spawn parallel teams in isolated terminals or dispatch to the cloud for a PR. Watch live state across the fleet, nudge stalled runs, and message agents mid-flight. Store secrets behind Touch ID, drive real browsers and Electron apps, and steer the whole fleet from a menu bar — all from one CLI.</p>
<p><code>Claude Code</code> <code>Codex</code> <code>Gemini CLI</code> <code>Cursor</code> <code>OpenCode</code> <code>OpenClaw</code> <code>Hermes</code> <code>Grok Build</code> <code>Droid</code> <code>Muse</code> <code>Oh My Pi</code> <code>Warp</code></p>
</article>
<figcaption>Baseline: a category phrase followed by eleven subsystems. The two highest-evidence pains — a task dying at a usage limit and a session waiting unnoticed for input — are absent.</figcaption>
</figure>

## Figure

<figure class="artifact-figure artifact-figure-wide">
<section class="artifact-grid artifact-grid-3">
<article class="artifact-panel">
<p><span class="artifact-tag artifact-tag-accent">A · PAIN-FIRST</span></p>
<p><code>README preview</code></p>
<h1>agents-cli</h1>
<p><strong>Pin the version. Rotate the account. Resume the session.</strong></p>
<p>Keep a usage limit or forgotten permission prompt from stopping a task halfway through. agents-cli chooses an account with headroom, resumes the session, and brings stalled work back to the top.</p>
<p>It drives your already-authenticated CLIs on your existing subscriptions. Your credentials stay with those CLIs; agents-cli never proxies your tokens.</p>
<pre><code>npm install -g \
  @phnx-labs/agents-cli
agents setup</code></pre>
<p><strong>Works with</strong><br><code>Claude Code</code> <code>Codex</code> <code>Cursor</code> <code>Grok Build</code> <code>Kimi</code> <code>Droid</code></p>
<hr>
<p><strong>Evidence</strong><br>Leans hardest on the million-view usage-limit posts and Happy’s single job: keep a waiting agent moving.</p>
<p><strong>Main risk</strong><br>“Rotate the account” is concrete but can sound like a terms-of-service workaround, and assumes the reader has more than one account.</p>
<p><strong>npm description</strong><br>CLI for Claude Code, Codex, Cursor, Grok, Kimi, and Droid with usage-aware account rotation, resumable sessions, and stalled-run detection.</p>
</article>
<article class="artifact-panel">
<p><span class="artifact-tag">B · INVENTORY-FIRST</span></p>
<p><code>README preview</code></p>
<h1>agents-cli</h1>
<p><strong>One <code>agents</code> binary for every coding agent you already pay for.</strong></p>
<p>Run Claude Code, Codex, Cursor, Grok, Kimi, and Droid without learning six wrappers. Pin each CLI version, keep sessions searchable, and move between agents or machines without rebuilding your setup.</p>
<p>agents-cli drives your already-authenticated CLIs on your existing subscriptions. It never proxies your tokens.</p>
<pre><code>npm install -g \
  @phnx-labs/agents-cli
agents setup</code></pre>
<p><strong>Works with</strong><br><code>Claude Code</code> <code>Codex</code> <code>Cursor</code> <code>Grok Build</code> <code>Kimi</code> <code>Droid</code></p>
<hr>
<p><strong>Evidence</strong><br>Leans on harness breadth as a documented switching reason and on every surviving competitor repeating bring-your-own-subscription.</p>
<p><strong>Main risk</strong><br>Breadth is legible and searchable, but weaker emotionally; it can read like a package manager and bury the limit-and-stall wedge again.</p>
<p><strong>npm description</strong><br>One CLI to run Claude Code, Codex, Cursor, Grok, Kimi, and Droid on your existing subscriptions, with version pinning, sessions, accounts, teams, and fleet dispatch.</p>
</article>
<article class="artifact-panel">
<p><span class="artifact-tag artifact-tag-accent">C · COMBINED</span></p>
<p><code>README preview</code></p>
<h1>agents-cli</h1>
<p><strong>Keep Claude, Codex, Cursor, Grok, Kimi, and Droid moving.</strong></p>
<p>Stalled sessions rise to the top. When a usage limit ends a run, agents-cli relaunches it on an account with headroom and resumes the same session, even on another machine.</p>
<p>It drives your local, already-authenticated CLIs on your existing subscriptions. Your credentials stay local; agents-cli never proxies your tokens.</p>
<pre><code>npm install -g \
  @phnx-labs/agents-cli
agents setup</code></pre>
<p><strong>Works with</strong><br><code>Claude Code</code> <code>Codex</code> <code>Cursor</code> <code>Grok Build</code> <code>Kimi</code> <code>Droid</code></p>
<hr>
<p><strong>Evidence</strong><br>Combines Happy’s command-shaped “keep moving” promise with the harness names that carry search value and prove switching breadth.</p>
<p><strong>Main risk</strong><br>It compresses two jobs into one promise, so it is less sharp than A on limits and less explicit than B about the one-binary inventory.</p>
<p><strong>Why this is my pick</strong><br>It names the tools a reader already uses while promising the human outcome behind both peak pains: unfinished work keeps moving.</p>
<p><strong>npm description</strong><br>Run and resume Claude Code, Codex, Cursor, Grok, Kimi, and Droid from one CLI, with usage-aware account selection and stalled-session recovery.</p>
</article>
</section>
<figcaption>Read left to right: A makes the failure mode the product; B makes breadth the product; C makes continuity across named harnesses the product. Every preview contains exactly the material intended to appear before the feature tables.</figcaption>
</figure>

## Paste-ready Markdown

### A — Pain-first

````markdown
# agents-cli

**Pin the version. Rotate the account. Resume the session.**

Keep a usage limit or forgotten permission prompt from stopping a task halfway through.
agents-cli chooses an account with headroom, resumes the session, and brings stalled
work back to the top.

It drives your already-authenticated CLIs on your existing subscriptions. Your
credentials stay with those CLIs; agents-cli never proxies your tokens.

```bash
npm install -g \
  @phnx-labs/agents-cli
agents setup
```

**Works with:** Claude Code · Codex · Cursor · Grok Build · Kimi · Droid
````

**Evidence:** Leans hardest on the million-view usage-limit posts and Happy’s single job: keep a waiting agent moving.  
**Main risk:** “Rotate the account” is concrete but can sound like a terms-of-service workaround, and assumes the reader has more than one account.

**npm `description`:** CLI for Claude Code, Codex, Cursor, Grok, Kimi, and Droid with usage-aware account rotation, resumable sessions, and stalled-run detection.

### B — Inventory-first

````markdown
# agents-cli

**One `agents` binary for every coding agent you already pay for.**

Run Claude Code, Codex, Cursor, Grok, Kimi, and Droid without learning six wrappers.
Pin each CLI version, keep sessions searchable, and move between agents or machines
without rebuilding your setup.

agents-cli drives your already-authenticated CLIs on your existing subscriptions.
It never proxies your tokens.

```bash
npm install -g \
  @phnx-labs/agents-cli
agents setup
```

**Works with:** Claude Code · Codex · Cursor · Grok Build · Kimi · Droid
````

**Evidence:** Leans on harness breadth as a documented switching reason and on every surviving competitor repeating bring-your-own-subscription.  
**Main risk:** Breadth is legible and searchable, but weaker emotionally; it can read like a package manager and bury the limit-and-stall wedge again.

**npm `description`:** One CLI to run Claude Code, Codex, Cursor, Grok, Kimi, and Droid on your existing subscriptions, with version pinning, sessions, accounts, teams, and fleet dispatch.

### C — Combined

````markdown
# agents-cli

**Keep Claude, Codex, Cursor, Grok, Kimi, and Droid moving.**

Stalled sessions rise to the top. When a usage limit ends a run, agents-cli relaunches
it on an account with headroom and resumes the same session, even on another machine.

It drives your local, already-authenticated CLIs on your existing subscriptions.
Your credentials stay local; agents-cli never proxies your tokens.

```bash
npm install -g \
  @phnx-labs/agents-cli
agents setup
```

**Works with:** Claude Code · Codex · Cursor · Grok Build · Kimi · Droid
````

**Evidence:** Combines Happy’s command-shaped “keep moving” promise with the harness names that carry search value and prove switching breadth.  
**Main risk:** It compresses two jobs into one promise, so it is less sharp than A on limits and less explicit than B about the one-binary inventory.  
**Why this is my pick:** It names the tools a reader already uses while promising the human outcome behind both peak pains: unfinished work keeps moving.

**npm `description`:** Run and resume Claude Code, Codex, Cursor, Grok, Kimi, and Droid from one CLI, with usage-aware account selection and stalled-session recovery.

## Selection guide

| If the first-screen job is… | Pick |
|---|---|
| Make the loudest pain unmistakable | **A** |
| Maximize breadth, search terms, and BYO-subscription clarity | **B** |
| Balance emotional pull with harness discoverability | **C** |

The next round should paste only the chosen option into `README.md`; this artifact deliberately does not edit the product README.
