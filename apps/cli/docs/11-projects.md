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
user repo. Paths are stored home-relative (`~/…`) so a definition re-roots on any
machine.

> **Commit them, or lose them.** Sitting in the user repo makes a definition
> *syncable*, not synced. `agents projects add` writes the file; nothing commits it.
> Until you run `agents repo push user`, `projects/` is an **untracked** directory, and
> any reconcile that cleans the working tree deletes it — this cost one machine its four
> definitions twice in a day. The only trace afterwards is a
> `chore(local): save …-sync drift` commit that is unreachable from `HEAD`, so it is
> recoverable until git collects it and not after. Recover with:
>
> ```bash
> cd ~/.agents
> git log --all --oneline --diff-filter=A -- 'projects/*'   # find the drift commit
> git show <sha>:projects/<name>.yaml > projects/<name>.yaml
> ```
>
> (`agents push` was removed; the command is `agents repo push <alias>`. Note that it
> stages with `git add -A`, so check `git status` for unrelated drift first.)

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
`projects import`, or hand-authoring the YAML), so honoring it in `--project`
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

## `view` is `status` for one project, plus the definition

`status` answers *"is anything off track?"* across projects. `view <name>` answers *"tell me
everything about this one"* — so it must be a **superset**, never a different, thinner card.

It was thinner. `view` built its own picture (root, repos, a raw Linear id, an issue count,
milestones) and never called the card renderer, so opening a single project showed strictly
less than the roll-up across all of them: no agents, no ships, no focus, no schedule verdict.
The renderer even took a `milestoneLimit` parameter documented as "`status` shows the next one;
`view` shows all" — the seam was designed and then not connected.

Both commands now gather through one function (`enrichProjectsForRender`) and render through
one card, so a signal added for either appears on both. `view` differs in exactly two ways:
every milestone instead of the next one, and the stored definition printed in full underneath
(each repo with its subpath and checkout, each context with its purpose, each integration with
its URL, the Linear link, the docs, and the YAML path).

## The progress card — `agents projects status`

The headline. It matches every live session to a project **by cwd** (longest root
wins) and rolls up the signals already on disk. The live-agent rollup is over this
machine's active sessions (the same set `agents sessions --active` shows, matched by
local-home cwd); the **merged-PR count is repo-global** (via `gh`). A fleet-wide live
rollup — SSH fan-out plus home-relative cwd matching so a session recorded on a
different-home machine still matches — is a deferred follow-up (see below):

