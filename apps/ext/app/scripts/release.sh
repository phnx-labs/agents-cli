#!/usr/bin/env bash
# Compatibility entrypoint for the agents-dbg release pipeline.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
exec "$ROOT/scripts/release.sh" "$@"
