---
kind: plan
template: plan.v1
title: A project is a set of directories, each with its own remote
summary: Bind agents-cli-web and ~/.agents/.system to the agents-cli project, and make every spawn path — agents run, agents teams, and the extension's New Agent — resolve all of a project's directories instead of just one.
surface: cli
status: draft
---

## Focus for review

Five things worth your attention before I build this.

1. **The spawn contract.** One cwd (the project's primary directory) plus every other project directory attached as an `--add-dir` grant. Only Claude and Codex consume `--add-dir` today; other harnesses drop it silently.
2. **The CLI surface.** `--dir` on `projects add`, `--add-dir` / `--rm-dir` on `projects set`. Extending the two commands that already exist rather than adding a `projects repo` subcommand group.
3. **A slug comes from the directory, never from the path.** Your checkout sits at `~/src/github.com/muqsitnawaz/agents-cli` while the remote is `phnx-labs/agents-cli`. Every slug is read from that directory's own `origin`.
4. **This lands in agents-cli, not Factory.** The extension gets thinner: it stops computing a cwd and passes `--project <slug>`.
5. **`agents teams` gains `--project`.** It has no such flag today, so this is genuinely new surface.

## Purpose

> "Can we add the agents-cli-web repo and ~/.agents/.system repo to be part of the agents-cli project? ... And when we spin up an agent via `agents run` or `agents teams` or using 'Agents: New Agent' via the extension, then it should properly add all these cwds. ... Our project should have a way to specify different directories and then be able to connect their GitHub remote as well. ... This functionality should be agents-cli level, not Factory or extension level."

Binding the two repos is a one-line YAML edit. The request underneath it is the real work: a project should *be* a set of directories, and everything that starts an agent should know all of them.

## Behavior — what happens when you do X

| When you… | Today | After |
| --- | --- | --- |
| `agents run claude --project agents-cli` | Lands in `agents-cli`. The web repo and `.system` are invisible to the agent. | Lands in `agents-cli`, with `agents-cli-web` and `~/.agents/.system` attached as accessible roots. |
| `agents run … --project agents-cli --host yosemite-s0` | Same, remote. Extra dirs still invisible. | Extra dirs forwarded home-relative, re-rooted at the host's own `$HOME`. |
| `agents teams create X` | No `--project` flag exists at all. | `--project agents-cli` sets each teammate's base cwd and grants the sibling dirs. |
| Cmd-Shift-A (`Agents: New Agent`) in the agents-cli window | cwd is hardcoded to `workspaceFolders[0]`; projects are never consulted. | Emits `--project agents-cli`; the CLI resolves cwd and grants. |
| A box that has no `agents-cli-web` checkout | n/a | Definition loads fine; the missing dir is skipped at spawn, not an error. |

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel" data-state="current" data-evidence="capture">
    <h4>Today — <code>agents projects view agents-cli</code></h4>
    <pre><code>agents-cli  ·  1 live
  Agents CLI and Factory
  fleet    7/11 clean · 3 behind · 2 dirty · 1 missing
           win-mini: ✗ missing  ·  yosemite-m0: ⚠ ↓57 · main  ·  zion: ✓ clean · main
  repos    phnx-labs/agents-cli

  root     ~/src/github.com/muqsitnawaz/agents-cli
  path     ~/src/github.com/muqsitnawaz/agents-cli
  linear   8eb8f5b1-3870-4590-ba67-36f3811d1435</code></pre>
    <p>One repo, one root, one probed directory. Captured on zion, 2026-08-10.</p>
    <h4>Today — spawning into it</h4>
    <pre><code>$ agents run claude --project agents-cli
  cwd  ~/src/github.com/muqsitnawaz/agents-cli
  (agents-cli-web and ~/.agents/.system are not reachable by the agent)</code></pre>
  </article>
  <article class="artifact-panel" data-state="proposed" data-evidence="mockup">
    <h4>Proposed — <code>agents projects view agents-cli</code></h4>
    <pre><code>agents-cli  ·  1 live
  Agents CLI and Factory
  fleet    21/33 clean · 3 behind · 2 dirty · 1 missing        (3 dirs × 11 hosts)
           win-mini: ✗ missing  ·  yosemite-m0: ⚠ ↓57 · main  ·  zion: ✓ clean · main
  repo     phnx-labs/agents-cli       (~/src/github.com/muqsitnawaz/agents-cli)
  repo     phnx-labs/agents-cli-web   (~/src/github.com/muqsitnawaz/agents-cli-web)
  repo     phnx-labs/.agents-system   (~/.agents/.system)

  root     ~/src/github.com/muqsitnawaz/agents-cli
  path     ~/src/github.com/muqsitnawaz/agents-cli
  linear   8eb8f5b1-3870-4590-ba67-36f3811d1435</code></pre>
    <p>Three bound directories, each with the remote read from its own <code>origin</code>. The one-line <code>repos</code> summary becomes the per-repo form that <code>projects.ts:631-633</code> already prints.</p>
    <h4>Proposed — spawning into it</h4>
    <pre><code>$ agents run claude --project agents-cli
  cwd       ~/src/github.com/muqsitnawaz/agents-cli
  --add-dir ~/src/github.com/muqsitnawaz/agents-cli-web
  --add-dir ~/.agents/.system</code></pre>
  </article>
</section>

**Figure 1.** The user-visible change: a project stops being one directory that lists extra slugs and becomes a set of directories every spawn path can reach. The current state is captured live on zion; the proposed state is a mockup.

## Current architecture

`ProjectDef.repos[]` already has the exact shape needed — `{ slug, subpath?, path? }` at `apps/cli/src/lib/projects.ts:41-52`, with `path` documented as the opt-in for an additional repo. Two gaps sit on either side of it.

**Nothing writes it.** `projects add` and `projects set` each take a singular `--repo <owner/repo>` that only ever assigns `def.repo` (`projects.ts:557`, `:868`; bodies at `:588`, `:887`). `repos[]` is reachable only by hand-editing YAML or piping a complete `ProjectDef` into `projects save --json`.

**Nothing that spawns an agent reads it.** `resolveDefinedProjectPath` — the function behind `agents run --project` — consults only `def.defaultPath ?? def.root`:

```ts
// apps/cli/src/lib/projects.ts:475-489
export function resolveDefinedProjectPath(def, worktree, forRemote) {
  if (worktree) { /* … root ?? defaultPath … */ }
  const base = projectBasePath(def, forRemote);   // defaultPath ?? root, :352-356
  if (!base) return undefined;
  return forRemote ? base : path.resolve(base);
}
```

`repos[].path` *is* resolved elsewhere, but only for two read-only purposes: git-status probing in `project-probe.ts:120-125`, and mapping an existing cwd back to a project name in `projects.ts:403-407`. Never for placing an agent.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 940 300" role="img" aria-label="Before: one resolved directory with two orphan repos. After: three directories resolved into one agent.">
    <text x="20" y="26" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="12">BEFORE</text>
    <rect x="20" y="40" width="400" height="230" rx="10" fill="#141414" stroke="#3a3a3a" stroke-width="1" />
    <text x="40" y="66" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">agents-cli.yaml</text>
    <rect x="40" y="80" width="240" height="42" rx="6" fill="#16120a" stroke="#f59e0b" stroke-width="1.5" />
    <text x="56" y="100" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="11">root: agents-cli</text>
    <text x="56" y="115" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">phnx-labs/agents-cli</text>
    <rect x="40" y="134" width="240" height="36" rx="6" fill="#111" stroke="#333" stroke-width="1" stroke-dasharray="4 3" />
    <text x="56" y="156" fill="#5a5a5a" font-family="JetBrains Mono, monospace" font-size="11">agents-cli-web  (orphan)</text>
    <rect x="40" y="180" width="240" height="36" rx="6" fill="#111" stroke="#333" stroke-width="1" stroke-dasharray="4 3" />
    <text x="56" y="202" fill="#5a5a5a" font-family="JetBrains Mono, monospace" font-size="11">.agents/.system (orphan)</text>
    <line x1="280" y1="101" x2="340" y2="101" stroke="#f59e0b" stroke-width="2" />
    <circle cx="346" cy="101" r="18" fill="#16120a" stroke="#f59e0b" stroke-width="1.5" />
    <text x="346" y="106" text-anchor="middle" fill="#f59e0b" font-family="Inter, system-ui, sans-serif" font-size="11">cwd</text>
    <text x="346" y="240" text-anchor="middle" fill="#5a5a5a" font-family="Inter, system-ui, sans-serif" font-size="11">agent sees 1 of 3</text>
    <path d="M 448 155 L 486 155" stroke="#38bdf8" stroke-width="2" />
    <path d="M 478 149 L 486 155 L 478 161 Z" fill="#38bdf8" />
    <text x="520" y="26" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="12">AFTER</text>
    <rect x="520" y="40" width="400" height="230" rx="10" fill="#141414" stroke="#3a3a3a" stroke-width="1" />
    <text x="540" y="66" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">agents-cli.yaml — repos[]</text>
    <rect x="540" y="80" width="230" height="42" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="556" y="100" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">agents-cli</text>
    <text x="556" y="115" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">phnx-labs/agents-cli</text>
    <rect x="540" y="130" width="230" height="42" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="556" y="150" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">agents-cli-web</text>
    <text x="556" y="165" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">phnx-labs/agents-cli-web</text>
    <rect x="540" y="180" width="230" height="42" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="556" y="200" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">.agents/.system</text>
    <text x="556" y="215" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">phnx-labs/.agents-system</text>
    <path d="M 770 101 L 840 101" stroke="#a3e635" stroke-width="2" />
    <path d="M 770 151 L 812 151 L 812 112" stroke="#38bdf8" stroke-width="1.5" fill="none" stroke-dasharray="3 3" />
    <path d="M 770 201 L 812 201 L 812 112" stroke="#38bdf8" stroke-width="1.5" fill="none" stroke-dasharray="3 3" />
    <circle cx="858" cy="101" r="20" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="858" y="106" text-anchor="middle" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="11">cwd</text>
    <text x="846" y="240" text-anchor="middle" fill="#38bdf8" font-family="Inter, system-ui, sans-serif" font-size="11">+ 2 granted roots</text>
  </svg>
  <figcaption><b>Figure 2.</b> Solid line is the working directory; dashed lines are <code>--add-dir</code> grants. Today two of the three repos are named in the definition but reach no agent.</figcaption>
</figure>

## Proposed Changes

### 1. Write path — `apps/cli/src/commands/projects.ts`

`projects add` gains a repeatable `--dir <path...>`; `projects set` gains repeatable `--add-dir <path>` and `--rm-dir <path>`. Each value names a **local directory**, and the slug is derived from it:

```bash
# you name the directory; the slug is read from ITS origin remote
agents projects set agents-cli \
  --add-dir ~/src/github.com/muqsitnawaz/agents-cli-web \
  --add-dir ~/.agents/.system

# resolution per dir:
#   expandLocalHome(path) -> assert git repo -> git remote get-url origin
#                         -> { slug, path: toHomeRelative(abs) } into def.repos[]
```

`--slug owner/repo` overrides inference for a directory with no origin. `writeProjectDef` already normalizes every `repos[].path` through `toHomeRelative(expandLocalHome(...))` (`projects.ts:320-324`), so portability across machines needs nothing new.

The stale help note at `projects.ts:498-502` still tells the user to sync with `agents push/pull`; both were removed and now hard-redirect (`apps/cli/src/commands/push.ts:16-18`). It gets corrected to `agents repo push user` in the same change.

### 2. One resolver — `apps/cli/src/lib/projects.ts`

```ts
/** Ordered directories for a project: primary first, then each bound repo. */
export function projectDirsAbs(
  def: ProjectDef,
  opts: { forRemote: boolean },
): string[]
```

- primary first: `defaultPath ?? root`, identical to `projectBasePath`, so cwd behavior does not change;
- then every `repos[].path`, joined with `subpath` when present;
- deduped, and for local resolution filtered to directories that exist, so a box without `agents-cli-web` never receives a bogus grant;
- `forRemote: true` keeps `~/…` so the remote shell re-roots it, matching `resolveDefinedProjectPath`.

`workspaceTargetsForDef` (`project-probe.ts:120-125`) already computes nearly this list. It is refactored to call the new function so there is one canonical answer instead of two that drift.

### 3. `agents run --project` — `apps/cli/src/commands/exec.ts`

`resolveRunCwd` (`exec.ts:592-608`) keeps returning the primary directory. The secondary directories are merged into `options.addDir` at dispatch (`exec.ts:1695-1701`), deduped against anything passed explicitly.

Everything downstream already works and needs no change:

```
claude   -> repeated --add-dir flags        exec.ts (lib) :1268-1273
codex    -> folded into workspace_roots     exec.ts (lib) :1132-1134, codex-policy.ts:34-42
--host   -> toRemotePortable -> hostAddDirs exec.ts :1783
            forwarded verbatim              hosts/remote-cmd.ts:92, hosts/dispatch.ts:500
```

<aside class="artifact-callout"><strong>Known limit, stated plainly:</strong> <code>--add-dir</code> is emitted only for Claude and Codex — the guard is <code>options.agent === 'claude'</code> at <code>exec.ts:1269</code>, and the flag's own help text names only those two (<code>exec.ts:754</code>). For gemini, droid, grok and the rest the extra directories are dropped. The project still resolves the correct cwd; only the grants do not apply.</aside>

### 4. `agents teams` — `apps/cli/src/commands/teams.ts`

`teams create` gains `--project <slug>`, stored in team meta beside the existing `enable_worktrees` / `use_worktree` / `repo` fields (`teams.ts:1592-1601`). `teams add` then uses the project's primary directory as the base cwd when neither `--cwd` nor a worktree is given, making the precedence chain at `teams.ts:2055`:

```
worktree path  ->  --cwd  ->  project primary dir  ->  process.cwd()
```

The project's other directories are appended as `--add-dir` in `buildCommand` (`apps/cli/src/lib/teams/agents.ts:2782-2792`), which already appends `--add-dir <cwd>` for Claude.

### 5. Extension — `apps/factory`

`agents.newAgent` (`extension.ts:1622` → `launchAgent:788` → `openSingleAgent:2197`) hardcodes the cwd and never consults projects:

```ts
// apps/factory/src/vscode/extension.ts:2227  — today
const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
```

It changes to resolve that folder to a project name through the CLI — `resolveProjectNameForCwd` already exists and already matches against `repos[].path` (`projects.ts:403-407`, `:432-452`) — and, when one matches, `buildAgentLaunchCommand` (`apps/factory/src/core/agents.ts:187-195`) emits `--project <slug>` in place of the computed `--cwd`. No match means today's behavior, unchanged.

`--project` is mutually exclusive with `--cwd` / `--remote-cwd` (`exec.ts:598`), so the two branches must never both fire. `resolveProjectRef` handles `forRemote`, so a fleet-host launch works through the same path.

Separately, `defToManaged` (`apps/factory/src/core/managedProjects.ts:53-87`) collapses a multi-directory project into one `path` plus `repos[0].slug`. It gains a `dirs: { slug, path }[]` field so the Projects pane shows all three rather than silently dropping two. No resolution logic moves into the extension; it asks the CLI.

### 6. Bind the three repos, then push to the fleet

Slugs verified by reading each directory's `origin` on zion:

| Directory | Remote |
| --- | --- |
| `~/src/github.com/muqsitnawaz/agents-cli` | `phnx-labs/agents-cli` |
| `~/src/github.com/muqsitnawaz/agents-cli-web` | `phnx-labs/agents-cli-web` |
| `~/.agents/.system` | `phnx-labs/.agents-system` |

```yaml
# ~/.agents/projects/agents-cli.yaml
name: agents-cli
description: Agents CLI and Factory
root: ~/src/github.com/muqsitnawaz/agents-cli
defaultPath: ~/src/github.com/muqsitnawaz/agents-cli
repo: phnx-labs/agents-cli
repos:
  - slug: phnx-labs/agents-cli
    path: ~/src/github.com/muqsitnawaz/agents-cli
  - slug: phnx-labs/agents-cli-web
    path: ~/src/github.com/muqsitnawaz/agents-cli-web
  - slug: phnx-labs/.agents-system
    path: ~/.agents/.system
linear:
  projectId: 8eb8f5b1-3870-4590-ba67-36f3811d1435
  name: Agents CLI
```

Fleet propagation is not automatic. `~/.agents/projects/` is syncable, not synced — an uncommitted definitions directory has been deleted twice by a reconcile (`projects.ts:10-16`).

```bash
agents repo push user                       # on zion
agents ssh <host> 'agents repo pull user'   # every reachable device
agents ssh <host> 'agents projects view agents-cli'
```

## Public Interface

```bash
# Define a project across several directories (slug read from each dir's origin)
agents projects add agents-cli \
  --dir ~/src/github.com/muqsitnawaz/agents-cli \
  --dir ~/src/github.com/muqsitnawaz/agents-cli-web \
  --dir ~/.agents/.system

# Amend an existing definition
agents projects set agents-cli --add-dir ~/.agents/.system
agents projects set agents-cli --rm-dir  ~/.agents/.system
agents projects set agents-cli --add-dir ./vendor/thing --slug phnx-labs/thing  # no origin

# Spawning: unchanged flags, wider reach
agents run claude --project agents-cli                  # cwd + sibling grants
agents run claude --project agents-cli --host yosemite-s0
agents teams create my-feature --project agents-cli     # NEW flag on teams
```

Unchanged: `--project <slug>[@worktree]` syntax, its mutual exclusion with `--cwd` / `--remote-cwd`, and the directory it resolves as cwd. Nothing that works today changes meaning.

## To-do

- [ ] **1** — `--dir` on `projects add`; `--add-dir` / `--rm-dir` on `projects set`; slug from origin; fix the stale `agents push/pull` note
- [ ] **2** — `projectDirsAbs()` in `lib/projects.ts`; refactor `workspaceTargetsForDef` onto it
- [ ] **3** — `agents run --project` merges secondary dirs into `--add-dir`, local and `--host`
- [ ] **4** — `--project` on `teams create`, honored in `teams add` cwd precedence and `buildCommand`
- [ ] **5** — extension `New Agent` emits `--project`; `defToManaged` carries all dirs
- [ ] **6** — bind the three repos; `repo push user` and pull across the fleet
- [ ] **7** — tests, `docs/11-projects.md`, CHANGELOG

Steps 1 through 3 are the spine. Steps 4 and 5 are independent consumers of step 2 and can land in parallel. Step 6 needs only step 1.

## Validation

| Check | Expected result |
| --- | --- |
| `projectDirsAbs` unit | Non-existent dir filtered locally, kept under `forRemote`; `subpath` joined; paths stored `~/…` |
| `--dir` unit | Slug inferred from `origin`, not from the directory path |
| `agents projects view agents-cli` | Three `repo` lines, each with its own path |
| `agents run claude --project agents-cli` | cwd is `agents-cli`; two `--add-dir` flags for the siblings |
| Grant is real | Inside the spawned agent, read a file under `~/.agents/.system` and edit one under `agents-cli-web` |
| `--host yosemite-s0` | Forwarded paths are `~/…`, not `/Users/muqsit/…` |
| `agents teams create … --project agents-cli` | Teammate lands in the primary dir with sibling grants |
| Extension Cmd-Shift-A | Terminal shows `agents run <agent> --interactive --project agents-cli` |
| Fleet | `projects view` matches on one Linux worker and one Mac; a box missing `agents-cli-web` skips it without error |

```bash
# the spine, end to end
agents projects view agents-cli
agents run claude --project agents-cli --print-command
agents run claude --project agents-cli --host yosemite-s0 --print-command
agents teams create dirs-check --project agents-cli
agents teams add dirs-check claude "list your accessible roots" --name probe
```

## Risks

| Risk | Mitigation |
| --- | --- |
| A directory in `repos[]` is absent on some fleet box | `projectDirsAbs` filters non-existent dirs for local resolution; the definition still loads and the primary cwd still resolves |
| `--project` and `--cwd` both emitted by the extension | They are mutually exclusive (`exec.ts:598`); the two branches are exclusive by construction and covered by a test |
| Grants silently dropped on non-Claude/Codex harnesses | Named in the docs and in `--project` help text rather than papered over; no fallback path is invented |
| Definitions lost before they sync | `agents repo push user` immediately after step 6, per the warning at `projects.ts:10-16` |
| Refactoring `workspaceTargetsForDef` changes `projects status` | Existing probe tests must pass unchanged; the new function returns the same set plus ordering |

## Tracking

| Item | Id | State |
| --- | --- | --- |
| Ticket | [RUSH-2489](https://linear.app/phnx-labs/issue/RUSH-2489) — *agents projects: a project is a set of directories, each with its own remote* | Doing |
| Linear project | Agents CLI (`8eb8f5b1-3870-4590-ba67-36f3811d1435`) | — |

Step 6 (binding the three directories to `agents-cli.yaml`) landed separately as
`~/.agents@7c57a54`, before the CLI could write `repos[]` — the definition was
hand-edited. Steps 1-5 and 7 are the implementation this plan describes.
