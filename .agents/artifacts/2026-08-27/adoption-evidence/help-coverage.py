#!/usr/bin/env python3
"""Which of the CLI's 69 top-level groups does `agents --help` actually name?

The plan cites "names 45 of 69, never mentions 24". This is how that is measured,
and it is deliberately NOT the row-count one-liner used for the cross-CLI
comparison — that counts aligned two-column entries (26 for `agents`) and is a
different question. This matches each real group name against the help text.
"""
import json, os, re, subprocess, sys

IDX = os.path.expanduser("~/src/github.com/muqsitnawaz/agents-cli/cli/docs/command-index.json")
groups = sorted({n["path"] for n in json.load(open(IDX))["tree"] if n.get("path")})
help_txt = subprocess.run(["agents", "--help"], capture_output=True, text=True).stdout

def is_named(g):
    """A group counts as NAMED only if the help text actually names the command.

    A bare substring search over the whole help text is wrong: `auth` matches
    inside "(host CLI + model + auth) harnesses", which describes `harness`;
    `open` matches "(open blocks waiting on you)", which describes `feed`. Those
    credit a group for appearing in some OTHER command's prose. Two honest forms:

      1. the leading command token of a help line  ("  sessions   Browse past ...")
      2. an explicit invocation anywhere           ("agents-cli itself is 'agents upgrade'")
    """
    esc = re.escape(g)
    leading = re.compile(r"^\s{2,6}(?:agents\s+)?" + esc + r"(?![\w-])", re.M)
    invocation = re.compile(r"(?<![\w-])agents\s+" + esc + r"(?![\w-])")
    return bool(leading.search(help_txt) or invocation.search(help_txt))


named = [g for g in groups if is_named(g)]
missing = [g for g in groups if g not in named]

reach = {}
report = os.path.join(os.path.dirname(os.path.abspath(__file__)), "command-usage-report.txt")
if os.path.exists(report):
    sec = open(report).read().split("GROUPS BY SESSION REACH ===")
    if len(sec) > 1:
        for line in sec[1].strip().splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[0].isdigit():
                reach[parts[1]] = int(parts[0])

rank = {g: i + 1 for i, (g, _) in enumerate(sorted(reach.items(), key=lambda x: -x[1]))}

print(f"top-level groups (command-index): {len(groups)}")
print(f"named anywhere in `agents --help`: {len(named)}")
print(f"NEVER mentioned:                   {len(missing)}\n")
print("never mentioned, ranked by measured session reach:")
for g in sorted(missing, key=lambda x: -reach.get(x, 0)):
    r = f"#{rank[g]}" if g in rank else "-"
    print(f"  {reach.get(g, 0):>5} sessions  rank {r:<5} {g}")
