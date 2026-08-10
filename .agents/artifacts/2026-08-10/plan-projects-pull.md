---
kind: plan
surface: cli
project: agents-cli
repository: phnx-labs/agents-cli
branch: plan-projects-pull
harness: codex
agent: Codex
human: project-owner
host: fleet-worker
session: redacted
date: 2026-08-10
title: Pull every reachable checkout for one project
summary: >
  Add `agents projects pull <name>` so one command fetches and safely
  fast-forwards the registered repositories for a project on this machine and
  every reachable fleet device. Local work is never reset, rebased, switched,
  or discarded; incomplete devices and blocked repositories remain visible.
status: awaiting-go
tracking: "RUSH-2536"
facts:
  - "projects status already maps root + repos[].path across the fleet"
  - "pullRepo owns fetch/integration, but strict mode must suppress its Git-hook side effect"
  - "the public command must update only a remote's default branch by fast-forward"
  - "missing checkouts are reported but not cloned"
---

## Focus for review

- **Safety contract.** The recommended command updates only a clean checkout
  already on its verified remote default branch and only by fast-forward.
  Feature branches, local commits, dirty trees, and Git hooks are untouched.
- **Fleet default.** A bare `agents projects pull agents-cli` includes this
  machine plus every reachable compute device, matching `projects status`.
- **Missing paths.** A registered path that is absent is shown as `missing` and
  skipped. This command does not clone repositories.
- **Completion signal.** Any blocked repository or unreachable/invalid peer
  makes the command exit non-zero after healthy checkouts finish. Missing paths
  alone do not make the command fail because they are not local copies.
- **Command name.** Use `pull`, not `sync`: the operation is one-way from each
  repository's remote default branch and never pushes.

## Intent

> "For agents-cli, how can we have pull of the repo for the projects? We do
> have the agents projects command that tracks the repo path on each device.
> Users should be able to quickly bring all local copies of a project to be in
> sync with remote main."

The visible outcome is one command with one truthful fleet summary. The user
does not manually copy paths from `projects status`, SSH to each machine, fetch,
inspect the branch, and decide whether a pull is safe.

## Current architecture

`projects status` already owns discovery. `workspaceTargetsForDef` expands a
definition's `root` plus each `repos[].path`; `runProjectCard` probes those paths
locally and sends one hidden JSON command to each peer through
`gatherRemoteAgentsJson`. The probe is deliberately read-only and measures
against the last-fetched upstream.

