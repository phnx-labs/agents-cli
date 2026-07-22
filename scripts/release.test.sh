#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bash scripts/release.sh 0.1.0 >/tmp/agents-dbg-release-dry-run.out 2>&1
grep -q "DRY RUN" /tmp/agents-dbg-release-dry-run.out
grep -q "agents-dbg-v0.1.0" /tmp/agents-dbg-release-dry-run.out

bash -n scripts/release.sh
echo "release.test.sh: OK"
