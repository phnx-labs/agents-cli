#!/bin/bash
#
# Regression tests for activate.sh's liveness verdict.
#
# The bug (RUSH-2724): `newest_logdir` took the newest logs dir unconditionally.
# Every `code`/`codium --install-extension` and `--list-extensions` invocation
# mints its own logs dir with NO window*/ subdirs, and a release run makes
# several of those AFTER installing. The newest dir was therefore a decoy: the
# `window*/exthost/exthost.log` glob matched nothing, every window loop iterated
# zero times, and the script printed "All running windows are live" having
# inspected zero windows — while the user's actual window still ran the old
# bundle.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTIVATE_SH="$SCRIPT_DIR/activate.sh"
FAIL=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=1; }

echo "Running activate.sh regression tests..."

if bash -n "$ACTIVATE_SH" 2>&1; then
    pass "activate.sh passes bash -n syntax check"
else
    fail "activate.sh has a syntax error"
fi

# Extract the real newest_logdir() body and exercise it against a fixture tree.
FUNCS="$(mktemp)"
sed -n '/^mtime_epoch() {/,/^}/p;/^newest_logdir() {/,/^}/p' "$ACTIVATE_SH" > "$FUNCS"
if [ ! -s "$FUNCS" ]; then
    fail "could not extract newest_logdir() from activate.sh"
else
    # shellcheck disable=SC1090
    . "$FUNCS"

    FIXTURE="$(mktemp -d)"
    LOGS="$FIXTURE/Library/Application Support/VSCodium/logs"

    # An older dir holding a REAL window, then a newer window-less dir of the
    # kind a `--install-extension` invocation leaves behind.
    mkdir -p "$LOGS/20260815T030000/window1/exthost"
    : > "$LOGS/20260815T030000/window1/exthost/exthost.log"
    sleep 1
    mkdir -p "$LOGS/20260815T041957"

    PICKED="$(HOME="$FIXTURE" newest_logdir VSCodium)"

    case "$PICKED" in
        *20260815T030000*) pass "newest_logdir skips a window-less CLI logs dir" ;;
        "")                fail "newest_logdir returned nothing despite a windowed dir existing" ;;
        *)                 fail "newest_logdir picked the window-less decoy: $PICKED" ;;
    esac

    # No windowed dir anywhere => empty, so the caller reports unverified rather
    # than globbing zero windows and concluding everything is live.
    EMPTY="$(mktemp -d)"
    mkdir -p "$EMPTY/Library/Application Support/VSCodium/logs/20260815T041957"
    if [ -z "$(HOME="$EMPTY" newest_logdir VSCodium)" ]; then
        pass "newest_logdir returns empty when no logs dir holds a window"
    else
        fail "newest_logdir returned a window-less dir"
    fi

    rm -rf "$FIXTURE" "$EMPTY"
fi
rm -f "$FUNCS"

# RUSH-2781: a scripted reload on the interactive host steals the owner's
# screen. The reload must be gated on is_interactive_host() and overridable
# only via --reload-windows.
if grep -q 'RELOAD_ALLOWED' "$ACTIVATE_SH" && grep -q -- '--reload-windows' "$ACTIVATE_SH"; then
    pass "activate.sh gates reloads behind RELOAD_ALLOWED / --reload-windows"
else
    fail "activate.sh can still reload windows unconditionally"
fi

IHFUNCS="$(mktemp)"
sed -n '/^is_interactive_host() {/,/^}/p' "$ACTIVATE_SH" > "$IHFUNCS"
if [ ! -s "$IHFUNCS" ]; then
    fail "could not extract is_interactive_host() from activate.sh"
else
    # shellcheck disable=SC1090
    . "$IHFUNCS"

    if [ "$(uname -s)" = "Darwin" ]; then
        THIS_HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
    else
        THIS_HOST="$(hostname -s 2>/dev/null || hostname)"
    fi

    STUBS="$(mktemp -d)"
    make_agents_stub() {
        printf '#!/bin/bash\nprintf %%s '\''%s'\''\n' "$1" > "$STUBS/agents"
        chmod +x "$STUBS/agents"
    }

    make_agents_stub "[{\"name\":\"$THIS_HOST\",\"interactive\":true}]"
    if PATH="$STUBS:$PATH" is_interactive_host; then
        pass "is_interactive_host: true when devices JSON marks this host interactive"
    else
        fail "is_interactive_host missed this host in the devices JSON"
    fi

    make_agents_stub '[{"name":"some-other-box","interactive":true},{"name":"x","interactive":false}]'
    if PATH="$STUBS:$PATH" is_interactive_host; then
        fail "is_interactive_host claimed interactive for another box's row"
    else
        pass "is_interactive_host: false when the interactive host is another box"
    fi

    make_agents_stub 'not json at all'
    if PATH="$STUBS:$PATH" is_interactive_host; then
        pass "is_interactive_host: unparseable devices JSON degrades to interactive (safe default)"
    else
        fail "is_interactive_host treated unparseable JSON as non-interactive"
    fi

    rm -rf "$STUBS"
fi
rm -f "$IHFUNCS"

# A window loop that never runs must not be reported as live.
if grep -q 'WINDOWS_SEEN' "$ACTIVATE_SH" \
   && grep -q 'UNVERIFIED' "$ACTIVATE_SH"; then
    pass "activate.sh reports UNVERIFIED when it inspected zero windows"
else
    fail "activate.sh can still claim live after inspecting zero windows"
fi

if [ "$FAIL" -eq 0 ]; then
    echo "All activate.sh regression tests passed."
else
    echo "activate.sh regression tests FAILED."
    exit 1
fi
