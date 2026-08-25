#!/usr/bin/env bash
#
# Bound a shipped tree's git repo root to itself.
#
# `test.sh --device` rsyncs the tree WITHOUT `.git` — for the attestation
# producer's isolated worktree that file is only a `gitdir:` pointer into the
# origin machine's object store, meaningless on the worker. But with no `.git`
# marker, `git rev-parse --show-toplevel` walks UP out of the shipped tree and
# returns the first ancestor repo it finds. On a worker that is `~/.agents`, the
# DotAgents repo — so every git-rooted path in the suite resolves against a
# completely unrelated repository (RUSH-3178).
#
# This is its own script, rather than a line inlined into test.sh's ssh call, so
# the test suite can exercise THE SAME code rather than a copy of it that can
# drift. The rsync ships scripts/, so it is already on the worker.
#
# Usage: scripts/bound-repo-root.sh <dir>
set -euo pipefail

DIR="${1:?usage: bound-repo-root.sh <dir>}"
[[ -d "$DIR" ]] || { printf 'error: not a directory: %s\n' "$DIR" >&2; exit 1; }
cd "$DIR"

# Gate on HEAD RESOLVING, not on `.git` existing. The remote path is fixed and
# reused, so a `.git` left by an earlier run — or by a half-finished one — makes
# an existence check skip and leaves an unborn HEAD forever.
# BOTH conditions, and `-e .git` first. `git rev-parse --verify HEAD` walks up
# through parents exactly like `--show-toplevel` does, so on a fresh worker the
# ANCESTOR's HEAD (~/.agents is a real, continuously-committed repo) satisfies it
# and this script would exit having done nothing — leaving the very bug it exists
# to fix. The `-e .git` test is what pins the question to THIS directory.
if [[ -e .git ]] && git rev-parse -q --verify HEAD >/dev/null 2>&1; then
  exit 0
fi

# `git init` and `git add` are NOT wrapped in `|| true`: a failure there means
# the root is still unbounded, and swallowing it would silently restore the
# original bug with no error at all. Only the commit tolerates failure (an empty
# tree has nothing to commit, which is fine — the repo still bounds the walk).
git init -q
git add -A
# Identity via `-c`, never written to the box's config: a worker generally has
# no git identity, and without one the commit fails and leaves an unborn HEAD.
git -c user.email=agents@localhost -c user.name=agents \
    commit -q -m 'shipped tree' >/dev/null 2>&1 || true
