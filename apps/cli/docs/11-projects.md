# Projects (Named Multi-Repo Projects + Progress Rollup)

A **project** names a body of work, binds it to one or more repos, and rolls live
activity up into one progress card. It is a **definition layer over the existing
`--project` convention**, not a replacement — an undefined slug resolves exactly as
before.

> Beta. Enable with `agents beta enable projects` (the command tree is hidden until then).

## Why

`agents run --project <slug>` already resolves a bare name to `<projectRoot>/<slug>`
by pure convention (`lib/project-root.ts`). That cannot name a project independently
of its folder, bind multiple repos, pin a monorepo subpath, or answer *"what is
happening on project X right now"*. At 50–100 agents the per-agent activity line is
noise; what matters is the **project**. This subsystem fills both gaps.

## The definition — `~/.agents/projects/<name>.yaml`

One hand-editable YAML file per project, beside `routines/` and `monitors/` in the
user repo, so it syncs across machines via `agents push/pull`. Paths are stored
home-relative (`~/…`) so a definition re-roots on any machine.

```yaml
name: rush                      # stable id == filename; what --project takes
description: "Rush app"
root: ~/src/github.com/phnx-labs/rush
defaultPath: ~/src/github.com/phnx-labs/rush/apps/web   # where an agent's cwd lands
repo: phnx-labs/rush            # primary GitHub slug (PR / merge rollup)
repos:                          # additional repos, each with an optional monorepo subpath
  - slug: phnx-labs/rush-infra
contexts:                       # described starting points — an agent reads `purpose`
  - path: apps/web
    purpose: "user-facing Next.js app; funnel + growth surfaces"
  - path: packages/api
    purpose: "FastAPI backend; Supabase models live here"
integrations:                   # external context, surfaced in `projects show`
  - kind: gdrive
    url: https://drive.google.com/…
    label: "design docs"
linear:
  projectId: a1b2c3d4-…
```

| Field | Purpose |
| --- | --- |
| `name` | Stable id, == filename. What `--project` takes. |
| `root` | Repo / monorepo root, home-relative → portable. |
| `defaultPath` | Where an agent's cwd lands (a monorepo subdir). Defaults to `root`. |
| `repo` / `repos[]` | GitHub slug(s), each with an optional `subpath`, for the PR/merge rollup. `repos[].path` (home-relative) names that repo's local checkout and opts it into workspace probing (`status --fleet`). |
| `contexts[]` | `{path, purpose}` described starting points — indexed anchors for agents. |
| `integrations[]` | `{kind, url, label}` external context sources. |
| `linear` | `{projectId, url}` — reuses the existing Linear path. |

## Resolution — definition first, convention fallback

`resolveProjectRef` (`lib/project-root.ts`) looks up a named definition before the
`<root>/<slug>` convention. A defined project resolves to its `defaultPath` (or
`root`); a `@worktree` suffix lands under the repo root's `.agents/worktrees/`. An
**undefined** slug falls through to the unchanged convention. Home-relative paths mean
`--project rush --host <box>` re-roots on the remote's home automatically.

Resolution is intentionally **not** beta-gated — only the `agents projects` command
tree is. A definition exists solely by explicit user action (`projects add`,
`import --from-factory`, or hand-authoring the YAML), so honoring it in `--project`
resolution is additive and safe; users without any definitions see zero change.

## One name everywhere — activity, feed, sessions

Definitions also rename the fleet's activity. `resolveProjectNameForCwd`
(`lib/projects.ts`) is the single project resolver shared by the `agents activity`
timeline (buckets and row chips), `agents feed post` (the stamped project), and the
`agents sessions` overview: a cwd inside a defined project's root reads as the
project's **name** — a multi-repo project is one bucket, not one per repo — and
anything else falls back to the repository-level key (`lib/project-key.ts`). Each
machine resolves its own cwds against its own (synced) definitions before events
cross the wire. `agents activity --project <name>` narrows the stream to one
project, exact-matched on this label.

## The progress card — `agents projects status`

The headline. It matches every live session to a project **by cwd** (longest root
wins) and rolls up the signals already on disk. The live-agent rollup is over this
machine's active sessions (the same set `agents sessions --active` shows, matched by
local-home cwd); the **merged-PR count is repo-global** (via `gh`). A fleet-wide live
rollup — SSH fan-out plus home-relative cwd matching so a session recorded on a
different-home machine still matches — is a deferred follow-up (see below):

```
rush  ·  23 agents  ·  68% plan
  live     14 running · 6 idle · 3 need-input     # active sessions by lifecycle state
  agents   claude · running · RUSH-2107 @zion  ·  codex · idle @mac-mini  ·  +21 more
  ships    4 merged (7d) · 2 open PRs · 3 worktrees · v1.20.91  # gh counts + latest release tag
  linear   12/30 done · 5 in progress           # Linear issue counts (needs linear.projectId)
  tickets  RUSH-1201 · RUSH-1198 · …              # tickets worked or created
  proof    11 artifacts (7d) · last: plan-x.html  # artifact.created milestones by cwd
  repos    phnx-labs/rush · rush-infra
  context  apps/web · packages/api
```

