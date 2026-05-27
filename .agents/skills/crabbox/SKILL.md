---
description: Run tests and heavy commands on remote Hetzner VMs instead of locally
---

# Crabbox - Remote Test Execution

Run tests and heavy commands on remote Hetzner VMs instead of locally. Use this when:
- Running `bun test`, `npm test`, or any test suite
- Building large projects
- Any CPU-intensive operation that would freeze the local machine

## Setup

Credentials are stored in the `hetzner.com` secrets bundle. Use `agents secrets exec` to inject:
```bash
agents secrets exec hetzner.com -- crabbox list
agents secrets exec hetzner.com -- crabbox warmup --class beast
agents secrets exec hetzner.com -- crabbox run --id <slug> -- bun test
```

## Quick Commands

```bash
# Check for existing box
agents secrets exec hetzner.com -- crabbox list

# Warm up a new box (~60s)
agents secrets exec hetzner.com -- crabbox warmup --class beast

# Run command on box
agents secrets exec hetzner.com -- crabbox run --id <slug> -- <command>

# Stop a box
agents secrets exec hetzner.com -- crabbox stop <slug>
```

## Workflow

1. **Check if a box exists**: `crabbox list`
2. **If no box**: `crabbox warmup --class beast` (takes ~60s)
3. **Run tests**: `crabbox run --id <slug> -- bun test`
4. **Box auto-destroys** after 30 minutes of idleness

## Monorepo per-project pattern (`agents` repo)

In the `agents` monorepo, each major project ships its own self-contained `scripts/sandbox.sh`. Each script is the canonical way to run that project's tests on a crabbox — they replace local `bun test` / `go test ./...` for anything that would freeze the laptop.

### The four scripts

| Script | What it runs |
|---|---|
| `./rush/cli/scripts/sandbox.sh` | `go test ./...` in rush/cli + `go test ./memory/...` in harness (matches `release.sh:130-137` Gate 2). Includes a prep step that regenerates harness-ui schemas + `dist/.placeholder` for `//go:embed`. |
| `./prix/api/scripts/sandbox.sh` | Hermetic `bun test` with `env -u SUPABASE_*` stripping (matches `deploy.sh:272-276`). |
| `./rush/app/scripts/sandbox.sh` | `bun test` (unit only — Electron build + Playwright stay local; better-sqlite3 needs macOS-Electron headers). |
| `./prix/factory/scripts/sandbox.sh` | `docker build` for each `Dockerfile{,.codex,.opencode}` (validates images before Kaniko push). |

### Three modes per script

```bash
./<project>/scripts/sandbox.sh         # verify only (~10s warm): bootstrap + tool version probe
./<project>/scripts/sandbox.sh test    # canonical test suite
./<project>/scripts/sandbox.sh "<cmd>" # arbitrary command (cwd = repo root on the box)
```

No-arg = "is the sandbox alive?" Cheap, idempotent, runs the full bootstrap (apt + bun + go + docker as needed) so the first real test run after a verify is fast.

### Env knobs

| Var | Effect |
|---|---|
| `CRABBOX_PROFILE` | Override profile (default `agents` from root `.crabbox.yaml`). Useful for reusing an existing `default`-profile box. |
| `CRABBOX_CLASS` | Override machine class (default `cpx62`). |
| `CRABBOX_FRESH=1` | Force `--full-resync`. Use when a stale per-repo manifest triggers "tracked deletions: N files" sanity abort. Only resets the current repo's workdir on the box (`/work/crabbox/<lease>/<repo-basename>`); other projects on the same box are untouched. |

### Why self-contained, not a shared lib

Each script is ~100-140 lines and inlines its own bootstrap. There's deliberate duplication of the box-picker, secret-loader, and rsync logic across the four scripts. A `sandbox-lib.sh` was tried and removed — the duplication is cheap, the per-project scripts stay readable, and each can be copied as a starting point for a new project (rather than introducing a cross-cutting dependency).

### Crabbox workspace isolation (per-repo)

Crabbox isolates by **local repo basename**: `cd /path/to/agents && crabbox run` ends up at `/work/crabbox/<lease>/agents` on the box, while `cd /path/to/agents-cli && crabbox run` is at `/work/crabbox/<lease>/agents-cli`. They never conflict — same box, different workdirs. Each workdir has its own manifest, so `--full-resync` from one repo doesn't touch the other.

