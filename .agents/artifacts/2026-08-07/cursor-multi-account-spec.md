---
kind: plan
template: plan.v1
title: 'Cursor multi-account — make picking an account actually pick it'
summary: 'agents-cli shows and rotates multiple Cursor accounts, but every Cursor run authenticates as the one live ~/.cursor symlink target. This spec makes the account pick real, per-run and concurrency-safe.'
header: 'Spec · RUSH-2400'
footer: 'agents-cli · Phoenix Labs'
project: 'Agents CLI'
context: 'apps/cli — Cursor harness account model'
repository: 'owner/agents-cli'
branch: 'spec-cursor-multi-account'
tracking: 'RUSH-2400'
status: draft
harness: 'claude'
agent: 'claude · opus-4-8'
human: 'Owner'
host: 'worker-s0'
session: 'e67573e5'
date: '2026-08-07'
facts:
  - 'View shows 2 accounts; exec authenticates as 1 (the default symlink target)'
  - 'Cursor exposes no config-dir env var — only CURSOR_API_KEY / CURSOR_API_ENDPOINT'
  - 'Isolation must come from per-child HOME + XDG_CONFIG_HOME, not a global symlink swap'
links:
  - 'https://linear.app/rush/issue/RUSH-2400'
assets: []
---

## Purpose

You asked whether "multiple Cursor profiles" shipped. It did not — and the reason is a trap: `agents view cursor` *looks* like it works.

Today it prints two accounts:

```
Cursor (balanced)
  2026.08.04 (default)  [account-redacted]   (signed in)
  2026.07.23            (logged out — log in with: cursor-agent)
```

That display is cosmetic. Cursor is a single self-updating binary with one config location, and agents-cli isolates a harness's accounts by pinning a per-account config dir at exec — a mechanism Cursor never got. So the picker, the `@version` selector, and balanced rotation all compute an account choice that has **zero effect** on which login actually runs. This spec makes the choice real.

## Behavior — before and after

**Before (today).** All three paths silently collapse to the one live login:

- `agents run cursor@2026.07.23` → you expect the logged-out home; you get the **default** account (`[account-redacted]`), because the spawned `cursor-agent` reads `~/.cursor`, a symlink to whichever version is the current default.
- `agents run auto` with balanced rotation "picks" a Cursor account → same single login runs regardless of the pick.
- Two Cursor runs on two accounts at once → both authenticate as the same account; the "second account" is a display artifact, not a session.

**After (this spec).** The account you name is the account that runs:

