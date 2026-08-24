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

# --- RUSH-3114: the local publish path must install deps before the gate ---
#
# `bun install` (root + ui) used to live ONLY inside the ssh-routing heredoc, so
# it ran solely when the publish routed to another box. On the local publish path
# (this box holds the bundle, --here, or the --publish-phase re-entry) a clean
# checkout reached the test/build gate with no node_modules and died. This drives
# the real script down the local path with a stubbed `bun` and asserts install is
# invoked, and that it precedes the "Running tests" gate in the output.
if [ -z "${RELEASE_VERSION:-}" ]; then
    fail "RUSH-3114: could not read a released version out of CHANGELOG.md"
else
    STUB_DIR="$(mktemp -d)"
    STUB_HOME="$(mktemp -d)"
    BUN_CALLS="$STUB_DIR/bun-calls"
    RUN_OUT="$STUB_DIR/run-out"

    # `agents secrets list` makes this box the publish host (no routing).
    cat > "$STUB_DIR/agents" <<'STUB'
#!/bin/bash
if [ "${1:-}" = "secrets" ] && [ "${2:-}" = "list" ]; then
    echo "vs-marketplace       2     never - no prompt"
    exit 0
fi
exit 0
STUB

    # `bun` records every invocation so we can assert `install` ran. It must not
    # shadow the collision/PAT pre-flight: it is only present on the script's PATH.
    cat > "$STUB_DIR/bun" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$BUN_CALLS_PATH"
exit 0
STUB

    # `show`/`get` report the version as NOT yet published so a real publish is
    # planned (PUBLISH_VSCE/OVSX=1) — the path a genuine release takes; verify-pat
    # clears offline.
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
    chmod +x "$STUB_DIR/agents" "$STUB_DIR/bun" "$STUB_DIR/vsce" "$STUB_DIR/ovsx"

    # PATs in env so the secrets re-exec is skipped and the script reaches the
    # install block directly. Dry-run (no --confirm) so nothing is published; the
    # install runs regardless of --confirm, which is exactly what we assert.
    (
        cd "$EXT_ROOT"
        PATH="$STUB_DIR:$PATH" HOME="$STUB_HOME" \
            BUN_CALLS_PATH="$BUN_CALLS" VSCE_PAT="tok" OVSX_PAT="tok" \
            bash "$RELEASE_SH" "$RELEASE_VERSION"
    ) > "$RUN_OUT" 2>&1 || true

    if [ ! -f "$BUN_CALLS" ] || ! grep -qE '^install( |$)' "$BUN_CALLS"; then
        fail "RUSH-3114: local publish path never ran 'bun install' (calls: $( [ -f "$BUN_CALLS" ] && tr '\n' ',' < "$BUN_CALLS" || echo none ))"
    else
        pass "local publish path runs 'bun install' before the gate"
    fi

    # Ordering: the install must land before the test gate in the output.
    # `|| true` so a no-match (the pre-fix path, where "Installing dependencies"
    # never prints) reports fail() gracefully instead of aborting the whole suite
    # under `set -e` and silently skipping the assertions below.
    INSTALL_LINE="$(grep -nE 'Installing dependencies' "$RUN_OUT" | head -1 | cut -d: -f1 || true)"
    TESTS_LINE="$(grep -nE 'Running tests' "$RUN_OUT" | head -1 | cut -d: -f1 || true)"
    if [ -n "$INSTALL_LINE" ] && [ -n "$TESTS_LINE" ] && [ "$INSTALL_LINE" -lt "$TESTS_LINE" ]; then
        pass "install precedes the Tests/Build gate on the local publish path"
    else
        fail "RUSH-3114: install did not precede the test gate (install line: ${INSTALL_LINE:-none}, tests line: ${TESTS_LINE:-none})"
    fi
fi

# Static guard against re-introducing the double-install: the ssh-routing
# heredoc must NOT install deps. The --publish-phase re-entry it invokes now
# installs at the shared block, so a `bun install` back inside the heredoc would
# install twice on the remote path. Extract the heredoc payload (between the
# `<<REMOTE_EOF` opener and its closing sentinel) and assert it is install-free.
HEREDOC_BODY="$(awk '/<<REMOTE_EOF/{f=1;next} /^REMOTE_EOF$/{f=0} f' "$RELEASE_SH")"
if printf '%s' "$HEREDOC_BODY" | grep -q 'bun install'; then
    fail "RUSH-3114: routing heredoc still runs 'bun install' (double-install on the remote path)"
else
    pass "routing heredoc no longer installs deps (single install on the remote path)"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "All tests passed."
else
    echo "Some tests FAILED."
    exit 1
fi
