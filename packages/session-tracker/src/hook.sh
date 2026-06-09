#!/usr/bin/env bash
# Polyglot SessionStart hook.
#
# Registered as a SessionStart hook in each agent's native config file.
# Each agent passes the hook payload differently:
#   - claude/codex/cursor: JSON on stdin with session_id (+conversation_id for cursor)
#   - grok: GROK_SESSION_ID and GROK_WORKSPACE_ROOT env vars
#   - gemini/antigravity: TBD — add branches below as upstream payloads land
#
# Writes ~/.agents/.cache/terminals/sessions/<PPID>.json with the canonical
# SessionState schema from src/types.ts. Atomic via mktemp + mv.
#
# Invocation:
#   hook.sh <agent>            # required; selects which payload format to parse
#
# Silent on success (SessionStart stdout leaks into the model context).

set -euo pipefail

AGENT="${1:-${AGENT_HINT:-}}"
if [ -z "$AGENT" ]; then
  exit 0
fi

# Read stdin if any (don't block forever).
# Use `cat` only when stdin is not a TTY — and rely on hosts (claude, codex,
# cursor) closing stdin promptly. macOS has no `timeout` in PATH by default,
# so we don't use it.
STDIN_JSON=""
if [ ! -t 0 ]; then
  STDIN_JSON="$(cat || true)"
fi

SID=""
CWD=""
METHOD="hook-stdin"

extract_stdin_json() {
  local field_priority="$1"  # space-separated list of JSON keys to try in order
  python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    for k in '''$field_priority'''.split():
        v = d.get(k)
        if isinstance(v, str) and v:
            print(v); sys.exit(0)
        if isinstance(v, list) and v and isinstance(v[0], str):
            print(v[0]); sys.exit(0)
except Exception:
    pass
" 2>/dev/null || true
}

case "$AGENT" in
  claude|codex)
    SID="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'session_id')"
    CWD="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'cwd')"
    ;;
  cursor)
    SID="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'session_id conversation_id')"
    CWD="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'cwd workspace_roots')"
    ;;
  grok)
    SID="${GROK_SESSION_ID:-}"
    CWD="${GROK_WORKSPACE_ROOT:-$PWD}"
    METHOD="hook-env"
    ;;
  gemini|antigravity)
    # Try stdin JSON first (covers most cases); fall through if empty.
    SID="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'session_id conversation_id sessionId')"
    CWD="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'cwd workspace_roots')"
    ;;
  *)
    exit 0
    ;;
esac

if [ -z "$SID" ]; then
  exit 0
fi

[ -z "$CWD" ] && CWD="$PWD"

STATE_DIR="$HOME/.agents/.cache/terminals/sessions"
mkdir -p "$STATE_DIR"

TID="${AGENT_TERMINAL_ID:-}"
LID="${AGENT_LAUNCH_ID:-}"

TMP="$(mktemp "$STATE_DIR/.${PPID}.XXXXXX")"
python3 - "$SID" "$CWD" "$PPID" "$AGENT" "$TID" "$LID" "$METHOD" > "$TMP" <<'PY'
import json, sys, time
sid, cwd, pid, agent, tid, lid, method = sys.argv[1:8]
out = {
    "session_id": sid,
    "agent": agent,
    "cwd": cwd,
    "pid": int(pid),
    "ts": int(time.time() * 1000),
    "method": method,
}
if tid:
    out["terminal_id"] = tid
if lid:
    out["launch_id"] = lid
json.dump(out, sys.stdout)
PY

mv -f "$TMP" "$STATE_DIR/$PPID.json"
exit 0
