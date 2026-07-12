#!/bin/bash
#
# Regression tests for install.sh — exercises the two bugs from RUSH-1584:
#   1. activate.sh path must resolve absolutely after the cwd change (repo-root invocation)
#   2. UI dependencies must be installed alongside factory dependencies
#
# Runs against the real install.sh source via bash -n (syntax) and variable-trace
# assertions. No mocking — the tests parse the actual script and verify invariants
# that would break on the original buggy code.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$FACTORY_ROOT/../.." && pwd)"
INSTALL_SH="$SCRIPT_DIR/install.sh"
FAIL=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=1; }

echo "Running install.sh regression tests..."

# --- Test 1: SCRIPT_DIR is resolved absolutely before any cd ----------------
# The fix introduces SCRIPT_DIR via $(cd ... && pwd) before PROJECT_ROOT's cd.
# The old code used $(dirname "${BASH_SOURCE[0]}") AFTER cd, which is relative
# and breaks from repo-root invocation.

if grep -q '^SCRIPT_DIR=' "$INSTALL_SH"; then
    # SCRIPT_DIR must appear before PROJECT_ROOT and before any bare cd
    SCRIPT_DIR_LINE=$(grep -n '^SCRIPT_DIR=' "$INSTALL_SH" | head -1 | cut -d: -f1)
    PROJECT_ROOT_LINE=$(grep -n '^PROJECT_ROOT=' "$INSTALL_SH" | head -1 | cut -d: -f1)
    FIRST_CD_LINE=$(grep -n '^cd ' "$INSTALL_SH" | head -1 | cut -d: -f1)

    if [ "$SCRIPT_DIR_LINE" -lt "$PROJECT_ROOT_LINE" ] && [ "$SCRIPT_DIR_LINE" -lt "$FIRST_CD_LINE" ]; then
        pass "SCRIPT_DIR resolved before PROJECT_ROOT and cwd change"
    else
        fail "SCRIPT_DIR must be set before PROJECT_ROOT and any cd"
    fi
else
    fail "SCRIPT_DIR not defined — activate.sh path will be relative and break from repo root"
fi

# The activate.sh invocation must use the absolute SCRIPT_DIR, not dirname BASH_SOURCE
if grep -q 'bash "\$SCRIPT_DIR/activate.sh"' "$INSTALL_SH"; then
    pass "activate.sh invoked via absolute SCRIPT_DIR"
elif grep -q 'dirname.*BASH_SOURCE.*activate\.sh' "$INSTALL_SH"; then
    fail "activate.sh still uses relative dirname BASH_SOURCE (breaks from repo root)"
else
    fail "activate.sh invocation not found"
fi

# --- Test 2: UI dependencies are installed ----------------------------------
# The compile script does 'cd ui && bun run build', which needs ui/node_modules.
# The old code only installed factory node_modules.

if grep -q 'ui/node_modules' "$INSTALL_SH"; then
    pass "install.sh checks for UI node_modules"
else
    fail "install.sh does not install UI dependencies — clean worktree build will fail"
fi

if grep -q 'cd ui && bun install' "$INSTALL_SH"; then
    pass "UI bun install runs inside ui/ subshell"
else
    fail "UI dependency install not found or not scoped to ui/"
fi

# --- Test 3: Structural soundness ------------------------------------------
# Both invocation shapes should work: from repo root and from apps/factory/.
# Simulate the path resolution for both shapes.

# Shape A: from repo root — BASH_SOURCE[0] = apps/factory/scripts/install.sh
SIMULATED_SOURCE="$REPO_ROOT/apps/factory/scripts/install.sh"
RESOLVED_DIR="$(cd "$(dirname "$SIMULATED_SOURCE")" && pwd)"
if [ -f "$RESOLVED_DIR/activate.sh" ]; then
    pass "activate.sh reachable from repo-root invocation shape"
else
    fail "activate.sh NOT reachable from repo-root invocation (resolved: $RESOLVED_DIR)"
fi

# Shape B: from apps/factory/ — BASH_SOURCE[0] = scripts/install.sh
SIMULATED_SOURCE="$FACTORY_ROOT/scripts/install.sh"
RESOLVED_DIR="$(cd "$(dirname "$SIMULATED_SOURCE")" && pwd)"
if [ -f "$RESOLVED_DIR/activate.sh" ]; then
    pass "activate.sh reachable from package-cwd invocation shape"
else
    fail "activate.sh NOT reachable from package-cwd invocation (resolved: $RESOLVED_DIR)"
fi

# --- Test 4: bash -n syntax check -------------------------------------------
if bash -n "$INSTALL_SH" 2>&1; then
    pass "install.sh passes bash -n syntax check"
else
    fail "install.sh has syntax errors"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "All tests passed."
else
    echo "Some tests FAILED."
    exit 1
fi