- **`live`, `agents`, `plan`, open PRs, `tickets`, `worktrees`** come straight from the
  active session list (`rollupSessionsByProject`) — no network. The `agents` line
  shows WHICH harness is on the project (one cell per session:
  `agent · status · TICKET @host`), sorted running-first, capped at 6 with a
  `+N more` tail. Under `--fleet` the remote sessions carry their peer's hostname.
- **`ships` merged-count** is a best-effort `gh pr list` on the primary repo
  (`--no-remote` skips it; a missing `gh`/auth degrades to 0). It counts up to the
  100 most recent merges within the window. The trailing tag is the **latest release
  of the primary repo only** (`gh release list -L 1`; `repos[]` are not scanned),
  absent when the repo has no releases.
- **`linear`** counts issues by state TYPE (completed → done, started → in progress)
  in the Linear project bound via `linear.projectId` — set it with
  `agents projects link <name> --linear`. Best-effort: no credential, offline, or a
  slow API (>8s) just omits the line, and `--no-remote` skips it too.
- **`proof`** counts `artifact.created` activity milestones whose cwd is inside the
  project (`lib/project-status.ts`).
- `--window <days>` sets the merged-PR / artifact window (default 7).

### `--fleet` — per-device workspace drift

Projects are natively multi-device, so `status --fleet` adds a `fleet` line per
project showing the state of its workspace repos on every fleet device — present
or missing, on which branch, ahead/behind the upstream, and uncommitted changes:

```
rush  ·  3 agents
  live     2 running · 1 idle
  ships    4 merged (7d)
  fleet    zion: ✓ clean · main  ·  mac-mini: ⚠ 12 dirty · ↑3 · feature/x  ·  gpu-box: ✗ missing
```

- **What it dials.** One parallel SSH call per online device (the canonical
  `remote-agents-json` fan-out, 12s per-peer timeout) running the hidden
  `agents projects probe --json <path...>` on each peer, plus the existing
  sessions fan-out so the card's `live` line counts agents on every box, not
  just this machine. Local paths are probed directly.
- **What's probed.** Each shown def's `root` plus every `repos[].path` — the
  field that opts an additional repo into drift tracking (the def otherwise
  only knows the primary `root` on disk). Paths are home-relative, so they
  re-root on each peer.
- **Drift is against the last-fetched upstream.** The probe never runs
  `git fetch` — `↑`/`↓` measure against the peer's remote-tracking refs as they
  are. A repo with no upstream reports no drift (not zero).
- **Unreachable or older peers are named once** in a trailing note
  (`· N devices didn't answer (unreachable, older agents-cli, or timed out): …`)
  — a peer whose CLI predates the probe subcommand lands in the same skipped
  list, never a silent gap. The `probe` subcommand itself is not beta-gated, so
  peers answer whenever their binary carries it.
- `--json` includes the fleet data: per project `workspaces: [{host, path,
  present, branch, upstream, ahead, behind, dirty, lastCommit, error}]`.
- Default is off — `--fleet` is the opt-in because it dials the fleet.

## Command surface

| Command | Does |
| --- | --- |
| `agents projects list [--json]` | All projects: root, repo, live agent count. |
| `agents projects add <name>` | Scaffold `<name>.yaml`; infers `root` + origin slug from the current repo. Flags: `--root`, `--path`, `--repo`, `--context path:purpose`, `--linear`. |
| `agents projects show <name> [--json]` | Full definition + resolved paths + contexts + links. |
| `agents projects edit <name>` | Open the YAML in `$EDITOR`. |
| `agents projects status [name] [--json] [--window N] [--no-remote] [--fleet]` | The progress card (all projects, or one). `--fleet` adds per-device workspace drift over SSH. |
| `agents projects link <name> --linear [query]` | Bind a Linear project into the def (`linear.projectId` + url). No query → auto-suggests from the def name + repo slug; ambiguous/none lists candidates and exits 1. Powers the `linear` card line. |
| `agents projects import --from-factory` | Absorb `~/.agents/factory/projects.json` into YAML definitions. |
| `agents projects rm <name>` | Delete the definition (never touches the repo). |

`agents run --project <name>` is unchanged in spelling — it just resolves richer
definitions now.

## Not yet (fast-follow)

- **Fleet-wide live rollup by default.** `status --fleet` already widens the
  live-agent count to the whole fleet (via the sessions fan-out) and adds
  per-device workspace drift, but fleet remains opt-in, and cwd matching is
  still local-home — a session recorded on a different-home machine only matches
  once home-relative cwd matching lands.
- **Re-point `agents factory snapshot`** per-project Linear rollup at defined projects.
- **Per-repo release lines** — the `ships` release tag is the primary repo only.
- **Persisted `project_id` session column** — today membership is derived from cwd.
