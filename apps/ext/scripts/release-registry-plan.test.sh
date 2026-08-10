#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/release-registry-plan.sh"

assert_plan() {
    local expected="$1"
    shift
    local actual
    actual="$(registry_publish_plan "$@")"
    [ "$actual" = "$expected" ] || {
        echo "expected registry plan '$expected', got '$actual'" >&2
        exit 1
    }
}

assert_plan $'vsce\novsx' 0 0
assert_plan 'ovsx' 1 0
assert_plan 'vsce' 0 1
assert_plan '' 1 1

echo "release registry plan tests passed"
