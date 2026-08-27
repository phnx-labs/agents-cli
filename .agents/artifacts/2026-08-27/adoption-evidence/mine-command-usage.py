#!/usr/bin/env python3
"""How often is each `agents` command ACTUALLY EXECUTED inside a shell tool call?

Counts by invocations AND by distinct transcripts. Distinct-transcript reach is
the honest popularity signal: raw invocation counts are dominated by hook
boilerplate that is re-injected into every transcript.

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
rg = subprocess.Popen(
    ["rg", "--hidden", "--no-ignore", "--no-messages", "-l",
     "-g", "*.jsonl", "-g", "*.json",
     r'"(Bash|shell|run_terminal_cmd|execute_command|local_shell_call|bash|run_command)"', ROOT],
    stdout=subprocess.PIPE, text=True)

inv = collections.Counter()
sess = collections.defaultdict(set)
per_harness = collections.Counter()
scanned_per_harness = collections.Counter()
nfiles = 0
for fp in rg.stdout:
    fp = fp.strip()
    if not fp:
        continue
    nfiles += 1
    parts = fp.split("/versions/")
    harness = parts[1].split("/")[0] if len(parts) > 1 else "(not under versions/)"
    scanned_per_harness[harness] += 1
    matched_here = False
    for obj in records(fp):
        for cmd in extract(obj, []):
            for m in INVOKE.finditer(cmd):
                c = canon(m.group(1).split())
                if c:
                    inv[c] += 1
                    sess[c].add(fp)
                    matched_here = True
    if matched_here:
        per_harness[harness] += 1

reach = {k: len(v) for k, v in sess.items()}
total_exec = sum(inv.values())
ranked = sorted(inv.items(), key=lambda x: -x[1])
never = sorted(paths - set(inv))

json.dump({"files_scanned": nfiles, "total_executions": total_exec,
           "invocations": dict(inv), "transcript_reach": reach,
           "scanned_per_harness": dict(scanned_per_harness),
           "transcripts_with_hits_per_harness": dict(per_harness),
           "surface": sorted(paths)},
          open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "command-usage.json"), "w"),
          indent=1)

o = sys.stdout
print(f"transcripts scanned:                {nfiles:,}", file=o)
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
print(f"  50+ transcripts   (daily driver)  {t50}", file=o)
print(f"  10-49 transcripts (occasional)    {t10}", file=o)
print(f"  3-9 transcripts   (rare)          {t3}", file=o)
print(f"  1-2 transcripts   (near-dead)     {t1}", file=o)
print(f"  never executed                    {len(never)}", file=o)
print(f"  TOTAL                             {t50+t10+t3+t1+len(never)} (surface = {len(paths)})", file=o)
print(f"  dead or near-dead ({t1}+{len(never)})    {t1+len(never)} "
      f"({100*(t1+len(never))/len(paths):.0f}% of the surface)", file=o)

print("\n=== COVERAGE BY HARNESS — read this before trusting the tiers ===", file=o)
print(f"{'harness':<24}{'scanned':>9}{'with hits':>11}", file=o)
for k in sorted(set(scanned_per_harness) | set(per_harness),
                key=lambda x: -scanned_per_harness[x]):
    print(f"{k:<24}{scanned_per_harness[k]:>9,}{per_harness[k]:>11,}", file=o)
print("\nSQLite-backed transcript stores are not read by this script.", file=o)

print("\n=== TOP 45 BY TRANSCRIPT REACH ===", file=o)
for k, v in sorted(reach.items(), key=lambda x: -x[1])[:45]:
    print(f"{v:>6} transcripts  {inv[k]:>8,} runs   {k}", file=o)

print("\n=== EXECUTED IN <=2 TRANSCRIPTS ===", file=o)
tail = sorted([k for k, v in reach.items() if v <= 2])
print(f"{len(tail)} commands\n" + ", ".join(tail), file=o)

print("\n=== NEVER EXECUTED ===", file=o)
print(f"{len(never)} commands\n" + ", ".join(never), file=o)

g = collections.defaultdict(set)
for k, v in sess.items():
    g[k.split()[0]] |= v
print("\n=== GROUPS BY TRANSCRIPT REACH ===", file=o)
for k, v in sorted(g.items(), key=lambda x: -len(x[1])):
    print(f"{len(v):>6}  {k}", file=o)
