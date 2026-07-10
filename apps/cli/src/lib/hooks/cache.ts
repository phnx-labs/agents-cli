/**
 * Declarative hook caching + timing.
 *
 * Hooks that opt in via `cache:` in hooks.yaml get a generated bash shim
 * (~/.agents/.cache/shims/hooks/<name>.sh) registered with the agent instead
 * of the raw script path. The shim handles:
 *
 *   1. cache lookup — reads ~/.agents/.cache/state/hooks/<name>.<key>.out
 *      and serves it if newer than ttl.
 *   2. stale-while-revalidate — when prefetch=background, serves stale cache
 *      and refreshes the cache file in a detached child.
 *   3. timing — appends one JSONL line per fire to events-YYYY-MM-DD.jsonl.
 *
 * The shim is regenerated whenever the registrar runs; if its content doesn't
 * change (idempotent), mtime is preserved. Stale shims for removed hooks are
 * cleaned by the registrar's garbage collection (shims dir is in
 * managedPrefixes).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { HookCache, HookCacheConfig, HookCacheKey, HookCachePrefetch, HookMatches } from '../types.js';
import { getHookCacheDir, getHookShimsDir, getLogsDir } from '../state.js';

/**
 * Parse a `cache:` value from hooks.yaml into the canonical config form.
 * Accepts the shorthand string ("5m", "30s-bg") or the full object form.
 * Returns null if the value is missing or unparseable.
 */
export function parseCacheConfig(raw: HookCache | undefined): HookCacheConfig | null {
  if (raw == null) return null;
  if (typeof raw === 'string') return parseShorthand(raw);
  const ttlSec = parseDuration(raw.ttl);
  if (ttlSec == null) return null;
  return {
    ttl: ttlSec,
    key: raw.key ?? 'global',
    prefetch: raw.prefetch ?? 'none',
  };
}

function parseShorthand(s: string): HookCacheConfig | null {
  const trimmed = s.trim();
  let prefetch: HookCachePrefetch = 'none';
  let durationPart = trimmed;
  if (trimmed.endsWith('-bg')) {
    prefetch = 'background';
    durationPart = trimmed.slice(0, -3);
  }
  const ttlSec = parseDuration(durationPart);
  if (ttlSec == null) return null;
  return { ttl: ttlSec, key: 'global', prefetch };
}