`pullRepo` in `lib/git.ts` already owns safe integration mechanics: fetch,
dirty-path collision checks, fast-forward, rebase, conflict rollback, worktree
git-dir handling, and non-`origin` tracking remotes. Its existing default must
not change because `agents repo pull` relies on rebase-preserving behavior.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 980 390" role="img" aria-label="Current manual fleet pull and proposed projects pull flow" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow-muted" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="#7a8a99"/></marker>
    <marker id="arrow-green" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="#65a30d"/></marker>
  </defs>
  <text x="20" y="26" font-family="ui-monospace,monospace" font-size="13" font-weight="700" fill="currentColor">today: status finds drift; the user performs every mutation</text>
  <rect x="20" y="48" width="210" height="54" rx="7" fill="none" stroke="#7a8a99" stroke-width="1.5"/>
  <text x="36" y="71" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">projects status</text>
  <text x="36" y="89" font-family="ui-monospace,monospace" font-size="11" fill="#7a8a99">paths + behind counts</text>
  <line x1="230" y1="75" x2="305" y2="75" stroke="#7a8a99" stroke-width="1.5" marker-end="url(#arrow-muted)"/>
  <rect x="315" y="48" width="250" height="54" rx="7" fill="none" stroke="#d97706" stroke-width="1.8"/>
  <text x="331" y="71" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">copy path · SSH · inspect git</text>
  <text x="331" y="89" font-family="ui-monospace,monospace" font-size="11" fill="#d97706">repeat per repo and device</text>
  <line x1="565" y1="75" x2="640" y2="75" stroke="#7a8a99" stroke-width="1.5" marker-end="url(#arrow-muted)"/>
  <rect x="650" y="48" width="305" height="54" rx="7" fill="none" stroke="#7a8a99" stroke-width="1.5"/>
  <text x="666" y="71" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">manual fetch / pull / conflict handling</text>
  <text x="666" y="89" font-family="ui-monospace,monospace" font-size="11" fill="#7a8a99">no composed fleet result</text>

  <text x="20" y="166" font-family="ui-monospace,monospace" font-size="13" font-weight="700" fill="currentColor">after: one controller, parallel devices, sequential repos</text>
  <rect x="20" y="188" width="230" height="58" rx="7" fill="none" stroke="#65a30d" stroke-width="2"/>
  <text x="36" y="212" font-family="ui-monospace,monospace" font-size="12" font-weight="700" fill="#65a30d">projects pull &lt;name&gt;</text>
  <text x="36" y="232" font-family="ui-monospace,monospace" font-size="11" fill="currentColor">resolve typed repo targets once</text>
  <line x1="250" y1="217" x2="320" y2="217" stroke="#65a30d" stroke-width="2" marker-end="url(#arrow-green)"/>
  <rect x="330" y="173" width="270" height="88" rx="7" fill="none" stroke="#7a8a99" stroke-width="1.5"/>
  <text x="346" y="197" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">local executor + SSH fan-out</text>
  <text x="346" y="217" font-family="ui-monospace,monospace" font-size="11" fill="#7a8a99">devices run in parallel</text>
  <text x="346" y="237" font-family="ui-monospace,monospace" font-size="11" fill="#7a8a99">repos on one device run in order</text>
  <line x1="600" y1="217" x2="670" y2="217" stroke="#65a30d" stroke-width="2" marker-end="url(#arrow-green)"/>
  <rect x="680" y="173" width="275" height="88" rx="7" fill="none" stroke="#65a30d" stroke-width="2"/>
  <text x="696" y="197" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">default-branch fast-forward</text>
  <text x="696" y="217" font-family="ui-monospace,monospace" font-size="11" fill="#7a8a99">verify slug · fetch · integrate</text>
  <text x="696" y="237" font-family="ui-monospace,monospace" font-size="11" fill="#7a8a99">blocked work stays byte-for-byte intact</text>

  <line x1="818" y1="261" x2="818" y2="300" stroke="#65a30d" stroke-width="2" marker-end="url(#arrow-green)"/>
  <rect x="520" y="310" width="435" height="54" rx="7" fill="none" stroke="#7a8a99" stroke-width="1.5"/>
  <text x="536" y="333" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">one result: updated · current · missing · blocked · unavailable</text>
  <text x="536" y="351" font-family="ui-monospace,monospace" font-size="11" fill="#7a8a99">human table and stable JSON; exit code matches completeness</text>
  <text x="20" y="350" font-family="ui-monospace,monospace" font-size="11" fill="#7a8a99">Green = new mutation path. Gray = existing reusable infrastructure.</text>
</svg>
<figcaption><b>Figure.</b> The new command reuses the existing discovery and SSH seams, adding one guarded mutation executor and one composed result.</figcaption>
</figure>

### What the user sees

<div class="artifact-grid artifact-grid-2">
<div class="artifact-panel" data-state="current" data-evidence="mockup">

**Current — drift is diagnosed, then handed back**

```console
$ agents projects status acme
acme
  fleet    2/5 clean · 2 behind · 1 missing
           laptop: ✓ clean · main
           build-1: ⚠ ↓14 · main
           build-2: ⚠ ↓6 · main
           win: ✗ missing
  🔴 2 hosts behind origin/main
      pull (or rebase) before agents open PRs

$ agents ssh build-1 'git -C ~/src/acme pull ...'
# repeat path inspection and pull for every row
```

The status card knows the targets, but there is no project action that consumes
them.
</div>

