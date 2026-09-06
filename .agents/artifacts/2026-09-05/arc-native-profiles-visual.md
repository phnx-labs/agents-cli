---
kind: visual
title: "Arc profiles: what works and what must change"
summary: "Select existing Arc identity through native automation; do not create a replacement browser profile."
project: agents-cli
repository: phnx-labs/agents-cli
branch: plan/arc-native-profiles
harness: Codex
agent: Codex
human: ""
host: ""
session: ""
date: "2026-09-05"
links:
  - https://linear.app/getrush/issue/PHNX-2399
---

## Story

**Today:** the shipped CLI cannot reliably select a native Arc profile. **Proven:** a native Space-targeted tab used the expected profile and ran page JavaScript without CDP. **Still failing:** native creation changed Arc's selection. A working background browser feature has not shipped.

The fix is a native Arc integration behind the existing browser commands. Saved passwords and cookies remain in the original Arc profile. The [full plan](arc-native-profiles-proposal.html) defines the files, acceptance checks and failure behavior.

## Figure

<figure class="artifact-figure artifact-figure-diagram">
<svg viewBox="0 0 1040 600" role="img" aria-label="Proposed architecture: unified discovery and selection, shared browser service, native Arc adapter and existing CDP adapter, with user data owned by Arc">
<defs><marker id="proposed-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#38bdf8"/></marker></defs>
<g font-family="Inter,system-ui,sans-serif" font-size="17" fill="#e8e8e8">
<rect x="25" y="25" width="290" height="100" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="45" y="57">profiles list / show / use</text><text x="45" y="84" fill="#999999" font-size="14">Configured + discovered descriptors</text><text x="45" y="108" fill="#999999" font-size="14">Profile → eligible Spaces → readiness</text>
<rect x="395" y="25" width="290" height="100" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="415" y="57">start --profile --space</text><text x="415" y="84" fill="#999999" font-size="14">Resolve stable native IDs on owner host</text><text x="415" y="108" fill="#999999" font-size="14">Validate selection before opening a URL</text>
<rect x="395" y="190" width="290" height="105" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="415" y="223">Existing BrowserService + IPC</text><text x="415" y="252" fill="#999999" font-size="14">Tasks · ownership · capabilities</text><text x="415" y="276" fill="#999999" font-size="14">One Arc coordinator per host/app</text>
<rect x="25" y="370" width="440" height="105" rx="8" fill="#0f160a" stroke="#a3e635"/>
<text x="45" y="402">Native Arc adapter</text><text x="45" y="430" fill="#a3e635" font-size="14">Apple Events → exact Space ID → owned tab ID</text><text x="45" y="454" fill="#999999" font-size="14">Bounded operations · verified selection preservation</text>
<rect x="575" y="370" width="440" height="105" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="595" y="402">Existing CDP adapter</text><text x="595" y="430" fill="#999999" font-size="14">Existing Chrome / Comet tasks and features</text><text x="595" y="454" fill="#999999" font-size="14">No silent switch to another logged-in identity</text>
<rect x="25" y="530" width="990" height="50" rx="8" fill="#141414" stroke="#777777"/>
<text x="45" y="562">Arc owns passwords, cookies, history and extensions. The CLI stores references and task state only.</text>
<path d="M315 76H388M540 125V183M460 295L280 363M620 295L790 363M245 475V523" stroke="#38bdf8" fill="none" stroke-width="2" marker-end="url(#proposed-arrow)"/>
</g></svg>
<figcaption>Proposed. Native discovery and control join the existing browser service; they do not create another daemon or a copy of the user's browser profile.</figcaption>
</figure>

## What the agent will do

<figure class="artifact-figure artifact-behavior">
<section data-state="current" data-evidence="mockup">
<h3>Today: configured connections</h3>
<pre>$ agents browser profiles list

NAME                BROWSER
configured-browser  comet

ENDPOINT
cdp://127.0.0.1:9333

Arc native profiles and Spaces
are not discovered.</pre>
<p>Faithful, anonymized mockup of the installed listing and source behavior, checked September 5, 2026. A configured Arc connection without CDP asks for a restart.</p>
</section>
<section data-state="proposed" data-evidence="mockup">
<h3>Proposed: choose a real profile</h3>
<pre>$ agents browser profiles list

arc-work      Arc / Work
  Space: Work       Ready
arc-personal  Arc / Personal
  Spaces: Home, Reading
  Choose Space

$ agents browser start \
    --profile arc-work \
    --url https://example.com

Arc / Work · Space Work
No debug port required.</pre>
<p>Proposed output, not an implemented command flow. “Ready” requires the capability and selection-preservation checks below to pass. Saved logins stay in Arc.</p>
</section>
</figure>

## No debugging port does not mean no profile

| Situation | Proposed behavior |
| --- | --- |
| Arc open without CDP | Use native automation once readiness checks pass |
| Permission absent | Show discovered profile and the permission needed; no tab mutation |
| Arc closed | Start Arc normally on explicit `start`, verify the existing profile |
| Several Spaces in one profile | Require the intended Space |
| Native feature unavailable | Return a capability error; keep the same profile identity |

<div class="artifact-callout"><strong>Preserve, do not migrate.</strong> No profile directory is copied or reset. Existing passwords, cookies, history and extensions stay under Arc's ownership. Discovery never creates a signed-out replacement.</div>

## Evidence

Observations from September 5, 2026 on Arc 1.162.0: selected-profile DOM result `{"clicked":"yes","value":"arc-native-probe"}`; effective profile path ended in `Profile 1`; selection check returned `false` after creation and required restoration after cleanup. These prove a mechanism, not complete input fidelity or login-isolation coverage.

[Source evidence and raw-record summary](arc-native-profiles-proposal.html#evidence-record). [Arc profile semantics](https://resources.arc.net/hc/en-us/articles/19227964556183-Profiles-Separate-Work-Personal-Browsing). [Current source selection code](https://github.com/phnx-labs/agents-cli/blob/60855164c70bf086ca9e22ee45c3313ec9597191/cli/src/lib/browser/service.ts#L776).