```
rush  ·  23 live
  live     14 running · 6 idle · 3 need-input     # LIVE sessions by lifecycle state
  dead     4 finished or lost (3 crashed, 1 closed)
  agents   claude · running · RUSH-2107 @zion  ·  codex · idle @mac-mini  ·  +21 more
  ships    4 merged (7d) · 2 open PRs · 3 worktrees · v1.20.91  # gh counts + latest release tag
  linear   12/30 done · 5 in progress           # Linear issue counts (needs linear.projectId)
  next     Beta cut  ·  3/8  ·  due in 6 days     # the next unfinished Linear milestone
           +2 more milestones — agents projects view <name>
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
  slow API (>8s) just omits the line, and `--no-remote` skips it too. `total`
  includes canceled issues; the fetch caps at 2,500 issues and a capped count
  renders as a lower bound (`2500+ done`), never as the complete total.
- **`next`** is the project's next unfinished Linear milestone — the earliest
  `targetDate` that is not yet complete — rendered `name · done/total · due …`.
  A percentage says how far along a project is; the milestone says what it is due
  to hit next, which is what a person plans around. Undated milestones sort last;
  the line is omitted when the project declares none or all are complete.

  The milestone **list comes from the project, not from its issues**
  (`project.projectMilestones`), because a milestone commonly has nothing filed
  under it yet — deriving the list from issue assignments hides exactly those.
  Issues supply only the `done/total` progress, and when none are assigned the
  fraction is omitted rather than printed as a meaningless `0/0`. The list rides
  along on the **first** page of the existing issue fetch, so the line costs no
  extra request and inherits the same 8s budget and best-effort degradation.

  Dates read in human terms — `due today`, `due tomorrow`, `due in 6 days`,
  `overdue by 3 days`, and `due Aug 21` once a countdown stops being useful.
  Linear stores a calendar date with no timezone, so both sides are compared at
  **local** midnight; parsing it as UTC would shift the answer by a day for
  anyone west of Greenwich.
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
| `agents projects view <name> [--json] [--window N] [--no-remote]` (alias `show`) | Everything about one project: the whole `status` card (agents, ships, focus, schedule, tickets, proof), **every** Linear milestone, then the stored definition in full. |
| `agents projects edit <name>` | Open the YAML in `$EDITOR`. |
| `agents projects status [name] [--json] [--window N] [--no-remote] [--fleet]` | The progress card (all projects, or one). `--fleet` adds per-device workspace drift over SSH. |
| `agents projects link <name> --linear [query]` | Bind a Linear project into the def (`linear.projectId` + url). No query → auto-suggests from the def name + repo slug; ambiguous/none lists candidates and exits 1. Powers the `linear` card line. |
| `agents projects import --from-linear` | Import the workspace's Linear projects (via the `linear` CLI) as definitions. See [Importing](#importing--linear-first-factory-gated). |
| `agents projects import --from-factory [--min-confidence low\|medium\|high] [--all]` | Absorb `~/.agents/factory/projects.json`. Imports only `high`-confidence rows by default. |
| `agents projects set <name> [--repo\|--root\|--path\|--description]` | Change one field, preserving every other. Use this rather than `add --force`, which rebuilds the definition from flags alone. |
| `agents projects rm <name>` | Delete the definition (never touches the repo). |

`agents run --project <name>` is unchanged in spelling — it just resolves richer
definitions now.

## Importing — Linear first, Factory gated

Both sources write the **same** `ProjectDef` schema through `writeProjectDef`, and
neither invents a field. What differs is how much each source knows.

**`--from-linear` is the preferred source.** A Linear project exists because someone
deliberately created it, so the name and the link are trustworthy. Each project
becomes a def carrying `linear.projectId` (+ `url` when the CLI reports one), and
the `show` backlink lights up immediately.

The local checkout is bound **only on an exact normalized-name match** against the
directories under the configured projects root (`matchLocalCheckoutExact`,
`lib/linear-projects.ts`) — "Agents CLI" binds `agents-cli`, and nothing else. The
containment fallback that powers `projects link`'s suggestion is deliberately not
used on this write path: it would silently bind "Agents CLI" to `agents-cli-web`
with nobody looking. A project with no exact local match still imports, carrying
`name` + `linear` and nothing it cannot prove; fill the rest in with
`projects set` or by editing the YAML.

Re-importing is safe. An existing def is preserved field-for-field and only
`linear` is overwritten, so a hand-set `description`, `contexts`, or `integrations`
survives. A def that already carries `root`/`repo` is skipped unless `--force`,
so a re-import never re-points a project you have already bound by hand.

**`--from-factory` is a guess, so it is gated.** Factory's registry is
auto-detected from checkouts on disk and stamps each row with a
`confidence` — `high`, `medium`, `low`, or nothing at all. Importing every row is
what buried two real projects under a dozen stale clones and someone else's repo,
so the import takes only `high` rows by default:

```
agents projects import --from-factory                      # high only (default)
agents projects import --from-factory --min-confidence medium
agents projects import --from-factory --all                # every row, even unranked
```

`--all` is the only floor that takes a row stating **no** confidence — an unranked
guess sits below `low`. An unrecognized `--min-confidence` value is an error, never
a quiet fall back to the default. Every declined row prints its reason:

```
Imported 2 projects (3 skipped)
  skip swarmify: confidence "medium" is below the "high" floor
  skip inflow: confidence "low" is below the "high" floor
  skip agents-cleaned-stale2: no confidence field is below the "high" floor
  (widen with --min-confidence medium or --all)
