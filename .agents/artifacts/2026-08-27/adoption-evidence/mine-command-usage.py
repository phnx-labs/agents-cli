#!/usr/bin/env python3
"""How often is each `agents` command ACTUALLY EXECUTED inside a shell tool call?

Counts by invocations AND by distinct SESSIONS. Session reach is the honest
popularity signal: raw invocation counts are dominated by hook boilerplate that is
re-injected into every transcript.

Sessions are DEDUPLICATED by session id (the transcript filename), because
~/.agents/.history keeps repeat copies of the same transcript under backups/ and
under runs/<job>/<timestamp>/ -- one security-sweep session appears under six
different run timestamps. Keying reach on the file path counted it six times and
inflated every reach number by roughly a third.

Duplicate resolution is DETERMINISTIC: for each session id, the canonical copy is
chosen by (under versions/ first, then largest file, then lexically smallest path).
`rg -l` returns paths in nondeterministic parallel-walk order, and a backups/ copy
can be an older, truncated snapshot of a session that is complete under versions/.
Taking whichever copy happened to be seen first made the totals swing by 15% run
to run. Sorting and preferring the canonical copy fixes that.

The session id is the path TAIL after the store prefix, not the bare filename.
Filename alone is wrong: 118 distinct kimi sessions all end in
`agents/main/wire.jsonl`, and Antigravity/Gemini both use `transcript.jsonl`, so a
basename key silently merges them into one. The tail
(`sessions/wd_.../session_<uuid>/agents/main/wire.jsonl`) is stable across stores
and unique per session.

Transcript formats differ per harness, so this reads BOTH line-delimited JSONL
(Claude, Grok, some Antigravity) and whole-file JSON (Codex, OpenCode, Cursor,
Droid, Kimi, Muse). SQLite-backed stores are NOT read; the per-harness coverage
table printed at the end states the shortfall instead of hiding it.

Every number the plan cites is printed here, so the plan is reproducible from
this script's committed output alone.
"""
import json, os, re, collections, subprocess, sys

IDX = os.path.expanduser("~/src/github.com/muqsitnawaz/agents-cli/cli/docs/command-index.json")
idx = json.load(open(IDX))
paths, alias_of = set(), {}


def walk(n):
    p = n.get("path", "")
    if p:
        paths.add(p)
        for a in n.get("aliases", []):
            parts = p.split()
            alias_of[" ".join(parts[:-1] + [a]).strip()] = p
    for s in n.get("subcommands") or []:
        walk(s)


for n in idx["tree"]:
    walk(n)

INVOKE = re.compile(r'\b(?:agents|agents-dev|ag)\s+((?:[a-z][a-z0-9_-]*\s+){0,2}[a-z][a-z0-9_-]*)')
TOOLNAMES = ("Bash", "shell", "run_terminal_cmd", "execute_command", "local_shell_call",
             "bash", "run_command", "terminal", "exec_command")


def canon(toks):
    for k in (3, 2, 1):
        c = " ".join(toks[:k])
        if c in alias_of:
            return alias_of[c]
        if c in paths:
            return c
    return None


def extract(obj, out):
    """Pull every shell-tool command string out of one transcript record."""
    if isinstance(obj, dict):
        if (obj.get("name") or obj.get("tool_name") or obj.get("toolName")) in TOOLNAMES:
            inp = (obj.get("input") or obj.get("arguments") or obj.get("parameters")
                   or obj.get("args") or {})
            if isinstance(inp, str):
                try:
                    inp = json.loads(inp)
                except Exception:
                    inp = {"command": inp}
            if isinstance(inp, dict):
                for k in ("command", "cmd", "script"):
                    v = inp.get(k)
                    if isinstance(v, str):
                        out.append(v)
                    elif isinstance(v, list):
                        out.append(" ".join(map(str, v)))
        for v in obj.values():
            extract(v, out)
    elif isinstance(obj, list):
        for v in obj:
            extract(v, out)
    return out


