#!/usr/bin/env python3
"""
analyze-session-cli-usage.py — mine agent transcripts for real `agents sessions` usage.

Answers: when do agents/users actually reach for the sessions CLI, and which
filters do they use? Scans local transcript JSONL files (Claude, Codex, and any
other harness that stores JSONL) modified within a lookback window, samples up to
--max of them, and tallies every `agents sessions` / `ag sessions` invocation
found in tool-call command fields.

Format-agnostic: it does not parse each harness's schema. It extracts the string
value of every JSON "command" field (both the "command":"..." and
"command":[...] shapes) and keeps the ones that invoke the sessions CLI. That
catches real tool calls and skips assistant prose.

Usage:
    python3 analyze-session-cli-usage.py [--days 14] [--max 100] [--seed 7] [--json out.json]
"""
from __future__ import annotations
import argparse, json, os, random, re, sys, time
from collections import Counter

# Transcript roots. Both the live home and the versioned home layout agents-cli uses.
HOME = os.path.expanduser("~")
ROOT_GLOBS = [
    f"{HOME}/.claude/projects",
    f"{HOME}/.codex/sessions",
    f"{HOME}/.agents/.history/versions",  # versioned homes for every harness
]

# A sessions-CLI invocation inside a shell command. `agents`/`ag`, then `sessions`
# (or the singular `session`), then the rest of the argv up to a command separator.
INVOKE_RE = re.compile(r"\b(?:agents|ag)\s+sessions?\b([^\n;|&]*)")
# "command":"...."  (JSON-escaped scalar)
CMD_SCALAR_RE = re.compile(r'"command"\s*:\s*"((?:[^"\\]|\\.)*)"')
# "command":[ ... ]  (argv array, e.g. codex ["bash","-lc","..."])
CMD_ARRAY_RE = re.compile(r'"command"\s*:\s*\[([^\]]*)\]')

# A flag token: --active, --host, --since, etc. (value not captured)
FLAG_RE = re.compile(r"(--[a-z][a-z0-9-]*)")
# Known sessions subcommands (first non-flag token after `sessions`)
SUBCOMMANDS = {"tail", "sync", "resume", "favorite", "favourites", "favorites"}


def find_transcripts(days: int) -> list[str]:
    cutoff = time.time() - days * 86400
    out: list[str] = []
    seen: set[str] = set()
    for root in ROOT_GLOBS:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                if not fn.endswith(".jsonl"):
                    continue
                p = os.path.join(dirpath, fn)
                rp = os.path.realpath(p)
                if rp in seen:
                    continue
                try:
                    if os.path.getmtime(p) < cutoff:
                        continue
                except OSError:
                    continue
                seen.add(rp)
                out.append(p)
    return out


def unescape(s: str) -> str:
    try:
        return json.loads('"' + s + '"')
    except Exception:
        return s


def commands_in_line(line: str) -> list[str]:
    cmds: list[str] = []
    for m in CMD_SCALAR_RE.finditer(line):
        cmds.append(unescape(m.group(1)))
    for m in CMD_ARRAY_RE.finditer(line):
        # join argv items so `bash -lc "agents sessions ..."` is searchable as one string
        parts = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))
        if parts:
            cmds.append(" ".join(unescape(p) for p in parts))
    return cmds


def classify(argv_tail: str) -> tuple[str, list[str], bool]:
    """Return (subcommand, flags, has_positional_query) for the text after `sessions`."""
    flags = FLAG_RE.findall(argv_tail)
    toks = argv_tail.strip().split()
    sub = "list"
    has_query = False
    seen_subcommand = False
    for t in toks:
        if t.startswith("-"):
            continue
        if t in SUBCOMMANDS and not seen_subcommand:
            # e.g. `sessions resume <id>` — record the verb, keep scanning for its arg
            sub = t
            seen_subcommand = True
            continue
        # any other bare positional is a query term, id, or path (incl. a subcommand's arg)
        has_query = True
        break
    return sub, flags, has_query


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--max", type=int, default=100)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--json", dest="json_out", default=None)
    args = ap.parse_args()

    all_files = find_transcripts(args.days)
    random.seed(args.seed)
    sample = all_files if len(all_files) <= args.max else random.sample(all_files, args.max)

    sub_counts: Counter[str] = Counter()
    flag_counts: Counter[str] = Counter()
    total_invokes = 0
    positional_queries = 0
    sessions_with_use = 0
    files_scanned = 0

    for path in sample:
        files_scanned += 1
        used_here = False
        try:
            with open(path, "r", errors="ignore") as fh:
                for line in fh:
                    if "session" not in line:  # cheap prefilter
                        continue
                    for cmd in commands_in_line(line):
                        for m in INVOKE_RE.finditer(cmd):
                            total_invokes += 1
                            used_here = True
                            sub, flags, has_query = classify(m.group(1))
                            sub_counts[sub] += 1
                            if has_query:
                                positional_queries += 1
                            for f in flags:
                                flag_counts[f] += 1
        except OSError:
            continue
        if used_here:
            sessions_with_use += 1

    result = {
        "window_days": args.days,
        "transcripts_found": len(all_files),
        "transcripts_sampled": files_scanned,
        "sessions_that_used_the_cli": sessions_with_use,
        "total_invocations": total_invokes,
        "invocations_with_positional_query": positional_queries,
        "subcommand_frequency": sub_counts.most_common(),
        "flag_frequency": flag_counts.most_common(),
    }

    print(f"\n  agents sessions — usage over the last {args.days} days")
    print(f"  {'-'*54}")
    print(f"  transcripts found (window):   {len(all_files)}")
    print(f"  transcripts sampled:          {files_scanned}")
    print(f"  sessions that used the CLI:    {sessions_with_use}"
          f"  ({pct(sessions_with_use, files_scanned)} of sampled)")
    print(f"  total invocations:            {total_invokes}")
    print(f"  invocations with a query arg: {positional_queries}"
          f"  ({pct(positional_queries, total_invokes)})")
    print(f"\n  subcommand mix:")
    for name, n in sub_counts.most_common():
        print(f"    {name:<14} {n:>5}  {bar(n, total_invokes)}")
    print(f"\n  filter / flag frequency (share of invocations):")
    for name, n in flag_counts.most_common(20):
        print(f"    {name:<18} {n:>5}  {pct(n, total_invokes):>6}  {bar(n, total_invokes)}")
    print()

    if args.json_out:
        with open(args.json_out, "w") as fh:
            json.dump(result, fh, indent=2)
        print(f"  wrote {args.json_out}\n")
    return 0


def pct(n: int, d: int) -> str:
    return f"{(100*n/d):.0f}%" if d else "0%"


def bar(n: int, d: int, width: int = 28) -> str:
    if not d:
        return ""
    return "#" * max(1, round(width * n / d)) if n else ""


if __name__ == "__main__":
    sys.exit(main())
