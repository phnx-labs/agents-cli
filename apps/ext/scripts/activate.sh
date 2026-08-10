#!/bin/bash
#
# Activate a freshly-installed extension in already-running editors, then prove it.
#
#   activate.sh <publisher.name>
#
# Installing writes the new version to disk, but a running editor loaded its
# extension host once at window-open and keeps the OLD code until the window
# reloads. Each open window has its own host. A window is running the new code
# iff its host started AFTER the new version landed on disk. This script:
#   1. for each running target editor (code, codium, cursor), finds when the
#      new version landed (the installed extension dir's mtime),
#   2. flags windows whose host activated before that (stale),
#   3. best-effort reloads the stale ones ("Developer: Reload Window" via
#      System Events — needs Accessibility permission for the terminal),
#   4. re-verifies from exthost.log and reports LIVE vs STALE per window.
#
# Reload is best-effort; the on-disk-mtime vs activation-time comparison is the
# source of truth. A failed reload is reported, never silently assumed.

set -uo pipefail

EXT_FQN="${1:-}"
if [ -z "$EXT_FQN" ]; then
    echo "Usage: $0 <publisher.name>" >&2
    exit 1
fi

# CLI name -> "AppName|ProcessName|LogSubdir|ExtensionsDir"
editor_meta() {
    case "$1" in
        code)   echo "Visual Studio Code|Code|Code|$HOME/.vscode/extensions" ;;
        codium) echo "VSCodium|VSCodium|VSCodium|$HOME/.vscode-oss/extensions" ;;
        cursor) echo "Cursor|Cursor|Cursor|$HOME/.cursor/extensions" ;;
        *)      echo "" ;;
    esac
}

epoch_now() { date +%s; }

# mtime (epoch) of the newest installed <fqn>-* dir, i.e. when the new code landed.
install_epoch() {
    local extdir="$1" newest=0 d e
    for d in "$extdir/$EXT_FQN-"*; do
        [ -d "$d" ] || continue
        e="$(stat -f %m "$d" 2>/dev/null || echo 0)"
        [ "$e" -gt "$newest" ] && newest="$e"
    done
    echo "$newest"
}

# epoch of the newest _doActivateExtension line for EXT_FQN in a log file (0 if none).
activation_epoch() {
    local log="$1" ts
    [ -f "$log" ] || { echo 0; return; }
    ts="$(grep "_doActivateExtension ${EXT_FQN}" "$log" 2>/dev/null | tail -1 \
        | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}')"
    [ -z "$ts" ] && { echo 0; return; }
    date -j -f "%Y-%m-%d %H:%M:%S" "$ts" +%s 2>/dev/null || echo 0
}

newest_logdir() {
    ls -dt "$HOME/Library/Application Support/$1/logs"/*/ 2>/dev/null | head -1
}

# Reload every window of a running editor (best-effort). Returns 1 if no AX
# windows could be enumerated (e.g. Accessibility not granted to the terminal).
# Windows are addressed by index, not by name: `get name of windows` returns a
# comma-joined list, and editor titles routinely contain commas (filenames,
# branches), which split a single title into bogus entries and target the wrong
# (or a non-existent) window. Indexing also disambiguates duplicate titles.
reload_editor_windows() {
    local app="$1" proc="$2" count i
    count="$(osascript -e "tell application \"System Events\" to tell process \"$proc\" to count windows" 2>/dev/null)"
    # Empty/non-numeric => couldn't enumerate (Accessibility not granted).
    [[ "$count" =~ ^[0-9]+$ ]] || return 1
    [ "$count" -eq 0 ] && return 1
    for (( i=1; i<=count; i++ )); do
        osascript >/dev/null 2>&1 <<EOF
tell application "$app" to activate
delay 0.5
tell application "System Events" to tell process "$proc"
  perform action "AXRaise" of window $i
  delay 0.8
  keystroke "p" using {command down, shift down}
  delay 0.8
  keystroke "Developer: Reload Window"
  delay 0.8
  key code 36
end tell
EOF
    done
    return 0
}

# Count windows whose host is stale (activated before INSTALL_EPOCH).
stale_count() {
    local logdir="$1" install_ep="$2" eh ep n=0
    for eh in "$logdir"window*/exthost/exthost.log; do
        [ -f "$eh" ] || continue
        ep="$(activation_epoch "$eh")"
        [ "$ep" -lt "$install_ep" ] && n=$((n + 1))
    done
    echo "$n"
}

echo
echo "Activating $EXT_FQN in running editors..."
OVERALL_STALE=0

for CLI in code codium cursor; do
    command -v "$CLI" >/dev/null 2>&1 || continue
    META="$(editor_meta "$CLI")"; [ -z "$META" ] && continue
    APP="${META%%|*}"; R="${META#*|}"; PROC="${R%%|*}"; R="${R#*|}"; LOGSUB="${R%%|*}"; EXTDIR="${R##*|}"

    pgrep -f "$APP.app/Contents/MacOS/" >/dev/null 2>&1 || continue

    INSTALL_EP="$(install_epoch "$EXTDIR")"
    if [ "$INSTALL_EP" -eq 0 ]; then
        echo "  $CLI: running, but $EXT_FQN is not installed for it — skipping."
        continue
    fi
    LOGDIR="$(newest_logdir "$LOGSUB")"
    if [ -z "$LOGDIR" ]; then
        echo "  $CLI: running, no logs dir yet — open a window and re-run."
        OVERALL_STALE=1; continue
    fi

    if [ "$(stale_count "$LOGDIR" "$INSTALL_EP")" -eq 0 ]; then
        echo "  $CLI: already live (all windows activated after install)."
    else
        echo "  $CLI: stale window(s) -> reloading"
        if reload_editor_windows "$APP" "$PROC"; then
            # Poll up to ~24s for reloaded hosts to write their new activation line.
            for _ in $(seq 1 8); do
                sleep 3
                [ "$(stale_count "$LOGDIR" "$INSTALL_EP")" -eq 0 ] && break
            done
        else
            echo "    (could not script a reload — grant Accessibility to your terminal, or use Cmd+Shift+P -> Developer: Reload Window)"
        fi
    fi

    # Final per-window verdict against the install mtime.
    for EH in "$LOGDIR"window*/exthost/exthost.log; do
        [ -f "$EH" ] || continue
        WIN="$(echo "$EH" | grep -oE 'window[0-9]+')"
        EP="$(activation_epoch "$EH")"
        if [ "$EP" -ge "$INSTALL_EP" ]; then
            echo "    $CLI/$WIN: LIVE"
        else
            echo "    $CLI/$WIN: STALE — reload it (Cmd+Shift+P -> Developer: Reload Window)"
            OVERALL_STALE=1
        fi
    done
done

echo
if [ "$OVERALL_STALE" -eq 0 ]; then
    echo "All running windows are live on $EXT_FQN."
else
    echo "Some windows are still stale — reload them to pick up $EXT_FQN."
fi