def records(fp):
    """Yield parsed records from a transcript, line-delimited or whole-file."""
    try:
        raw = open(fp, errors="ignore").read()
    except OSError:
        return
    if "agents " not in raw and "ag " not in raw:
        return
    hit = False
    for line in raw.splitlines():
        line = line.strip()
        if not line or line[0] not in "{[":
            continue
        try:
            yield json.loads(line)
            hit = True
        except Exception:
            continue
    if not hit:                       # whole-file JSON (Codex, OpenCode, Cursor, ...)
        try:
            yield json.loads(raw)
        except Exception:
            return


ROOT = os.path.expanduser("~/.agents/.history")
rg = subprocess.run(
    ["rg", "--hidden", "--no-ignore", "--no-messages", "-l",
     "-g", "*.jsonl", "-g", "*.json",
     r'"(Bash|shell|run_terminal_cmd|execute_command|local_shell_call|bash|run_command)"', ROOT],
    capture_output=True, text=True)

all_files = sorted(l.strip() for l in rg.stdout.splitlines() if l.strip())


# Store prefixes, most specific first. Each names WHICH COPY a file is, so the
# remaining tail names WHICH SESSION it is. Order matters: backups/<harness>/<device>/
# must not be read as backups/<kind>/<harness>/.
STORE_PREFIXES = [
    re.compile(r"^runs/[^/]+/[^/]+/sessions/(?P<h>[^/]+)/"),
    re.compile(r"^backups/settings-carry/(?P<h>[^/]+)/[^/]+/"),
    re.compile(r"^backups/(?P<h>[^/]+)/[^/]+/"),
    re.compile(r"^(?:trash/)?versions/(?P<h>[^/]+)/[^/]+/(?:\d{4}-[^/]+/)?"),
    re.compile(r"^(?:trash/)?plugins/(?P<h>[^/]+)/"),
    re.compile(r"^(?P<h>activity)/"),
]


def split_store(path):
    """Return (harness, session_tail).

    The same session is copied under versions/, trash/versions/, runs/<job>/<ts>/
    and backups/<harness>/<device>/, always keeping the same tail. Keying on the
    tail merges those copies and nothing else.

    Keying on the BASENAME instead would be wrong: 118 genuinely distinct kimi
    sessions all end in `agents/main/wire.jsonl`, and Antigravity and Gemini both
    use `transcript.jsonl`, so a basename key silently merges distinct sessions
    into one and misreports their commands as never executed.
    """
    rel = path.split("/.history/", 1)[-1]
    for rx in STORE_PREFIXES:
        m = rx.match(rel)
        if m:
            tail = rel[m.end():]
            if tail.startswith("home/"):
                tail = tail[len("home/"):]
            return m.group("h"), tail
    return "(other .history store)", rel


def canonical_rank(path):
    """Lower sorts better. Prefer versions/, then the largest copy, then a stable path."""
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    return (0 if "/versions/" in path else 1, -size, path)


# One canonical file per session id, chosen deterministically.
by_id = collections.defaultdict(list)
harness_of = {}
for fp in all_files:
    h, tail = split_store(fp)
    by_id[tail].append(fp)
    harness_of.setdefault(tail, h)
chosen = {sid: min(paths_, key=canonical_rank) for sid, paths_ in by_id.items()}

inv = collections.Counter()
sess = collections.defaultdict(set)
per_harness = collections.defaultdict(set)
scanned_per_harness = collections.defaultdict(set)
nfiles = len(all_files)
seen_ids = set(chosen)
for sid in sorted(chosen):
    fp = chosen[sid]
    harness = harness_of[sid]
    scanned_per_harness[harness].add(sid)
    matched_here = False
    for obj in records(fp):
        for cmd in extract(obj, []):
            for m in INVOKE.finditer(cmd):
                c = canon(m.group(1).split())
                if c:
                    inv[c] += 1
                    sess[c].add(sid)
                    matched_here = True
    if matched_here:
        per_harness[harness].add(sid)

reach = {k: len(v) for k, v in sess.items()}
total_exec = sum(inv.values())
ranked = sorted(inv.items(), key=lambda x: (-x[1], x[0]))
never = sorted(paths - set(inv))

