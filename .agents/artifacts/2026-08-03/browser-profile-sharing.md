---
kind: report
template: report.v1
title: Browser Profile Sharing — Local Client vs worker Agent
summary: One synced profile definition works on both machines at once, but each machine keeps its own cookie jar — log in once per machine, not once per profile.
header: Phoenix Labs / Engineering
footer: agents-cli research artifact
project: agents-cli
context: agents browser profiles
repository: phnx-labs/agents-cli
status: answered
harness: kimi
host: worker-s1
facts:
  - 1 profile name, synced everywhere
  - 2 separate cookie jars
  - 0 lock or port conflicts
assets: []
---

## Summary

**Yes — the same browser profile can be used locally and by a remote agent on
remote worker at the same time.** The profile *definition* (name, browser,
endpoint) lives in the central `~/.agents/agents.yaml` and syncs across the
fleet with `agents repo push/pull`, so `work` resolves on both machines.

**But it is not one shared session.** Each machine launches its own Chrome with
its own `--user-data-dir` under `~/.agents/.cache/browser/<profile>@<endpoint>/chrome-data/`,
which is gitignored runtime state that never syncs. No new profile needs to be
created per machine — the same name is correct — but each machine's copy must
be logged into once.

<section class="artifact-grid artifact-grid-3">
  <div class="artifact-stat">
    <div class="artifact-stat-value">1</div>
    <div class="artifact-stat-label">Profile definition, synced via agents.yaml</div>
  </div>
  <div class="artifact-stat">
    <div class="artifact-stat-value">2</div>
    <div class="artifact-stat-label">Independent chrome-data cookie jars</div>
  </div>
  <div class="artifact-stat">
    <div class="artifact-stat-value">0</div>
    <div class="artifact-stat-label">Lock or port conflicts across machines</div>
  </div>
</section>

## Findings

<figure class="artifact-figure artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 960 400" role="img" aria-label="Diagram: one synced profile definition fans out to two machines, each with its own chrome-data cookie jar that never syncs.">
  <!-- Shared layer: central agents.yaml -->
  <rect x="280" y="20" width="400" height="72" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="480" y="46" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">~/.agents/agents.yaml</text>
  <text x="480" y="66" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">browser: profile definitions (name, browser, endpoint)</text>
  <text x="480" y="82" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">syncs with agents repo push/pull</text>

  <!-- Sync arrows -->
  <line x1="380" y1="92" x2="240" y2="150" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <line x1="580" y1="92" x2="720" y2="150" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <text x="270" y="118" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#38bdf8">syncs</text>
  <text x="690" y="118" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#38bdf8">syncs</text>

  <!-- Local machine -->
  <rect x="40" y="150" width="400" height="96" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="240" y="176" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">LOCAL CLIENT (this laptop)</text>
  <text x="240" y="196" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">agents browser start --profile work</text>
  <text x="240" y="214" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">Chrome A · local debug port · local SingletonLock</text>
  <text x="240" y="232" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">resolves "work" from its own synced agents.yaml</text>

  <!-- worker machine -->
  <rect x="520" y="150" width="400" height="96" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="720" y="176" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">REMOTE WORKER (remote agent)</text>
  <text x="720" y="196" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">agents -H worker browser start --profile work</text>
  <text x="720" y="214" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">Chrome B · own debug port · own SingletonLock</text>
  <text x="720" y="232" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">SSH passthrough — runs entirely on worker</text>

  <!-- chrome-data dirs -->
  <rect x="40" y="292" width="400" height="72" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5" opacity="0.85"/>
  <text x="240" y="318" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">.cache/browser/work@…/chrome-data/</text>
  <text x="240" y="338" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">cookies + logins · gitignored · log in once here</text>

  <rect x="520" y="292" width="400" height="72" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" opacity="0.85"/>
  <text x="720" y="318" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">.cache/browser/work@…/chrome-data/</text>
  <text x="720" y="338" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">cookies + logins · gitignored · log in once here too</text>

  <!-- never-synced connector -->
  <line x1="440" y1="328" x2="520" y2="328" stroke="#f43f5e" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.8"/>
  <text x="480" y="318" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#f43f5e">✕ never syncs</text>

  <!-- launch arrows -->
  <line x1="240" y1="246" x2="240" y2="288" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <line x1="720" y1="246" x2="720" y2="288" stroke="#a3e635" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
</svg>
<figcaption>Read top-down: one synced definition fans out to two machines; each machine launches its own Chrome into its own chrome-data jar (bottom row), and the jars never sync (red ✕).</figcaption>
</figure>

- **Profile definitions sync; runtime state does not.** `browser:` profiles are
  portable config in central `~/.agents/agents.yaml`. The cookie jar lives in
  `~/.agents/.cache/browser/` — explicitly gitignored, regenerable runtime data.
- **Remote runs are SSH passthrough.** `agents -H worker browser …` executes
  on worker, resolving the same profile name against worker's synced config
  and launching Chrome there. Same name, physically separate browser.
- **No collisions.** Chromium's `SingletonLock` is per user-data-dir and debug
  ports are allocated per machine, so both copies run concurrently.
- **The default profile is deliberately device-local** — the right profile
  choice is expected to differ per machine.
- **The one way to literally share a single browser:** an `ssh://` endpoint in
  the profile, where the local daemon tunnels to one Chrome on the remote. It
  uses a throwaway `/tmp/agents-browser-<port>` dir — still not a synced
  profile.

## Evidence

| Claim | Source |
| --- | --- |
| Profile definitions sync via central agents.yaml | `apps/cli/src/lib/types.ts:899-904` |
| chrome-data is per-machine runtime state | `apps/cli/src/lib/browser/chrome.ts:262-264` |
| `.cache/` is gitignored, never synced | `apps/cli/src/lib/state.ts:14-16` |
| `browser` runs remotely via SSH passthrough | `apps/cli/src/lib/hosts/passthrough.ts:113` |
| SingletonLock is per user-data-dir | `apps/cli/src/lib/browser/chrome.ts:272-278` |
| Default profile is device-local | `apps/cli/src/lib/types.ts:905-914` |
| ssh:// endpoint tunnels one remote Chrome | `apps/cli/src/lib/browser/drivers/ssh.ts` |

<div class="artifact-callout">
  <span class="artifact-tag artifact-tag-accent">Verified</span>
  Claims checked directly against the source in this repo, not inferred from
  docs. One stale doc line found: <code>apps/cli/docs/browser.md:53-55</code>
  still points profile config at the version-home path instead of
  <code>~/.agents/agents.yaml</code>.
</div>

## Recommendations

1. **Keep one profile name** (e.g. `work`) synced everywhere — no need to
   create separate local vs remote profiles.
2. **Log in once per machine.** The worker agent starts logged-out until its
   own chrome-data copy is signed in once; it persists after that
   (`session.restore_on_startup` is pinned).
3. **Don't expect a shared live session.** There is no supported mechanism to
   share one logged-in profile between two machines simultaneously; if a single
   browser is truly required, use an `ssh://` endpoint profile and accept the
   throwaway remote dir.