- `agents run cursor@<account>` launches `cursor-agent` authenticated as that account's own login.
- `agents view cursor` reports each account's real signed-in state and usage, verified against that account's own credential file (no blind trust).
- Balanced rotation and the picker route across genuinely distinct Cursor logins.
- Two accounts run **concurrently** without clobbering each other — isolation is per-child-process, not global mutable state.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 940 360" role="img" aria-label="Before and after account isolation for Cursor">
    <!-- BEFORE -->
    <text x="30" y="34" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="13">BEFORE — pick is cosmetic</text>
    <rect x="30" y="52" width="180" height="52" rx="6" fill="#16120a" stroke="#f59e0b" stroke-width="1.3" />
    <text x="120" y="74" text-anchor="middle" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="12">run cursor@08-04</text>
    <text x="120" y="92" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">account A</text>
    <rect x="30" y="120" width="180" height="52" rx="6" fill="#16120a" stroke="#f59e0b" stroke-width="1.3" />
    <text x="120" y="142" text-anchor="middle" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="12">run cursor@07-23</text>
    <text x="120" y="160" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">account B</text>
    <line x1="210" y1="78" x2="330" y2="120" stroke="#6b7280" stroke-width="1.6" />
    <line x1="210" y1="146" x2="330" y2="130" stroke="#6b7280" stroke-width="1.6" />
    <rect x="330" y="104" width="150" height="60" rx="6" fill="#1a1206" stroke="#ef4444" stroke-width="1.5" />
    <text x="405" y="128" text-anchor="middle" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">~/.cursor</text>
    <text x="405" y="146" text-anchor="middle" fill="#ef4444" font-family="Inter, sans-serif" font-size="10">one symlink → default</text>
    <text x="405" y="200" text-anchor="middle" fill="#ef4444" font-family="Inter, sans-serif" font-size="11">both runs → account A</text>
    <!-- divider -->
    <line x1="500" y1="40" x2="500" y2="320" stroke="#2a2a2a" stroke-width="1" stroke-dasharray="4 4" />
    <!-- AFTER -->
    <text x="530" y="34" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="13">AFTER — pick is real</text>
    <rect x="530" y="52" width="180" height="52" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1.3" />
    <text x="620" y="74" text-anchor="middle" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="12">run cursor@A</text>
    <text x="620" y="92" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">HOME=homeA</text>
    <rect x="530" y="120" width="180" height="52" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1.3" />
    <text x="620" y="142" text-anchor="middle" fill="#c8c8c8" font-family="Inter, sans-serif" font-size="12">run cursor@B</text>
    <text x="620" y="160" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">HOME=homeB</text>
    <line x1="710" y1="78" x2="800" y2="78" stroke="#a3e635" stroke-width="1.6" />
    <line x1="710" y1="146" x2="800" y2="146" stroke="#a3e635" stroke-width="1.6" />
    <rect x="800" y="52" width="120" height="52" rx="6" fill="#0f160a" stroke="#38bdf8" stroke-width="1.3" />
    <text x="860" y="78" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="10">homeA/.cursor</text>
    <text x="860" y="94" text-anchor="middle" fill="#8a8a8a" font-family="Inter, sans-serif" font-size="9">login A</text>
    <rect x="800" y="120" width="120" height="52" rx="6" fill="#0f160a" stroke="#38bdf8" stroke-width="1.3" />
    <text x="860" y="146" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="10">homeB/.cursor</text>
    <text x="860" y="162" text-anchor="middle" fill="#8a8a8a" font-family="Inter, sans-serif" font-size="9">login B</text>
    <text x="725" y="210" text-anchor="middle" fill="#a3e635" font-family="Inter, sans-serif" font-size="11">concurrent, no clobber</text>
  </svg>
  <figcaption><b>Figure 1.</b> Before: every Cursor run resolves through one <code>~/.cursor</code> symlink, so the account pick is discarded at exec. After: each account owns a credential home and the child process pins <code>HOME</code> + <code>XDG_CONFIG_HOME</code> to it, so two accounts run at once without racing shared state.</figcaption>
</figure>

## Root cause — display and exec disagree

Two independent facts combine into the illusion (all line refs on `origin/main`):

| Layer | What happens | Where |
| --- | --- | --- |
| Enumeration | `listInstalledVersions('cursor')` returns both version-homes — cursor has no branch in `getBinaryPath`, so `collapseGlobalBinaryVersions` never folds it | `versions.ts:1008-1062`, `:1079`, `:1283-1286` |
| Display | `agents view` reads each version-home's own `.cursor/cli-config.json`; the two differ only as leftover state from `switchConfigSymlink` default-swaps | `commands/view.ts:1493-1497`, `agents.ts:1426-1433`, `shims.ts` |
| Exec (the gap) | `buildExecEnv` sets **no** config-dir var for cursor; it falls into the `else` that only strips other agents' vars | `exec.ts:510-514`, `docs/specifications.md:1799-1810` (EXEC-16) |
| Exec (alias) | The versioned-alias generator also skips cursor; `CONFIG_ENV_ISOLATED_AGENTS` excludes it | `shims.ts:1015-1063`, `:988` |
| Verification | `credentialPresence('cursor')` is blind — cursor absent from `CREDENTIAL_FILE_SEGMENTS`, so `signedIn` is trusted with no per-account check | `agents.ts:1448-1459`, `:1484-1487`, `rotate.ts:170-176` |

Net: the spawned `cursor-agent` inherits the real `$HOME`, reads the live `~/.cursor` symlink (current default), and ignores the version string entirely.

## Proposed Changes

**1. A first-class Cursor account home, decoupled from version.** Cursor is one binary; stacking accounts onto "version-homes" is why a stale default-swap leaks as a phantom login. Introduce a real per-account credential home — `~/.agents/accounts/cursor/<label>/` — each holding its own `.cursor/cli-config.json` and `.config/cursor/auth.json`. `agents add cursor --account <label>` runs `cursor-agent login` with `HOME`/`XDG_CONFIG_HOME` pinned into that home, capturing the login there.

**2. Per-run isolation by env, not by symlink (the mechanism decision).** Cursor has no config-dir env var, so there are two ways to make a run use account X:

