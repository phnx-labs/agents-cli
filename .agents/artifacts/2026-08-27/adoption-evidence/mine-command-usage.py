#!/usr/bin/env python3
"""Authoritative usage metric: `agents ...` commands ACTUALLY EXECUTED inside
Bash-style tool calls, counted by invocations AND by distinct sessions.

Distinct-session reach is the honest popularity signal: raw invocation counts are
dominated by hook boilerplate that is re-injected into every transcript.
"""
import json, os, re, collections, subprocess

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
TOP = {p for p in paths if " " not in p}

INVOKE = re.compile(r'\b(?:agents|agents-dev|ag)\s+((?:[a-z][a-z0-9_-]*\s+){0,2}[a-z][a-z0-9_-]*)')
TOOLNAMES = ("Bash", "shell", "run_terminal_cmd", "execute_command", "local_shell_call")


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
        if (obj.get("name") or obj.get("tool_name")) in TOOLNAMES:
            inp = obj.get("input") or obj.get("arguments") or obj.get("parameters") or {}
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


ROOT = os.path.expanduser("~/.agents/.history")
rg = subprocess.Popen(
    ["rg", "--hidden", "--no-ignore", "--no-messages", "-l", "-g", "*.jsonl",
     r'"(Bash|shell|run_terminal_cmd|execute_command|local_shell_call)"', ROOT],
    stdout=subprocess.PIPE, text=True)

inv = collections.Counter()
sess = collections.defaultdict(set)
nfiles = 0
for fp in rg.stdout:
    fp = fp.strip()
    if not fp:
        continue
    nfiles += 1
    sid = os.path.basename(fp)
    try:
        fh = open(fp, errors="ignore")
    except OSError:
        continue
    with fh:
        for line in fh:
            if "agents " not in line and "ag " not in line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            for cmd in extract(obj, []):
                for m in INVOKE.finditer(cmd):
                    c = canon(m.group(1).split())
                    if c:
                        inv[c] += 1
                        sess[c].add(sid)

reach = {k: len(v) for k, v in sess.items()}
json.dump({"files_scanned": nfiles, "invocations": dict(inv), "session_reach": reach,
           "surface": sorted(paths)},
          open("exec-usage.json", "w"), indent=1)

print(f"transcripts scanned: {nfiles:,}")
print(f"distinct commands actually executed: {len(inv)} / {len(paths)}")
print(f"NEVER executed: {len(paths) - len(inv)} ({100*(len(paths)-len(inv))/len(paths):.0f}%)\n")

print("=== TOP 45 BY SESSION REACH (how many distinct sessions ran it) ===")
for k, v in sorted(reach.items(), key=lambda x: -x[1])[:45]:
    print(f"{v:>6}  sessions  {inv[k]:>8,} runs   {k}")

print("\n=== LONG TAIL: executed in <=2 distinct sessions ===")
tail = sorted([k for k, v in reach.items() if v <= 2])
print(f"{len(tail)} commands")
print(", ".join(tail))

print("\n=== NEVER EXECUTED ===")
never = sorted(paths - set(inv))
print(f"{len(never)} commands")
print(", ".join(never))

g_reach = collections.defaultdict(set)
for k, v in sess.items():
    g_reach[k.split()[0]] |= v
print("\n=== GROUPS BY SESSION REACH ===")
for k, v in sorted(g_reach.items(), key=lambda x: -len(x[1])):
    print(f"{len(v):>6}  {k}")