Within a single repo, the per-project sandbox.sh further isolates by syncing the workdir into `~/workspaces/agents-<project>/` before running the command, so two project sandboxes on the same workdir don't clobber each other's state.

### Gotchas hit while building this

1. **gitignored embed targets**: `rush/cli/internal/assets/dist/.placeholder` and `rush/cli/internal/cli/schemas/ui-schemas.json` are gitignored, so crabbox's gitSeed-style sync skips them. `rush/cli`'s sandbox.sh regenerates them on the box (mirrors what `build.sh` does locally). Other projects don't need this.

2. **Cross-project `replace` directives**: `rush/cli/go.mod` has `replace github.com/muqsitnawaz/agents/harness => ../../harness`. Sandboxes therefore sync from the **repo root**, not the project subdir, even though `crabbox_run` is invoked from inside a sub-project's script.

3. **`testdata/` in `.crabbox.yaml` excludes**: was breaking Go test fixtures. Removed.

4. **Hardcoded paths in `run_test.go`**: 3 tests had `/Users/muqsit/...` baseDir paths that fail on any non-laptop machine (including the box and any CI). Fixed to `t.Skipf` when the path doesn't exist, matching the sibling `TestResolveFSPath_Directory` pattern.

## Two modes: test vs PR

`sandbox.sh` supports two modes. Pick based on what the agent needs to do.

### Test mode (default)

Crabbox rsyncs your local working tree (uncommitted changes included). Use when running tests against in-flight code:

```bash
./scripts/sandbox.sh 'bun test'
```

- Syncs dirty tree to the box. Excludes `node_modules`, `.cache`, `dist`, `.turbo` (see `.crabbox.yaml`)
- Box workspace lives at `~/workspaces/<repo>-<TASK_ID>`
- A blank `git init` is done so tests that touch git don't fail
- No `.git` history — cannot push or open a PR from here

### PR mode (`--pr`)

The box clones the repo fresh from GitHub via a cached bare mirror, checks out a real branch off `main`, and the agent can `git push` + `gh pr create` autonomously:

```bash
./scripts/sandbox.sh --pr 'claude --print "fix the foo bug" \
  && git add -A && git commit -m "fix: foo" \
  && git push -u origin "task-$TASK_ID" \
  && gh pr create --fill --base main'
```