json.dump({"files_seen": nfiles, "distinct_sessions": len(seen_ids),
           "duplicate_copies_skipped": nfiles - len(seen_ids),
           "total_executions": total_exec,
           "invocations": dict(inv), "session_reach": reach,
           "distinct_sessions_per_harness": {k: len(v) for k, v in scanned_per_harness.items()},
           "sessions_with_hits_per_harness": {k: len(v) for k, v in per_harness.items()},
           "surface": sorted(paths)},
          open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "command-usage.json"), "w"),
          indent=1)

o = sys.stdout
print(f"transcript files seen:              {nfiles:,}", file=o)
print(f"DISTINCT sessions (deduped by id):  {len(seen_ids):,}", file=o)
print(f"duplicate copies skipped:           {nfiles - len(seen_ids):,}"
      f"  (backups/ and runs/ keep repeat copies of the same session)", file=o)
print(f"total `agents` executions matched:  {total_exec:,}", file=o)
print(f"distinct commands ever executed:    {len(inv)} / {len(paths)}", file=o)
print(f"NEVER executed:                     {len(never)} ({100*len(never)/len(paths):.0f}%)\n", file=o)

print("=== CONCENTRATION (cited in the plan) ===", file=o)
for n in (5, 10, 20, 30, 50, 100):
    print(f"top {n:>3} commands = {100*sum(v for _, v in ranked[:n])/total_exec:5.1f}% of all executions", file=o)

print("\n=== USAGE TIERS (cited in the plan; the five sum to the full surface) ===", file=o)
t50 = len([k for k, v in reach.items() if v >= 50])
t10 = len([k for k, v in reach.items() if 10 <= v <= 49])
t3 = len([k for k, v in reach.items() if 3 <= v <= 9])
t1 = len([k for k, v in reach.items() if v <= 2])
print(f"  50+ sessions   (daily driver)  {t50}", file=o)
print(f"  10-49 sessions (occasional)    {t10}", file=o)
print(f"  3-9 sessions   (rare)          {t3}", file=o)
print(f"  1-2 sessions   (near-dead)     {t1}", file=o)
print(f"  never executed                    {len(never)}", file=o)
print(f"  TOTAL                             {t50+t10+t3+t1+len(never)} (surface = {len(paths)})", file=o)
print(f"  dead or near-dead ({t1}+{len(never)})    {t1+len(never)} "
      f"({100*(t1+len(never))/len(paths):.0f}% of the surface)", file=o)

print("\n=== COVERAGE BY HARNESS — read this before trusting the tiers ===", file=o)
print(f"{'harness':<40}{'sessions':>10}{'with hits':>11}", file=o)
for k in sorted(set(scanned_per_harness) | set(per_harness),
                key=lambda x: (-len(scanned_per_harness[x]), x)):
    print(f"{k:<40}{len(scanned_per_harness[k]):>10,}{len(per_harness[k]):>11,}", file=o)
print("\nSQLite-backed transcript stores are not read by this script.", file=o)

print("\n=== TOP 45 BY TRANSCRIPT REACH ===", file=o)
for k, v in sorted(reach.items(), key=lambda x: (-x[1], x[0]))[:45]:
    print(f"{v:>6} sessions  {inv[k]:>8,} runs   {k}", file=o)

print("\n=== EXECUTED IN <=2 TRANSCRIPTS ===", file=o)
tail = sorted([k for k, v in reach.items() if v <= 2])
print(f"{len(tail)} commands\n" + ", ".join(tail), file=o)

print("\n=== NEVER EXECUTED ===", file=o)
print(f"{len(never)} commands\n" + ", ".join(never), file=o)

g = collections.defaultdict(set)
for k, v in sess.items():
    g[k.split()[0]] |= v
print("\n=== GROUPS BY SESSION REACH ===", file=o)
for k, v in sorted(g.items(), key=lambda x: (-len(x[1]), x[0])):
    print(f"{len(v):>6}  {k}", file=o)
