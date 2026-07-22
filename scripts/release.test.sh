#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bash scripts/release.sh 0.1.0 >/tmp/agents-dbg-release-dry-run.out 2>&1
grep -q "DRY RUN" /tmp/agents-dbg-release-dry-run.out
grep -q "agents-dbg-v0.1.0" /tmp/agents-dbg-release-dry-run.out

node <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('apps/factory/app/package.json', 'utf8'));
const repository = pkg.repository;
const url = typeof repository === 'string' ? repository : repository?.url;
if (!url || !url.includes('github.com/phnx-labs/agents-cli')) {
  throw new Error('apps/factory/app/package.json must declare repository metadata so electron-builder works from git worktrees');
}
NODE

if [[ -e apps/cli/.changelog/next/RUSH-1015.md ]]; then
  echo "apps/cli/.changelog/next/RUSH-1015.md must not document agents-dbg release tooling in the CLI changelog queue" >&2
  exit 1
fi

bash -n scripts/release.sh
echo "release.test.sh: OK"