How it stays fast (factory's pattern adapted for a single VM):
- `~/.cache/git-cache/<sha>.git` — bare mirror, clone once per VM lifetime
- Each task: `git clone --reference <mirror>` hardlinks objects (no re-download)
- Cold: 8s end-to-end (mirror clone + workspace clone + checkout)
- Warm: 3-5s (fetch deltas + reference clone)

Commits/PRs are authored by `prix-cloud[bot]`.

## Parallel task isolation

Multiple agents can use the same crabbox VM by passing different `TASK_ID`:

```bash
TASK_ID=agent-1 ./scripts/sandbox.sh --pr 'claude -p "..."' &
TASK_ID=agent-2 ./scripts/sandbox.sh --pr 'claude -p "..."' &
```

Each task gets its own workspace at `~/workspaces/<repo>-<TASK_ID>`. The mirror cache is shared (read-mostly), per-task workspaces are isolated.

## Reference implementation

A working `sandbox.sh` with both test and PR modes lives at:

```
~/src/github.com/muqsitnawaz/agents-cli/scripts/sandbox.sh
```

Copy it as a starting point for any repo you want to crabbox-enable. It composes:

1. **`generate_github_token()`** — mints a Prix Cloud installation token. Resolves install ID dynamically via `/repos/{owner}/{repo}/installation`. Set `TOKEN_REPO=owner/repo` to target a non-origin repo.

2. **Bootstrap (runs on the box, idempotent)** — `bun`, `build-essential`, `gh` CLI, git URL rewrites with the installation token (cleans up stale rewrites first — they accumulate by token, not by host), `agents-cli` setup + `agents add claude` (puts shims on `~/.agents/.cache/shims`, exports to PATH).

3. **Test mode (default)** — rsync local tree to `~/workspaces/<repo>-<TASK_ID>`, blank `git init`, run command.

4. **PR mode (`--pr` flag)** — bare-mirror cache + per-task `--reference` clone:

```bash
CACHE_DIR="$HOME/.cache/git-cache"
CACHE_KEY=$(echo -n "$UPSTREAM" | sha256sum | cut -c1-12)
MIRROR="$CACHE_DIR/$CACHE_KEY.git"
CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_SLUG}.git"

# Mirror layer: clone-once, fetch-deltas-after
if [[ ! -d "$MIRROR" ]]; then
  git clone --mirror "$CLONE_URL" "$MIRROR"
else
  git -C "$MIRROR" remote set-url origin "$CLONE_URL"   # rotate token
  git -C "$MIRROR" fetch --prune origin
fi

# Per-task workspace: hardlinks objects from mirror, no re-download
git clone --reference "$MIRROR" "$CLONE_URL" "$WORKSPACE_DIR"
cd "$WORKSPACE_DIR"
git remote set-url origin "$CLONE_URL"
git checkout -B "task-$TASK_ID" "origin/$DEFAULT_BRANCH"
```

Do not pass `--filter=blob:none` to the mirror clone — it leaves blobs missing and the working-tree checkout will fail with "unable to read sha1 file".

5. **Crabbox invocation** — `crabbox run --id "$box_id" --reclaim -- bash -c "<bootstrap + command>"`. `--reclaim` lets the lease move between local repo directories without spinning a fresh VM.

Customize the bootstrap per repo: swap `bun` for `go`, add `uv` for Python, etc. Don't recreate the script from scratch — copy `agents-cli/scripts/sandbox.sh` and edit the bootstrap function.

## Config: .crabbox.yaml

Run `crabbox init` to generate a config file. Key settings:

```yaml
class: beast                    # VM size (beast = 16 vCPU, 32GB)
sync:
  exclude:                      # Directories to skip syncing
    - node_modules
    - .cache
    - dist
  gitSeed: true                 # Use git to find changed files (faster)
  fingerprint: true             # Only sync changed files
```

## Cost & Lifecycle

- **Cost:** ~$0.14/hour for CPX62 (16 vCPU, 32GB RAM)
- **Idle timeout:** 30 minutes - box auto-destroys when idle
- **Bootstrap overhead:** ~60s for new box, deps cached after first run

## Authentication on Sandbox

### GitHub Private Repos

Crabbox auths to GitHub as the **Prix Cloud** App (App ID `3410113`). Same App that powers Rush Cloud / Factory Floor — one App, one private key, one set of webhooks. Bot identity on commits/PRs is `prix-cloud[bot]`.

`github.com` secrets bundle:

| Key | Description |
|-----|-------------|
| `APP_ID` | `3410113` (Prix Cloud) |
| `APP_PRIVATE_KEY` | file ref to `~/.agents/keys/prix-cloud.pem` |

Install ID is resolved **dynamically per-repo** via `GET /repos/{owner}/{repo}/installation` — no hardcoded install ID. Works for any repo where the user has installed the Prix Cloud App.

Permissions the App carries (installation-scoped, see `prix/factory/docs/01-github-app-integration.md`):

- `contents: write` — push branches
- `pull_requests: write` — `gh pr create`
- `issues: write` — comment on linked issues
- `statuses: write` — set commit statuses

`sandbox.sh` handles token minting automatically:
1. Loads `APP_ID` + `APP_PRIVATE_KEY` from secrets
2. Mints app-level JWT (10min TTL)
3. Resolves install ID from upstream repo
4. Exchanges JWT for installation token (1hr TTL)
5. Exports `GITHUB_TOKEN` + `GH_TOKEN` to the box
6. Writes `url.https://x-access-token:$TOKEN@github.com/.insteadOf` rewrites so `git clone https://github.com/...` and `gh ...` both work transparently

To target a different repo's installation than the local origin, set `TOKEN_REPO=owner/repo`.

### Coding Agents on Sandbox

Install agents via `agents-cli`, not directly via npm:
```bash
# Install agents-cli first
npm install -g @phnx-labs/agents-cli

# Then install coding agents
agents add claude
agents add codex
agents add gemini
```

For Claude Code, store your long-lived OAuth token in `anthropic.com` bundle:
```bash
# One-time setup on local machine (interactive)
claude setup-token
agents secrets add anthropic.com CLAUDE_CODE_OAUTH_TOKEN --value "<token>"

# On sandbox, export before running claude
export CLAUDE_CODE_OAUTH_TOKEN="..."
claude -p "fix the tests"
```

The `sandbox.sh` script handles injecting tokens and installing agents automatically.

## When to Use

ALWAYS use crabbox for:
- `bun test` / `npm test` / `vitest` / `jest`
- `bun run build` on large projects
- Any command that takes > 30 seconds locally

NEVER run tests locally - they freeze the machine.