/** Parse "30s" | "5m" | "1h" | "7d" | plain seconds. Returns seconds, or null on failure. */
export function parseDuration(d: number | string | undefined): number | null {
  if (d == null) return null;
  if (typeof d === 'number') return Number.isFinite(d) && d > 0 ? Math.floor(d) : null;
  const m = d.trim().match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)?$/i);
  if (!m) return null;
  const value = parseInt(m[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (m[2] || 's').toLowerCase();
  if (unit.startsWith('d')) return value * 86400;
  if (unit.startsWith('h')) return value * 3600;
  if (unit.startsWith('m')) return value * 60;
  return value;
}

/**
 * Reject hook names that could escape the shims directory when interpolated
 * into a filename. Mirrors the containment gate on hook script resolution in
 * hooks.ts (`resolveContainedHookPath`).
 */
export function isValidHookShimName(name: string): boolean {
  return (
    !!name &&
    name !== '.' &&
    name !== '..' &&
    !name.startsWith('-') &&
    !/[\/\\\x00]/.test(name) &&
    name.length <= 255
  );
}

/** Resolve shimsDir + `${name}.sh` and assert the result stays inside shimsDir. */
function resolveContainedHookShimPath(shimsDir: string, name: string): string {
  if (!isValidHookShimName(name)) {
    throw new Error(`Invalid hook shim name: ${name}`);
  }
  const resolvedRoot = path.resolve(shimsDir);
  const candidate = path.join(shimsDir, `${name}.sh`);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Invalid hook shim name: ${name}`);
  }
  return resolved;
}

/** Absolute path of the generated shim for a hook name. */
export function getHookShimPath(name: string): string {
  return resolveContainedHookShimPath(getHookShimsDir(), name);
}

/**
 * Optional path overrides for tests that need to redirect cache + logs to a
 * temp dir. Production callers omit `paths`; the shim uses real state.ts dirs.
 * (state.ts captures HOME at module load, so mutating process.env.HOME in a
 * test's beforeEach doesn't reach getHookCacheDir() — this is the explicit
 * seam.)
 */
export interface HookShimPaths {
  shimsDir?: string;
  cacheDir?: string;
  logsDir?: string;
}

/**
 * Generate (or refresh) the shim script for a hook. Idempotent — only writes
 * when the content differs from what's on disk. Returns the absolute shim path.
 *
 * A shim is generated when the hook opts into caching (`cache`) and/or declares
 * `matches:` predicates. When `matches` is present the shim gates execution on
 * those predicates before running the underlying script (see `renderShim`);
 * when `cache` is absent the shim is a thin pass-through wrapper that only
 * applies the gate and forwards stdin/stdout unchanged.
 */
export function generateHookShim(args: {
  name: string;
  scriptPath: string;
  cache?: HookCacheConfig | null;
  matches?: HookMatches;
  paths?: HookShimPaths;
}): string {
  const shimsDir = args.paths?.shimsDir ?? getHookShimsDir();
  const cacheDir = args.paths?.cacheDir ?? getHookCacheDir();
  const logsDir = args.paths?.logsDir ?? getLogsDir();
  const shimPath = resolveContainedHookShimPath(shimsDir, args.name);
  const content = renderShim(args.name, args.scriptPath, args.cache ?? null, args.matches, { cacheDir, logsDir });
  fs.mkdirSync(shimsDir, { recursive: true });

  let existing: string | null = null;
  if (fs.existsSync(shimPath)) {
    try { existing = fs.readFileSync(shimPath, 'utf-8'); } catch { /* rewrite */ }
  }
  if (existing !== content) {
    fs.writeFileSync(shimPath, content, { mode: 0o755 });
  } else {
    // Ensure exec bit even when content unchanged (file mode can drift).
    try { fs.chmodSync(shimPath, 0o755); } catch { /* best effort */ }
  }
  return shimPath;
}

/**
 * The matches: gate, as a self-contained Python program run once per fire.
 *
 * Reads the hook's `matches:` block from $MATCHES_JSON and the event JSON from
 * stdin, then prints `FIRE` or `SKIP`. A faithful port of `shouldFire()` in
 * src/lib/hooks/match.ts — all declared predicates AND together, an empty block
 * always fires, and the same ReDoS guard (`isSafeHookRegex`) rejects unsafe
 * regexes to `SKIP`. Kept in double-quotes/apostrophe-free so it survives being
 * embedded in a single-quoted `python -c '...'` argument in the shim. Behavioural
 * parity with shouldFire() is pinned by a conformance test (match-parity.test.ts).
 *
 * On any exception it does NOT print SKIP — the shim treats a missing/garbled
 * verdict as FIRE (fail-open), so a broken gate never silently disables a hook.
 */
const GATE_PY = `import json, os, re, subprocess, sys

def arr(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]

def max_group_depth(src):
    depth = 0
    mx = 0
    escaped = False
    in_class = False
    for ch in src:
        if escaped:
            escaped = False
            continue
        if ch == chr(92):
            escaped = True
            continue
        if ch == "[":
            in_class = True
            continue
        if ch == "]":
            in_class = False
            continue
        if in_class:
            continue
        if ch == "(":
            depth += 1
            if depth > mx:
                mx = depth
        elif ch == ")" and depth > 0:
            depth -= 1
    return mx

_NESTED = re.compile(r"\\((?:\\?:)?[^)]*[*+][?+*{,\\d}]*[^)]*\\)\\s*(?:[+*]|\\{\\d*,?\\d*\\})")

def is_safe(src):
    if len(src) > 200:
        return False
    if max_group_depth(src) > 3:
        return False
    if _NESTED.search(src):
        return False
    return True

def compile_rx(src):
    if not is_safe(src):
        return None
    try:
        return re.compile(src)
    except re.error:
        return None

def find_root(start):
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent

def git_dirty(cwd):
    try:
        out = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        return len(out.stdout.decode().strip()) > 0
    except Exception:
        return False

def should_fire():
    m = json.loads(os.environ.get("MATCHES_JSON") or "{}")
    if not m:
        return True
    try:
        inp = json.load(sys.stdin)
    except Exception:
        inp = {}
    cwd = inp.get("cwd") or os.getcwd()

    v = m.get("prompt_contains")
    if v is not None:
        if v not in (inp.get("prompt") or ""):
            return False

    v = m.get("prompt_matches")
    if v is not None:
        rx = compile_rx(v)
        if rx is None or not rx.search(inp.get("prompt") or ""):
            return False

    v = m.get("tool_name")
    if v is not None:
        allowed = arr(v)
        if allowed:
            tn = inp.get("tool_name")
            if not tn or tn not in allowed:
                return False

    v = m.get("tool_args_match")
    if v is not None:
        ta = inp.get("tool_args")
        ser = ta if isinstance(ta, str) else json.dumps(ta if ta is not None else "", separators=(",", ":"))
        rx = compile_rx(v)
        if rx is None or not rx.search(ser):
            return False

    v = m.get("cwd_includes")
    if v is not None:
        needles = arr(v)
        if needles and not any(n in cwd for n in needles):
            return False

    v = m.get("project_has")
    if v is not None:
        root = find_root(cwd)
        if not root or not os.path.exists(os.path.join(root, v)):
            return False

    v = m.get("git_dirty")
    if v is not None:
        if bool(v) != git_dirty(cwd):
            return False

    return True

print("FIRE" if should_fire() else "SKIP")
`;

/**
 * Gate-only pass-through tail: no caching, just run the underlying script with
 * stdin forwarded and stdout/exit code propagated, plus one timing log line.
 * Used when a hook declares \`matches:\` but no \`cache:\`.
 */
const PASSTHROUGH_TAIL = `now_ns() { "$PY" -c 'import time; print(int(time.time()*1e9))'; }
START_NS=$(now_ns)
EXIT=0
if printf '%s' "$STDIN_PAYLOAD" | "$SOURCE"; then
  EXIT=0
else
  EXIT=$?
fi
END_NS=$(now_ns)
MS=$(( (END_NS - START_NS) / 1000000 ))
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOG_FILE="$LOGS_DIR/events-$(date -u +%Y-%m-%d).jsonl"
printf '{"ts":"%s","event":"hook.fire","hook":"%s","ms":%d,"cache":"%s","exit":%d}\\n' \\
  "$TS" "$HOOK_NAME" "$MS" "none" "$EXIT" >>"$LOG_FILE" 2>/dev/null || true

exit "$EXIT"`;

/**
 * Render the bash shim. Bash 3.2-compatible (macOS default). Uses Python for
 * hashing + monotonic-ish nanosecond timing + portable mtime, resolved at
 * runtime (python3, then python) so a Windows Microsoft Store `python3` alias
 * stub — which exits non-zero without running — doesn't silently break caching.
 *
 * When `matches` is set, an early gate block evaluates the `matches:` predicates
 * against the event JSON on stdin and exits 0 without running the script when
 * they don't hold — this is the runtime enforcement of the documented `matches:`
 * gating (mirrors `shouldFire()` in match.ts). When `cache` is null the shim is
 * a gate-only pass-through: it forwards stdin to the script and its stdout back,
 * with no cache read/write.
 */
function renderShim(
  name: string,
  scriptPath: string,
  cache: HookCacheConfig | null,
  matches: HookMatches | undefined,
  paths: { cacheDir: string; logsDir: string }
): string {
  const ttl = cache ? (typeof cache.ttl === 'number' ? cache.ttl : (parseDuration(cache.ttl) ?? 0)) : 0;
  const key: HookCacheKey = cache?.key ?? 'global';
  const prefetch: HookCachePrefetch = cache?.prefetch ?? 'none';
  const { cacheDir, logsDir } = paths;

  const hasMatches = matches != null && Object.keys(matches).length > 0;
  const matchesJson = hasMatches ? JSON.stringify(matches) : '';

  // sh-escape: wrap in single quotes, escape any embedded single quotes.
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

  const cacheHeader = cache
    ? `# Cache: key=${key} ttl=${ttl}s prefetch=${prefetch}`
    : `# Cache: none (gate-only pass-through)`;
  const matchesHeader = hasMatches ? `\n# Matches: ${matchesJson}` : '';

  return `#!/usr/bin/env bash
# GENERATED by agents-cli. Do not edit — re-run \`agents hooks sync\` to refresh.
# Hook: ${name}
# Source: ${scriptPath}
${cacheHeader}${matchesHeader}
set -u

HOOK_NAME=${q(name)}
SOURCE=${q(scriptPath)}
CACHE_DIR=${q(cacheDir)}
LOGS_DIR=${q(logsDir)}
TTL=${ttl}
PREFETCH=${q(prefetch)}
KEY_MODE=${q(key)}
MATCHES_JSON=${q(matchesJson)}

mkdir -p "$CACHE_DIR" "$LOGS_DIR"

# Resolve a real Python. On Windows, bare python3 is often a Microsoft Store
# app-execution alias stub that prints to stderr and exits non-zero (0 bytes on
# stdout) -- command -v finds it but it cannot run, which silently empties the
# hash + mtime primitives below and makes EVERY call a cache miss (the hook
# re-runs every time). Probe by executing, not by lookup, and fall back to python.
PY=""
for _cand in python3 python; do
  if command -v "$_cand" >/dev/null 2>&1 && "$_cand" -c 'import sys' >/dev/null 2>&1; then
    PY="$_cand"; break
  fi
done
[ -z "$PY" ] && PY=python3

# Read stdin once (Claude/Codex/Gemini pass JSON on stdin to every hook).
STDIN_PAYLOAD="$(cat || true)"

# --- matches: gate (issue #744 / RUSH-1506) -------------------------------
# Enforce the hook's declared \`matches:\` predicates at fire time. Mirrors
# shouldFire() in src/lib/hooks/match.ts: all declared predicates AND together;
# an empty/absent block always fires. When the predicates don't hold we exit 0
# WITHOUT running the script (a skipped hook is not an error). Fail-open: any
# gate-eval error runs the script, so a broken predicate can never silently
# disable a safety hook (e.g. git-guard).
if [ -n "$MATCHES_JSON" ]; then
  _GATE="$(printf '%s' "$STDIN_PAYLOAD" | MATCHES_JSON="$MATCHES_JSON" "$PY" -c ${q(GATE_PY)} 2>/dev/null || printf FIRE)"
  [ -z "$_GATE" ] && _GATE=FIRE
  if [ "$_GATE" = SKIP ]; then
    _TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    _LOG_FILE="$LOGS_DIR/events-$(date -u +%Y-%m-%d).jsonl"
    printf '{"ts":"%s","event":"hook.fire","hook":"%s","ms":0,"cache":"skip","exit":0}\\n' \\
      "$_TS" "$HOOK_NAME" >>"$_LOG_FILE" 2>/dev/null || true
    exit 0
  fi
fi
${cache ? CACHE_TAIL : PASSTHROUGH_TAIL}
`;
}

/**
 * Cache tail: the full cache lookup / stale-while-revalidate / timing machinery.
 * Emitted only when the hook opts into \`cache:\`. (When only \`matches:\` is set,
 * PASSTHROUGH_TAIL runs instead — no cache read/write.)
 */
const CACHE_TAIL = `# Portable sha1 — \`shasum\` is Perl, missing on minimal Linux images;
# \`sha1sum\` is coreutils, missing on macOS. Truncate to 12 hex chars.
sha1_12() { "$PY" -c 'import hashlib,sys; print(hashlib.sha1(sys.stdin.read().encode()).hexdigest()[:12])'; }

# Derive cache key suffix from KEY_MODE. All untrusted inputs (cwd, session_id,
# project path) are hashed before going into the filename so a malicious stdin
# payload can't write outside $CACHE_DIR via path traversal.
cache_suffix=""
case "$KEY_MODE" in
  per-cwd)
    cwd_val="$(printf '%s' "$STDIN_PAYLOAD" | "$PY" -c 'import json,sys
try: print(json.load(sys.stdin).get("cwd","") or "")
except Exception: pass' 2>/dev/null || true)"
    [ -z "$cwd_val" ] && cwd_val="$PWD"
    cache_suffix=".$(printf '%s' "$cwd_val" | sha1_12)"
    ;;
  per-session)
    sid_val="$(printf '%s' "$STDIN_PAYLOAD" | "$PY" -c 'import json,sys
try: print(json.load(sys.stdin).get("session_id","") or "")
except Exception: pass' 2>/dev/null || true)"
    # Hash + fall back to a sentinel so missing-session doesn't silently
    # collapse to the same file as KEY_MODE=global.
    [ -z "$sid_val" ] && sid_val="__nosession__"
    cache_suffix=".$(printf '%s' "$sid_val" | sha1_12)"
    ;;
  per-project)
    proj_val="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || echo "")"
    [ -z "$proj_val" ] && proj_val="$PWD"
    cache_suffix=".$(printf '%s' "$proj_val" | sha1_12)"
    ;;
  global|*)
    cache_suffix=""
    ;;
esac
CACHE_FILE="$CACHE_DIR/$HOOK_NAME$cache_suffix.out"

# Monotonic-ish nanosecond timer (macOS \`date\` has no %N).
now_ns() { "$PY" -c 'import time; print(int(time.time()*1e9))'; }
START_NS=$(now_ns)

CACHE_STATUS=miss
CACHE_AGE=-1
EXIT=0

if [ -f "$CACHE_FILE" ]; then
  # $PY is already resolved (used for now_ns) and gives portable mtime
  # without the macOS-vs-Linux \`stat\` flag divergence (-f %m vs -c %Y) that
  # blew up under \`set -u\` when the wrong flag produced literal "%m".
  mtime=$("$PY" -c 'import os,sys; print(int(os.path.getmtime(sys.argv[1])))' "$CACHE_FILE" 2>/dev/null)
  mtime=\${mtime:-0}
  now_s=$(date +%s)
  CACHE_AGE=$((now_s - mtime))
  if [ "$CACHE_AGE" -ge 0 ] && [ "$CACHE_AGE" -lt "$TTL" ]; then
    cat "$CACHE_FILE"
    CACHE_STATUS=hit
  fi
fi

if [ "$CACHE_STATUS" = miss ]; then
  if [ -f "$CACHE_FILE" ] && [ "$PREFETCH" = background ]; then
    # Stale-while-revalidate: serve stale immediately, refresh in detached child.
    cat "$CACHE_FILE"
    CACHE_STATUS=stale-prefetch
    tmp="$CACHE_FILE.new.$$"
    ( printf '%s' "$STDIN_PAYLOAD" | "$SOURCE" >"$tmp" 2>/dev/null && mv -f "$tmp" "$CACHE_FILE" || rm -f "$tmp" ) >/dev/null 2>&1 &
    disown 2>/dev/null || true
  else
    # Synchronous fetch + cache.
    tmp="$CACHE_FILE.new.$$"
    if printf '%s' "$STDIN_PAYLOAD" | "$SOURCE" >"$tmp"; then
      EXIT=0
      cat "$tmp"
      mv -f "$tmp" "$CACHE_FILE"
    else
      EXIT=$?
      rm -f "$tmp"
    fi
  fi
fi

END_NS=$(now_ns)
MS=$(( (END_NS - START_NS) / 1000000 ))
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOG_FILE="$LOGS_DIR/events-$(date -u +%Y-%m-%d).jsonl"
printf '{"ts":"%s","event":"hook.fire","hook":"%s","ms":%d,"cache":"%s","exit":%d}\\n' \\
  "$TS" "$HOOK_NAME" "$MS" "$CACHE_STATUS" "$EXIT" >>"$LOG_FILE" 2>/dev/null || true

exit "$EXIT"
`;

/**
 * Remove a hook's shim. Called by the registrar's garbage collection when a
 * hook is renamed/deleted or has its `cache:` field removed.
 */
export function removeHookShim(name: string, shimsDir?: string): void {
  if (!isValidHookShimName(name)) return;
  const dir = shimsDir ?? getHookShimsDir();
  const shimPath = resolveContainedHookShimPath(dir, name);
  if (fs.existsSync(shimPath)) {
    try { fs.unlinkSync(shimPath); } catch { /* best effort */ }
  }
}