```

The two sources are mutually exclusive in one invocation, and `--min-confidence` /
`--all` are rejected on `--from-linear` (Linear rows carry no confidence) rather
than silently ignored. Drop a bad import with `agents projects rm <name>` — it only
unlinks the YAML, never the repo.

## Not yet (fast-follow)

- **Fleet-wide live rollup by default.** `status --fleet` already widens the
  live-agent count to the whole fleet (via the sessions fan-out) and adds
  per-device workspace drift, but fleet remains opt-in, and cwd matching is
  still local-home — a session recorded on a different-home machine only matches
  once home-relative cwd matching lands.
- **Re-point `agents factory snapshot`** per-project Linear rollup at defined projects.
- **Per-repo release lines** — the `ships` release tag is the primary repo only.
- **Persisted `project_id` session column** — today membership is derived from cwd.

## The stored `repo` must match the checkout's remote

A definition's `repo` is a plain string that nothing used to validate, so it could be
confidently wrong. That is not hypothetical: Factory seeds the registry with a slug derived
from the checkout path's last two segments (`repoSlugFromPath`,
`apps/factory/src/core/projectIndex.ts`), so a repo cloned to
`~/src/github.com/<you>/agents-cli` whose `origin` is `phnx-labs/agents-cli` was imported as
`<you>/agents-cli`.

Both slugs resolve to real repositories, so no call failed. The card simply read the merged-PR
and release counts from a **different repo** — 0 merges in 7 days instead of 100. A wrong
number that looks right is worse than a missing one, so:

- `import --from-factory` reads the checkout's real `origin` and overrides the registry slug,
  falling back to the path guess only when there is no remote to ask.
- `status` and `show` print the disagreement with its fix attached whenever a def's `repo`
  differs from the remote of its `root`:

  ```
  repos    muqsitnawaz/agents-cli
  !        repo is muqsitnawaz/agents-cli but origin is phnx-labs/agents-cli —
           PR and release counts are being read from the wrong repository
           agents projects set agents-cli --repo phnx-labs/agents-cli
  ```

The check is silent when this machine has no checkout to read a remote from — absence of
evidence is not a finding.

## The Linear line is cached, and degrades to stale rather than absent

Linear meters requests and query complexity separately, and only one of them binds. Measured
on this workspace's response headers:

```
x-ratelimit-requests-limit:   2500      remaining: 2
x-ratelimit-complexity-limit: 3000000   remaining: 2999987
```

Requests are scarce; complexity is essentially untouched. Since the card pages every issue in
a project (up to 10 requests each), an agent running `status` in a loop exhausts the budget —
which is exactly how it was exhausted during this feature's development.

Answers are cached under `~/.agents/.cache/linear-projects/` for 10 minutes, matching the
repo's existing `SKILL_INDEX_TTL_MS` convention — **one file per project**, written by atomic
rename. A single shared JSON document would have to be read, modified, and written back, and
that sequence is not atomic across processes: measured with two concurrent writers of 40
distinct keys each, **8 of 80 entries survived**. A machine running a dozen agent sessions
makes that the normal case rather than a corner. Per-key files have nothing to clobber, and the
same measurement now yields 80 of 80. A second `status` inside the window makes no
Linear request at all.

The behavior that matters more is on failure: **a stale answer is served and labelled, never
dropped.** A Linear row that was populated a minute ago must not blank out because one fetch
timed out — the same invariant `mergeAuthHealthEntries` keeps for account health. A 429 records
its reset time so subsequent runs skip the call entirely instead of spending a request to learn
the budget is gone.

`AGENTS_LINEAR_CACHE_PATH` overrides the location (tests use it; `getCacheDir()` resolves
`HOME` once at module load, so a test swapping `process.env.HOME` would otherwise read and
write the developer's real cache).

## The headline counts live agents, and `planPct` is gone

Two numbers used to sit on the headline and neither meant what it looked like.

**The agent count included dead sessions.** A real project read `39 agents` while 19 of those
had crashed. It now reads `19 live`, and the wreckage gets its own row — `dead  19 finished or
lost (19 crashed)` — because 19 crashed sessions is a thing to go fix, not throughput to brag
about. `orphaned` counts as **live**: `lib/session/active.ts` defines it as "alive, but no
client is attached" (the agent outlived its window and is still working), and the repo's own
dead rule (`commands/sessions.ts`) is `closed` and `crashed` only.

The `agents` roster below the headline is filtered the same way. It used to list every matched
session, so a card headed `23 live` went on to print `claude · crashed ×25` — the corpses the
`dead` row already accounts for, shown a second time and contradicting the number above them.
`isDeadStatus` is the single predicate behind both, and a test pins them to agree across every
`ActiveStatus` so they cannot drift apart.

**`planPct` measured whichever agent last wrote a todo list.** It summed each matched session's
most recent checklist snapshot, so:

- no session had ever called `TodoWrite` → `total = 0` → the figure silently disappeared;
- one agent opened a fresh 40-item plan → `0/40` → the whole project read **`0% plan`** while
  everyone else worked.

It also counted crashed sessions' frozen final checklists forever, and summed unrelated
denominators as though they were one plan. No repair makes a cross-session sum of ad-hoc
checklists mean project progress, so it is removed from the card and from `--json`, replaced
there by `live` and `dead`.

## Milestones: all of them, and Linear's own "next"

`status` shows the next checkpoint plus a pointer; `view <name>` shows every declared
milestone with its date and progress. When Linear itself flags one (`status: "next"`) that is
the one used — it is the answer showing in Linear's UI, whereas earliest-dated-unfinished is
only our guess, used when nothing is flagged.

A milestone with no issues assigned reports no progress, and `view` says so once rather than
printing a column of silent `0%`s:

```
    !          no issues are assigned to any milestone — progress against them
               cannot be measured