| Option | Mechanism | Concurrency | Verdict |
| --- | --- | --- | --- |
| A — symlink swap | Repoint `~/.cursor` + `~/.config/cursor` before each spawn (reuse `switchConfigSymlink`) | **Unsafe** — global mutable state; two concurrent runs race, last writer wins → wrong account | Reject |
| B — per-child env pin | Set `HOME=<accountHome>` and `XDG_CONFIG_HOME=<accountHome>/.config` on the child only | **Safe** — each process sees its own tree | **Recommend** |

Concurrency safety is not optional here — running several Cursor accounts at once is the whole point (balanced rotation, teams). Option A reintroduces exactly the shared-state class the fleet already fought (the double-fire lineage). So: give cursor a real arm in `buildExecEnv` and the alias generator that pins `HOME` + `XDG_CONFIG_HOME` to the selected account home, and add cursor to `CONFIG_ENV_ISOLATED_AGENTS`.

**3. Enumerate accounts, then verify.** `collectRunCandidates('cursor')` lists account homes (not version dirs) and builds one candidate per account; add `cursor: [['.cursor', 'cli-config.json']]` to `CREDENTIAL_FILE_SEGMENTS` so `isLaunchableSignedIn` verifies each account's real credential instead of trusting `signedIn`.

## Public Interface

```bash
agents add cursor --account work        # capture a new Cursor login into its own home
agents run cursor@work "…"              # run authenticated as the 'work' account
agents view cursor                      # per-account signed-in + usage, verified
agents run auto                         # balanced rotation across real Cursor accounts
agents accounts cursor --remove work    # drop an account home
```

## Empirical spike (blocks implementation)

One closed-source unknown must be pinned before coding, because the codebase disagrees with itself: `agents.ts` treats `cli-config.json` as HOME-relative (`~/.cursor/`), while `sandbox.ts:143-152` claims setting `XDG_CONFIG_HOME` makes cursor read `cli-config.json` beside `auth.json`. On this box the real `cli-config.json` sits at `~/.cursor/` and `~/.config/cursor/` has only `auth.json`.

Spike: set `HOME` and `XDG_CONFIG_HOME` to a scratch home containing a known account's files, run `cursor-agent`, and confirm which file each var actually relocates. The answer decides whether pinning `XDG_CONFIG_HOME` alone suffices or `HOME` must move too (and whether moving `HOME` drags in unrelated cursor state that needs seeding).

## Validation

| Check | Expected result |
| --- | --- |
| `agents run cursor@A` vs `@B` | `cursor-agent whoami`-equivalent reports A then B (not the default both times) |
| Concurrency | Two simultaneous runs on A and B each stay on their own account through completion |
| `agents view cursor` | Each account's signed-in + usage matches that account's own credential file |
| Rotation | `collectRunCandidates('cursor')` returns one candidate per account home; balanced pick lands on the intended login |
| Regression | Single-account users see no behavior change; the phantom stale-symlink row disappears |

## Risks

| Risk | Mitigation |
| --- | --- |
| `HOME` pin drags in unrelated cursor state (chats, rules, hooks) | Seed the account home by symlinking non-credential dirs back to the shared config; scope the spike to confirm the blast radius |
| Cursor changes its auth file layout across self-updates | Centralize the two paths in one resolver; the `CREDENTIAL_FILE_SEGMENTS` entry is the single source |
| Migration of today's phantom version-home accounts | One-time: fold each signed-in version-home into an account home; drop logged-out phantoms |
| Spec drifts from `agents view` display parity | Cover with the completeness test that pins the account model to view + rotate together |

## Non-goals

- Cursor Cloud / REST provider accounts (separate surface, already shipped).
- Changing the isolated-agent model for the other single-binary harnesses (droid, grok, antigravity) — this is cursor-scoped, though the env-pin approach is the template they would follow.
- The `profiles` resource kind (provider bundles) — orthogonal; not how Cursor login works.

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> the pick is discarded at exec, not at display. The fix is a real per-account credential home plus per-child <code>HOME</code>/<code>XDG_CONFIG_HOME</code> pinning — never a global symlink swap, which is unsafe under the concurrent runs this feature exists to enable.</aside>

## Tracking

- **RUSH-2400** — feat(cursor): make multiple Cursor accounts real — <https://linear.app/rush/issue/RUSH-2400>
- Spec PR — added on open (this document, committed under `.agents/artifacts/`).
- Implementation — follow-up, gated on the empirical spike and your approval of Option B.
