#!/bin/bash
#
# Regression tests for release.sh's test gate. The release must delegate to the
# package's configured test script so its timeout and future test options are not
# bypassed by a raw `bun test` invocation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
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
    cd "$EXT_ROOT"
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

# --- RUSH-2987: the secrets re-entry must carry the original arguments -----
#
# release.sh parses argv with a `while [ $# -gt 0 ]` loop that shifts every
# argument away, then re-execs itself under `agents secrets exec` to pick up the
# marketplace PATs. Replaying "$@" there replays an EMPTY argv: the re-entered
# script finds no version, falls through to `usage 1`, and the release dies at
# the token step with a usage dump. This drives the real script with stubbed
# `agents`/`vsce`/`ovsx` and asserts the version reaches the re-exec.
RELEASE_VERSION="$(grep -m1 -oE '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' "$EXT_ROOT/CHANGELOG.md" | tr -d '#[] ')"
if [ -z "$RELEASE_VERSION" ]; then
    fail "could not read a released version out of CHANGELOG.md"
else
    STUB_DIR="$(mktemp -d)"
    STUB_HOME="$(mktemp -d)"
    REEXEC_ARGV="$STUB_DIR/reexec-argv"

    # `agents secrets list` makes this box look like the publish host (no ssh
    # routing); `agents secrets exec ... -- true` is the resolvability probe;
    # any other exec is the re-entry, whose argv we record instead of running.
    cat > "$STUB_DIR/agents" <<'STUB'
#!/bin/bash
if [ "${1:-}" = "secrets" ] && [ "${2:-}" = "list" ]; then
    echo "vs-marketplace       2     never - no prompt"
    exit 0
fi
if [ "${1:-}" = "secrets" ] && [ "${2:-}" = "exec" ]; then
    shift 3                       # drop: secrets exec <bundle>
    [ "${1:-}" = "--" ] && shift
    if [ "${1:-}" = "true" ]; then exit 0; fi
    printf '%s\n' "$@" > "$REEXEC_ARGV_PATH"
    exit 0
fi
exit 0
STUB

    # Enough of vsce/ovsx to clear the collision + PAT pre-flights offline.
    cat > "$STUB_DIR/vsce" <<'STUB'
#!/bin/bash
case "${1:-}" in
    show)        echo '{"versions":[]}' ;;
    verify-pat)  exit 0 ;;
esac
exit 0
STUB
    cat > "$STUB_DIR/ovsx" <<'STUB'
#!/bin/bash
echo '{}'
exit 0
STUB
    chmod +x "$STUB_DIR/agents" "$STUB_DIR/vsce" "$STUB_DIR/ovsx"

    # HOME is redirected because release.sh prepends "$HOME/.bun/bin" to PATH
    # before the marketplace check — a real vsce there would shadow the stub.
    (
        cd "$EXT_ROOT"
        PATH="$STUB_DIR:$PATH" HOME="$STUB_HOME" \
            REEXEC_ARGV_PATH="$REEXEC_ARGV" VSCE_PAT="" OVSX_PAT="" \
            bash "$RELEASE_SH" "$RELEASE_VERSION"
    ) >/dev/null 2>&1 || true

    if [ ! -f "$REEXEC_ARGV" ]; then
        fail "release.sh never reached the secrets re-entry (stub recorded nothing)"
    elif grep -qx -- "$RELEASE_VERSION" "$REEXEC_ARGV"; then
        pass "secrets re-entry replays the version ($RELEASE_VERSION) instead of an empty argv"
    else
        fail "secrets re-entry lost the version; re-exec argv was: $(tr '\n' ' ' < "$REEXEC_ARGV")"
    fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "All tests passed."
else
    echo "Some tests FAILED."
    exit 1
fi
