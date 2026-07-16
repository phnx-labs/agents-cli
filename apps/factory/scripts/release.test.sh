#!/bin/bash
#
# Regression tests for release.sh's test gate. The release must delegate to the
# package's configured test script so its timeout and future test options are not
# bypassed by a raw `bun test` invocation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_SH="$SCRIPT_DIR/release.sh"
FAIL=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=1; }

echo "Running release.sh regression tests..."

if bash -n "$RELEASE_SH" 2>&1; then
    pass "release.sh passes bash -n syntax check"
else
    fail "release.sh has syntax errors"
fi

PACKAGE_TEST_COMMAND="$(
    cd "$FACTORY_ROOT"
    bun -e 'console.log(require("./package.json").scripts?.test ?? "")'
)"
if [ -n "$PACKAGE_TEST_COMMAND" ]; then
    pass "package.json defines the canonical test command: $PACKAGE_TEST_COMMAND"
else
    fail "package.json does not define scripts.test"
fi

if grep -qE '^[[:space:]]*bun[[:space:]]+run[[:space:]]+test([[:space:]]|$)' "$RELEASE_SH"; then
    pass "release.sh delegates to the package test script"
else
    fail "release.sh bypasses the package test script"
fi

if grep -qE '^[[:space:]]*bun[[:space:]]+test([[:space:]]|$)' "$RELEASE_SH"; then
    fail "release.sh contains a raw bun test invocation"
else
    pass "release.sh contains no raw bun test invocation"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "All tests passed."
else
    echo "Some tests FAILED."
    exit 1
fi