```

## `focus` — what was actually worked on

The card could say how many agents ran and how many PRs merged, but not *what was worked on*.
That answer is already in the checkout: every commit names the files it touched. `focus` ranks
the directories the window's commits landed in, three levels deep so a monorepo reads as
`apps/cli/src` rather than `apps`:

```
focus    apps/cli/src 2138  ·  apps/cli/docs 278  ·  apps/factory/src 208  ·  apps/cli/menubar 81
```

Local `git log --name-only`, no GitHub API, no credential, no rate-limit budget — measured at
**0.23s** over a 897-commit week, which is why it runs unconditionally rather than behind a flag.
It reads the local ref and never fetches: a status command must not mutate the repo it describes,
so the answer is as fresh as your last fetch.

**Changelog fragments and lockfiles are excluded from the ranking, not just the display.** This
repo files one fragment per PR, so `.changelog` otherwise ranks second by raw file-touches —
presenting PR count as an engineering focus area.

## `schedule` — only what the dates prove

```
schedule 3 milestones, no issues filed against any — progress is not measurable
schedule Beta cut overdue by 6 days
schedule GA due in 9 days
```

| Verdict | Fires when |
| --- | --- |
| `declared` | a human posted a Linear project health update — relayed and attributed (`per Linear: atRisk`) |
| `overdue` | a milestone's `targetDate` has passed and it is unfinished |
| `untracked` | milestones exist but no issue is filed against any of them |
| `due-soon` | the next dated milestone lands within 14 days |
| `scheduled` | dated milestones ahead, none due soon, work is filed |
| `no-dates` | milestones exist, none carries a date |
| `none` | the project declares no milestones — the line is omitted entirely |

**There is deliberately no `on-track` or `at-risk`.** Producing one requires either project
start+target dates to interpolate an expected-progress line, or a scope-history series to
extrapolate a finish date. Probed against a live workspace, every one of those inputs is empty:

```
health: null       startDate: null        targetDate: null
scopeHistory: []   completedScopeHistory: []   inProgressScopeHistory: []
```

So the chip would be invented. A blank is bad; a confident wrong answer that gets trusted is
worse, and it is unfalsifiable from the card. The union has no such member, so it cannot be
produced by accident later either.

## Monorepo subprojects: which project owns a session

Attribution (`projectNameForCwd`) matches a session's cwd against the paths each project
claims, longest match winning so a nested project beats its parent. What a project *claims*
is the part that needed fixing:

- `root` says where the **checkout** is.
- `defaultPath`, when nested under `root`, says which **work** is this project's, and takes
  precedence over `root`.
- a narrowed `root` still claims the rest of its checkout, but only as a fallback: any other
  project claiming that path outright wins. So the umbrella takes `apps/web` when one exists,
  while a lone project keeps attributing work across its own repo.
- each `repos[].path`, and `repos[].path` + `subpath`, anchor as well.

Without this, two definitions sharing one monorepo checkout — an umbrella `rush` at
`~/src/rush` and a subproject `rush-cli` at `~/src/rush` with `defaultPath ~/src/rush/apps/cli`
— both anchored at `~/src/rush`. Longest-match had nothing to separate them, so a session in
`rush/apps/cli` was attributed to whichever definition was listed first, and the answer
changed with definition order.

A subproject scoped to `apps/cli` deliberately does **not** own `apps/web`; that work falls to
the umbrella. Set the scope with `agents projects add <name> --root <monorepo> --path <subdir>`.

When the subproject is the *only* definition on that checkout there is no umbrella to fall to,
so its `root` still covers `apps/web` and the repo root. `--path` chooses where an agent
starts, and it must not silently shrink which work counts as the project's.