<div class="artifact-panel" data-state="proposed" data-evidence="mockup">

**Proposed — one pull, one honest result**

```console
$ agents projects pull acme
acme · pulling 5 reachable checkouts
  laptop    ~/src/acme        current  7eaf21c3 · main
  build-1   ~/src/acme        updated  12c0a841 → 7eaf21c3
  build-2   ~/src/acme        updated  54bd013a → 7eaf21c3
  test-1    ~/src/acme-tools  blocked  feature/load-test (expected main)
  win       ~/src/acme        missing  skipped

2 updated · 1 current · 1 missing · 1 blocked
Incomplete: 1 checkout was left untouched.
$ echo $?
1
```

Every successful row names the commit now installed. Every unsuccessful row
names what was preserved and why.
</div>
</div>

<div class="artifact-callout">
“Pull all copies” must not mean “make every tree look like origin by force.” The
command is complete only when every existing reachable checkout either reaches
the remote default tip or is named as untouched. It never runs reset, checkout,
branch switching, or an implicit rebase.
</div>

## Purpose

The status surface already tells the user that a fleet is stale, but its only
remediation is prose. That leaves the highest-risk part—mutating many git
checkouts—to one-off shell commands. RUSH-2536 closes that gap without creating
a second project registry, SSH transport, or git safety policy.

The implementation extends three existing abstractions:

| Existing source | Extension |
| --- | --- |
| `projects.ts#projectDirList` | extend the canonical normalizer to retain expected repo identity |
| `git.ts#pullRepo` | add a side-effect-free, default-branch fast-forward mode; preserve current default behavior |
| `remote-agents-json.ts` fan-out | run one hidden JSON executor per peer with a longer mutation timeout |

## Proposed Changes

### Repository targets keep path and identity together

`apps/cli/src/lib/projects.ts` remains the one owner of home expansion,
normalization, missing-path policy, remote path conversion, and deduplication.
Its existing `projectDirList` loop is extended to carry repo identity, and the
path-only probe helper derives from that richer result.

```diff
+export interface ProjectRepoTarget {
+  path: string;
+  expectedSlug?: string;
+}
+
+export function projectRepoTargetsForDef(def: ProjectDef): ProjectRepoTarget[] {
+  return projectDirList(def, {
+    primary: def.root,
+    primarySlug: def.repo,
+    forRemote: true,
+    keepMissing: true,
+    joinSubpath: false,
+    includeIdentity: true,
+  });
+}
 export function projectProbeTargets(def: ProjectDef): string[] {
-  return projectDirList(def, probeOptions);
+  return projectRepoTargetsForDef(def).map((target) => target.path);
 }
```

When duplicate definitions normalize to the same path, the resolver preserves
the first non-empty expected slug. A root without `def.repo` can therefore
inherit identity from a matching `repos[]` row. Tests in `projects.test.ts` pin
home expansion, remote path conversion, first-known-slug deduplication, and
path-only compatibility; `project-probe.test.ts` continues to pin the status set.

### Canonical git pull gains a strict, side-effect-free mode

`apps/cli/src/lib/git.ts` extends `pullRepo` rather than reimplementing fetch
and integration in the projects command. Strict mode blocks every dirty tree,
never rebases, and suppresses the existing post-pull Git-hook installation.

```diff
+export interface PullRepoOptions {
+  mode?: 'preserve-local' | 'default-branch-fast-forward';
+}
 export async function pullRepo(
   dir: string,
+  options: PullRepoOptions = {},
 ): Promise<PullRepoResult> {
   const git = simpleGit(dir);
   const status = await git.status();
+  const strict = options.mode === 'default-branch-fast-forward';
+  if (strict && status.files.length > 0) return blockedDirtyTree(...);
+  if (strict) {
+    await git.fetch('origin');
+    await git.raw(['remote', 'set-head', 'origin', '--auto']);
+    const upstream = (await git.raw([
+      'symbolic-ref', '--short', 'refs/remotes/origin/HEAD',
+    ])).trim();
+    const expectedBranch = upstream.replace(/^origin\//, '');
+    if (status.current !== expectedBranch) return blockedBranch(...);
+    tracking = upstream;
+  }
   ...
+  if (options.mode === 'default-branch-fast-forward' && aheadCount > 0) {
+    return blockedLocalCommits(...);
+  }
   if (canFastForward) await git.raw(['merge', '--ff-only', tracking]);
-  else await git.raw(['rebase', tracking]);
+  else if (!strict) await git.raw(['rebase', tracking]);
   ...
-  installGithooksSymlinks(dir);
+  if (!strict) installGithooksSymlinks(dir);
 }
```

