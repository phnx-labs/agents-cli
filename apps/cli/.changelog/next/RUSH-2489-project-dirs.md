- **A project is now a set of directories, and every spawn path reaches all of them (RUSH-2489).**
  `ProjectDef.repos[]` could already name additional checkouts, but nothing wrote it and nothing
  that started an agent read it: `agents run --project rush` landed in `defaultPath ?? root` and
  every other repo the project bound was invisible to the agent. Work spanning a CLI, its website,
  and the DotAgents repo it ships into needed three agents or a hand-passed `--add-dir`.

  **Writing.** `agents projects add` gains a repeatable `--dir <path...>`; `agents projects set`
  gains repeatable `--add-dir <path>` / `--rm-dir <path>` plus `--slug <owner/repo>`. Each value
  names a **local directory** and the slug is read from **that directory's own `origin` remote**,
  never inferred from its path — a checkout at `~/src/github.com/muqsitnawaz/agents-cli` whose
  origin is `phnx-labs/agents-cli` records what it actually pushes to. `--slug` covers a directory
  with no origin and applies to a single `--add-dir`. Removals apply before additions, so
  `--rm-dir old --add-dir new` re-points a directory in one command. Binding a directory twice,
  unbinding one that is not bound, and naming a path that does not exist are all refused with the
  fix named.

  **Spawning.** `agents run --project` keeps returning the primary directory as cwd — unchanged —
  and merges the project's other directories into `--add-dir`, deduped against anything passed
  explicitly, locally and over `--host` (forwarded `~/…`, which the receiving `agents run` expands
  against the host's own `$HOME`).
  `agents teams create` gains `--project <slug>`: it is validated at create time rather than at the
  first `teams add`, the project's primary directory becomes a local teammate's base cwd, and the
  sibling directories are attached as grants. The teammate record stores the project **name**, not
  a frozen list of directories, and the grants resolve per launch — an unpinned teammate on a
  `--devices` pool only learns its host from the scheduler at launch time, so add-time resolution
  would have handed it this box's absolute paths (and already dropped any directory that exists
  only on the host it landed on). The team cwd precedence is now
  `worktree → --cwd → project directory → process.cwd()`, so an explicit `--cwd` still wins; the
  grants are attached either way, since the siblings are what the project binds rather than where
  the teammate sits. A `--project slug@worktree` run keeps the worktree as cwd and grants the main
  checkout alongside the siblings. A teammate staged behind `--after` resolves its grants when the
  supervisor finally launches it, so a restart in between changes nothing.

  **Two honest limits, stated rather than papered over.** Only Claude and Codex consume
  `--add-dir` (Claude takes the native flag, Codex folds the paths into `workspace_roots`); every
  other harness ignores the grants and sees the cwd alone. And a bound directory that is absent
  from the current box is skipped for a local spawn rather than erroring — but is **kept** for a
  `--host` run, because the target machine has its own checkouts and this box's filesystem must not
  decide what exists there.

  **`--add-dir` values are now `~`-expanded at the consumer** (`buildExecCommand`, for both the
  Claude flag and Codex's `workspace_roots`). Nothing was doing it: a forwarded grant crosses the
  SSH boundary single-quoted, so the remote login shell left `~/…` literal and the harness resolved
  it as a directory actually named `~` — a silent no-op. This also fixes the pre-existing case of a
  user typing `--add-dir '~/x'` on a `--host` run.

  The `repos[]` walk is now one function shared by the spawn path and the fleet workspace probe
  (`projects status`), which previously had its own copy. The probe keeps its own primary (`root`,
  not `defaultPath`, so a monorepo subproject still probes its checkout) and keeps missing
  directories so it can still report `✗ missing`. Also corrects the `agents projects` help note,
  which still told users to sync definitions with the long-removed `agents push/pull` instead of
  `agents repo push user`. Source: `apps/cli/src/lib/projects.ts` (`projectDirsAbs`,
  `projectProbeTargets`), `apps/cli/src/lib/project-root.ts` (`resolveProjectDirs`),
  `apps/cli/src/commands/projects.ts` (`projectRepoFromDir`), `apps/cli/src/commands/exec.ts`,
  `apps/cli/src/commands/teams.ts`, `apps/cli/src/lib/teams/{registry,agents,api}.ts`,
  `apps/cli/docs/projects.md`.
