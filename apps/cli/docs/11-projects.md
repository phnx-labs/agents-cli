# Projects (Named Multi-Repo Projects + Progress Rollup)

A **project** names a body of work, binds it to one or more repos, and rolls the
fleet's live activity up into one progress card. It is a **definition layer over the
existing `--project` convention**, not a replacement — an undefined slug resolves
exactly as before.

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
  - kind: gdrive  url: https://drive.google.com/…  label: "design docs"
linear:
  projectId: a1b2c3d4-…
```

| Field | Purpose |
| --- | --- |
| `name` | Stable id, == filename. What `--project` takes. |
| `root` | Repo / monorepo root, home-relative → portable. |
| `defaultPath` | Where an agent's cwd lands (a monorepo subdir). Defaults to `root`. |
| `repo` / `repos[]` | GitHub slug(s), each with an optional `subpath`, for the PR/merge rollup. |
| `contexts[]` | `{path, purpose}` described starting points — indexed anchors for agents. |
| `integrations[]` | `{kind, url, label}` external context sources. |
| `linear` | `{projectId, url}` — reuses the existing Linear path. |

## Resolution — definition first, convention fallback

`resolveProjectRef` (`lib/project-root.ts`) looks up a named definition before the
`<root>/<slug>` convention. A defined project resolves to its `defaultPath` (or
`root`); a `@worktree` suffix lands under the repo root's `.agents/worktrees/`. An
**undefined** slug falls through to the unchanged convention. Home-relative paths mean
`--project rush --host <box>` re-roots on the remote's home automatically.

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
  ships    4 merged (7d) · 2 open PRs · 3 worktrees  # gh merged-PR count + open PRs held
  tickets  RUSH-1201 · RUSH-1198 · …              # tickets worked or created
  proof    11 artifacts (7d) · last: plan-x.html  # artifact.created milestones by cwd
  repos    phnx-labs/rush · rush-infra
  context  apps/web · packages/api
```

- **`live`, `plan`, open PRs, `tickets`, `worktrees`** come straight from the active
  session list (`rollupSessionsByProject`) — no network.
- **`ships` merged-count** is a best-effort `gh pr list` on the primary repo
  (`--no-remote` skips it; a missing `gh`/auth degrades to 0).
- **`proof`** counts `artifact.created` activity milestones whose cwd is inside the
  project (`lib/project-status.ts`).
- `--window <days>` sets the merged-PR / artifact window (default 7).

## Command surface

| Command | Does |
| --- | --- |
| `agents projects list [--json]` | All projects: root, repo, live agent count. |
| `agents projects add <name>` | Scaffold `<name>.yaml`; infers `root` + origin slug from the current repo. Flags: `--root`, `--path`, `--repo`, `--context path:purpose`, `--linear`. |
| `agents projects show <name> [--json]` | Full definition + resolved paths + contexts + links. |
| `agents projects edit <name>` | Open the YAML in `$EDITOR`. |
| `agents projects status [name] [--json] [--window N] [--no-remote]` | The progress card (all projects, or one). |
| `agents projects import --from-factory` | Absorb `~/.agents/factory/projects.json` into YAML definitions. |
| `agents projects rm <name>` | Delete the definition (never touches the repo). |

`agents run --project <name>` is unchanged in spelling — it just resolves richer
definitions now.

## Not yet (fast-follow)

- **Fleet-wide live rollup.** Today the live-agent count is this machine's active
  sessions; a fan-out across `agents devices` plus home-relative cwd matching (so a
  session from a different-home machine still maps to the project) would make it truly
  cross-fleet.
- **Re-point `agents factory snapshot`** per-project Linear rollup at defined projects.
- **Richer Linear ticket-state counts** on the card.
- **Persisted `project_id` session column** — today membership is derived from cwd.