The default remains `preserve-local`, so `agents repo pull` and every existing
test keep their current behavior. The strict mode resolves `origin/HEAD`; it
does not hardcode `main`, so a repository whose remote default is `master` works
without a compatibility branch. It rejects detached HEAD, a non-default branch,
local-only commits, divergence, an unreadable default ref, or any dirty or
untracked file. It leaves `.git/hooks` byte-identical even when
`AGENTS_ENABLE_GITHOOKS=1`; only legacy `preserve-local` mode installs hooks.

`apps/cli/src/lib/git.test.ts` adds real bare-remote cases for: current default,
behind fast-forward, non-default branch, ahead default, diverged default,
dirty tracked and untracked files, a remote whose default is `master`, and an
existing Git hook that strict mode must not replace.

### One local executor returns structured outcomes

Add `apps/cli/src/lib/project-pull.ts` and colocated
`project-pull.test.ts`. It is the only project-specific mutation layer.

```diff
+export type ProjectPullStatus =
+  | 'updated' | 'current' | 'missing' | 'blocked' | 'failed';
+
+export interface ProjectPullResult {
+  host: string;
+  path: string;
+  expectedSlug?: string;
+  status: ProjectPullStatus;
+  branch?: string;
+  upstream?: string;
+  before?: string;
+  after?: string;
+  message?: string;
+}
+
+export async function pullProjectTargets(
+  targets: ProjectRepoTarget[],
+  host = machineId(),
+): Promise<ProjectPullResult[]> {
+  // Sequential on one device: do not mutate two working trees concurrently.
+  // 1. absent path -> missing
+  // 2. origin slug mismatch -> blocked before fetch
+  // 3. pullRepo(path, { mode: 'default-branch-fast-forward' })
+  // 4. compare HEAD before/after -> current or updated
+}
```

Remote identity is checked before mutation with
`parseOwnerRepoFromRemote(git remote get-url origin)`. A target without an
expected slug, an unreadable `origin`, or a known mismatch is blocked before
fetch; bulk mutation never guesses repository identity from a path alone.
No result is inferred from process exit alone: `updated` requires the post-pull
HEAD to differ and `current` requires a verified HEAD.

### Public command orchestrates local + fleet execution

`apps/cli/src/commands/projects.ts` registers the public command and one hidden
peer command. It reuses the same `--device` / `--devices` filter merger as
`projects status`.

```diff
 const projects = program.command('projects');
+
+const pullCommand = projects
+  .command('pull <name>')
+  .description('Fetch and fast-forward every existing checkout for one project across the reachable fleet.')
+  .option('--device <name...>', 'Scope remote execution to one or more devices')
+  .option('--devices <names>', 'Scope remote execution to a comma-separated device list')
+  .option('--json', 'Machine-readable composed result')
+  .action(async (name, opts) => {
+    const def = requireProject(name);
+    const targets = projectRepoTargetsForDef(def);
+    if (targets.length === 0) throw new Error(
+      `Project "${name}" has no registered checkout paths.`,
+    );
+    const [local, remote] = await Promise.all([
+      pullProjectTargets(targets),
+      gatherRemoteAgentsJson({
+        args: ['projects', 'pull-local', '--json', '--targets', JSON.stringify(targets)],
+        noFanoutEnv: PROJECTS_NO_FANOUT_ENV,
+        hosts: resolveDeviceFilter(opts.device, opts.devices),
+        timeoutMs: 120_000,
+        parse: (stdout, machine) =>
+          parseProjectPullEnvelope(stdout, machine, targets),
+        quiet: true,
+      }),
+    ]);
+    printProjectPullSummary(name, local, remote, opts.json);
+    if (!projectPullComplete(local, remote)) process.exitCode = 1;
+  });
+
+projects
+  .command('pull-local', { hidden: true })
+  .requiredOption('--targets <json>')
+  .option('--json')
+  .action(async ({ targets }) => {
+    const parsed = parseTargets(targets);
+    console.log(JSON.stringify({
+      schemaVersion: 1,
+      kind: 'project-pull',
+      machine: machineId(),
+      targetFingerprint: fingerprintTargets(parsed),
+      results: await pullProjectTargets(parsed),
+    }));
+  });
+
+setHelpSections(pullCommand, {
+  examples: `
+    agents projects pull agents-cli
+    agents projects pull agents-cli --device build-1
+    agents projects pull agents-cli --json
+  `,
+  notes: `
+    Only clean checkouts already on their verified remote default branch are
+    fast-forwarded. Partial fleet coverage exits 1 after healthy peers finish.
+  `,
+});
```

Devices run concurrently through the existing fan-out; repos on one device run
sequentially. A 120-second per-peer ceiling replaces the read-only probe's
12-second default because fetch is a network mutation. The controller waits for
all attempted peers and prints one summary. It never starts a background shell.

The hidden protocol is fail-closed. Its parser requires schema version 1, kind
`project-pull`, the requested machine and target fingerprint, exactly one valid
result for every requested normalized path, no duplicates, and only known status
values. A bare `[]`, missing/extra row, wrong host, or old-peer response returns
`{ items: [], valid: false }`, preserving `parseFailed` instead of false success.

Human output groups by host/path and uses human statuses. JSON is stable:

```json
{
  "project": "acme",
  "ok": false,
  "summary": { "updated": 2, "current": 1, "missing": 1, "blocked": 1, "failed": 0 },
  "results": [
    { "host": "build-1", "path": "~/src/acme", "status": "updated", "before": "12c0a841", "after": "7eaf21c3", "branch": "main", "upstream": "origin/main" }
  ],
  "unavailableDevices": []
}
```

`ok` is false when any result is `blocked`/`failed`, device discovery fails, a
peer returns invalid JSON, or an attempted peer is unavailable. `missing` is
counted and shown but is neutral. Healthy devices are not rolled back because
another device failed; the final result states partial completion.

`apps/cli/src/commands/projects.test.ts` adds Commander-surface and formatting
coverage: required name, zero paths, both device filter spellings, JSON schema,
non-zero partial result, missing-only success, dedicated workflow help, and
fail-closed envelopes: `[]`, malformed/duplicate/missing rows, wrong host or
fingerprint, and invalid status.

### Documentation and generated surface

```diff
 # apps/cli/docs/projects.md
+## Pull every reachable checkout — `agents projects pull <name>`
+
+The command fetches each existing registered repo on this machine and reachable
+devices, then fast-forwards only a checkout already on its remote default branch.
+It never clones, switches branches, rebases local commits, resets, pushes, or
+discards dirty files. `--device` / `--devices` narrow the peer set; `--json`
+returns the composed result.

 # apps/cli/AGENTS.md (source-layout note)
-projects.ts  # named definitions + progress card
+projects.ts  # named definitions + progress card + guarded fleet pull

 # apps/cli/.changelog/next/RUSH-2536.md
+`agents projects pull <name>` safely fast-forwards every existing checkout for
+a project across the reachable fleet and reports anything left untouched.
```

Regenerate `apps/cli/docs/command-index.md`, `command-index.json`, and
`command-reference.html` with `bun run gen:index`; do not hand-edit them. The
root README has no projects command list, so this delivery does not add a
duplicate command reference. The companion system-repo audit found no current
skill, command, rule, or hook invoking `agents projects`; record that negative
audit in the PR rather than opening an unrelated companion change.

## Public Interface

```console
agents projects pull <name> [--device <name...>] [--devices <a,b,c>] [--json]
```

| Input | Contract |
| --- | --- |
| `<name>` | Required existing project definition with at least one registered checkout path |
| no device flag | Local machine plus every reachable registered compute device |
| `--device` / `--devices` | Local machine plus only the named remote peers, matching `projects status` |
| `--json` | One object with project, ok, summary, results, unavailableDevices |
| exit `0` | Every existing reachable checkout is verified current/updated; missing paths may be present |
| exit `1` | Any checkout blocked/failed, or any attempted/discovered peer could not produce a valid result |

No project YAML schema changes. No daemon, scheduler, Factory, routine, or
automatic pull is added. The operation runs only on explicit CLI invocation.

## Plan

- [ ] Extend the canonical project directory resolver to pair each normalized checkout path with its expected repo slug.
- [ ] Add strict default-branch fast-forward mode to `pullRepo`, suppress hook installation, and cover it with real-repo regression tests.
- [ ] Build the sequential local executor plus a versioned, cardinality-checked result envelope and parser.
- [ ] Register public `projects pull` plus the hidden peer executor and fleet orchestration tests.
- [ ] Update projects docs, component guidance, changelog fragment, and generated command reference.
- [ ] Run focused tests, full remote CLI suite, and pre-ship live fleet demonstration.
- [ ] Merge on green; the agents-cli release train publishes the next package.

## Validation

Focused test gate in `apps/cli`:

```console
bun test src/lib/project-probe.test.ts \
  src/lib/project-pull.test.ts \
  src/lib/git.test.ts \
  src/commands/projects.test.ts
bun run verify:index
```

Full package gate:

```console
bun run test:remote
```

Pre-ship demonstration uses disposable real bare remotes on two reachable test
devices, not the user's live repositories:

1. Register a temporary project with one current clone, one behind clone, one
   missing path, one feature-branch clone, and one default branch with a local
   commit.
2. Run `agents projects pull <temp-name> --devices <peer-a>,<peer-b> --json`.
3. Verify the behind clones' installed HEAD equals the bare remote default tip.
4. Verify the current clone is unchanged, the missing path was not created, and
   both blocked clones retain byte-identical HEAD/status.
5. Capture the human output and JSON result for the PR.

After the release train publishes and the fleet upgrades, repeat the disposable
flow with the installed `agents` binary and quote `agents --version` plus the
per-checkout result. Do not test the mutation against the real agents-cli
working copies.

## Risks

| Risk | Handling |
| --- | --- |
| Wrong project path points at another repo | Compare expected slug with the live `origin` URL before fetch; block mismatch |
| A feature branch is checked out | Block and report expected/current branch; never switch it |
| Default branch has local commits or diverged | Block; never rebase or reset in project-wide mode |
| Dirty or untracked files exist | Block before fetch/integration; do not change code underneath active work |
| Fetch/integration fails | Reuse rollback; return `failed` with the concrete git error |
| Peer times out, lacks the command, or emits invalid JSON | Preserve healthy results, list peer as unavailable, exit 1 |
| Duplicate repo path in the definition | Canonical resolver dedupes and preserves the first known expected slug |
| Missing checkout | Report `missing`; do not clone or create directories |
| Concurrent invocation on the same repo | Git's lock makes one fail loudly; no retry or second mutation path |
| Installed CLI version skew | Old/partial envelopes fail schema, identity, and cardinality checks; no silent green |
| Project has zero registered paths | Exit 1 with a concrete error; never describe an empty target set as verified |

## Tracking

- [RUSH-2536 — agents projects pull: sync a project's fleet checkouts](https://linear.app/issue/RUSH-2536)
- Source screenshot: local session attachment only; not published because the plan restates its text.
