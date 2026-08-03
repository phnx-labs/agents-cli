---
name: design-drift
description: "Read-only nightly review that scans recently-merged work for DESIGN DRIFT — new primitives added where an existing one should have been reused/extended, producing overlapping surfaces (the `agents feed`/`activity`/`notify`/`message`/`send` smell). Reuses the `quality` skill's engine, ranks findings with a consolidation lens, files (or drafts) Linear tickets, and messages the owner a short summary. Never fixes code. Triggers on: 'design drift', 'overlapping surfaces', 'nightly drift review', 'what merged that should have reused something', 'consolidation opportunities'."
argument-hint: "[--since \"<date>\"] [--notify]"
allowed-tools: Bash(git*), Bash(gh*), Bash(rg*), Bash(fd*), Bash(jq*), Bash(bun*), Bash(ls*), Bash(wc*), Bash(mkdir*), Bash(agents secrets*), Bash(rush message*), Bash(linear*), Read(*), Write(*), Agent(*)
user-invocable: true
---

# design-drift

> A read-only nightly review. Scans PRs merged since the last run for **design
> drift** — the AI-era smell where an agent adds a NEW primitive instead of
> reusing/extending an existing one, leaving N overlapping surfaces that work but
> are messy and hard to improve. Ranks the findings, names the primitive that
> should have absorbed the new code, files/drafts Linear tickets, and messages the
> owner. **It never edits code** — it exists to flag messy code, so it must not add
> any. Fixes are the owner's call, per-issue.

The canonical smell to catch (the operator's own example): `agents feed`,
`agents activity`, `agents notify`, `agents message`, `agents send` all exist to
get a message to a human — overlapping surfaces one well-extended primitive could
have covered.

## Why this reuses `quality` (do not write a parallel analyzer)

The repo already has a read-only code-health engine — the **`quality`** skill —
whose `signatures.ts` clusters parallel implementations by behavioral signature and
whose architecture pass flags "new abstraction that duplicates an existing canonical
one." Those are exactly the drift detectors. This skill is an **orchestrator + a
consolidation lens on top of that engine**, not a second analyzer. Writing a
parallel analyzer here would itself be the drift this routine exists to catch.

Resolve the engine dir once (installed plugin, or vendored in-repo):

```bash
QDIR="$HOME/.agents/plugins/code/skills/quality"
[ -d "$QDIR" ] || QDIR="$(git rev-parse --show-toplevel)/.agents/plugins/code/skills/quality"
SKILL_DIR="$(git rev-parse --show-toplevel)/.agents/skills/design-drift"
```

## Phase 1 — Scope the recent work

```bash
RUN_DIR="$(bash "$SKILL_DIR/scope.sh" ${SINCE:+--since "$SINCE"} | tail -1)"
```

`scope.sh` enumerates PRs merged to the default branch in the window (default: since
the newest prior `.agents/reports/design-drift-*.md`, or 14 days on first run),
collects the changed files into `$RUN_DIR/files.txt`, summarizes the touched command
/ module surfaces into `$RUN_DIR/surfaces.txt`, and writes `$RUN_DIR/meta.json` +
`$RUN_DIR/prs.json`. It is read-only (git/gh reads; writes only under the gitignored
`.agents/artifacts/`).

## Phase 2 — Run the reused engine passes

Behavioral-signature clustering (mechanical, reused verbatim):

```bash
bun "$QDIR/signatures.ts" "$RUN_DIR" > "$RUN_DIR/findings/signatures.json"
```

Architecture / cross-surface drift pass — the `quality` architecture subagent,
re-briefed for the consolidation lens. It sees the whole recent surface
constellation (not just one diff), so it can spot N overlapping commands that
per-diff analysis can't. Spawn one Sonnet subagent:

```
Agent(subagent_type: "general-purpose", model: "sonnet", prompt: <DRIFT-LENS BRIEF below>)
```

### DRIFT-LENS BRIEF (fill the `{{ }}` slots, drop verbatim)

```
You are a READ-ONLY design-drift auditor for {{ repo path }} (analyze the default
branch; do NOT edit any file). Design drift = a NEW primitive added where an
existing one should have been reused/extended, leaving overlapping surfaces that
work but are messy.

SURFACES TOUCHED IN THIS WINDOW (changed-file count per surface):
{{ paste $RUN_DIR/surfaces.txt }}

PRs MERGED IN THIS WINDOW:
{{ paste `jq -r '.[] | "#\(.number) \(.title)"' $RUN_DIR/prs.json` }}

MECHANICAL PARALLEL-IMPL HINTS (from the quality signatures pass — verify each, do
not trust blindly):
{{ paste $RUN_DIR/findings/signatures.json }}

YOUR JOB — with hard file:line evidence:
1. DUPLICATE / OVERLAPPING PRIMITIVES — N distinct command surfaces or modules
   doing one job (several ways to emit a message to a human; several ways to read
   one activity/event stream; two stores/caches/resolvers for one concept). Name
   every overlapping surface with file:line and a verbatim quote.
2. NON-REUSE / NON-EXTENSION — a new function/type/command that re-implements what
   an existing one does (near-identical `else if (agent === ...)` arms instead of
   the registry pattern; a second store/write-path; a parallel redactor/parser/
   formatter) instead of extending the canonical one.
3. CONSOLIDATION — name the SINGLE existing primitive (file:line) that should have
   absorbed the others, and give a concrete plan (which surface becomes canonical,
   which become thin aliases/flags, what the unified API looks like).

Rank by how much messiness consolidating removes. Only flag REAL overlap — when two
surfaces look similar but are legitimately different (e.g. message-to-a-running-agent
vs notify-a-human), SAY SO with evidence and do not flag them. When in doubt, drop
the finding; noise erodes adoption faster than a missed finding.

Output ONE JSON array (nothing after it). Each finding:
{"rank":1,"category":"overlapping-primitives"|"non-reuse"|"consolidation",
 "severity":"blocker"|"should"|"nice","title":"<one line>",
 "surfaces":[{"cmd":"agents send","file":"apps/cli/src/commands/send.ts","line":58,"quote":"<verbatim>"}],
 "existing_primitive":"<canonical thing to reuse, file:line>",
 "evidence":"<why these overlap, citing impl file:line>",
 "consolidation_proposal":"<concrete plan>","confidence":"high"|"medium"|"low"}

Return file:line quotes for every claim. Do NOT paraphrase. If you can't quote it,
don't claim it. Empty array if you find no genuine drift.
```

For a wide window, fan the brief across surface clusters (messaging, fleet-rollup,
secrets, events, caches/resolvers) — one Sonnet subagent per cluster, in parallel —
then merge their arrays. That is how the first run was produced.

Capture each subagent's JSON array to `$RUN_DIR/findings/architecture-<cluster>.json`.

## Phase 3 — Aggregate + synthesize the ranked report

Merge the mechanical + subagent findings with the reused aggregator, then have one
synthesis subagent de-dupe overlapping claims, drop weak ones, and produce the final
ranked array (one finding per consolidation, not per file):

```bash
bun "$QDIR/aggregate.ts" "$RUN_DIR/findings" > "$RUN_DIR/aggregated.json"   # reused
```

Synthesis subagent input: `aggregated.json` + every `architecture-*.json`. It emits
the final ranked `$RUN_DIR/findings.json` in the schema `report.ts` expects (same
finding shape as the brief). Collapse duplicates that name the same consolidation;
keep the strongest evidence.

## Phase 4 — Render the report

```bash
# Optional notes.md records what the review looked at and deliberately did NOT
# flag (the false-positive discipline) — write the synthesis subagent's
# "verified distinct" list there and pass it as the third arg.
bun "$SKILL_DIR/report.ts" "$RUN_DIR/findings.json" "$RUN_DIR/meta.json" "$RUN_DIR/notes.md" \
  > "$(git rev-parse --show-toplevel)/.agents/reports/design-drift-$(date -u +%F).md"
```

`.agents/reports/` is committed — the report is durable and shareable. `report.ts`
also emits copy-pasteable `linear issue create` blocks so a run with `linear.app`
offline still produces filable tickets.

## Phase 5 — File (or draft) Linear tickets

One ticket per consolidation, tagged `design-drift` (greppable). If the bundle is
reachable, file them; else the drafted blocks in the report are the deliverable.

```bash
if agents secrets list 2>/dev/null | grep -qi '^linear.app\|linear.app'; then
  # file each finding's ticket via the linear CLI (see the report's drafted blocks)
  agents secrets exec linear.app -- linear issue create --title "design-drift: <title>" \
    --label design-drift --description "<body>"
else
  echo "linear.app bundle absent — tickets drafted in the report, not filed."
fi
```

## Phase 6 — Message the owner (the "let me know" step)

A SHORT (1–4 line) summary — how many findings, the top one named, the report path.
The owner decides per-ticket whether to dispatch a fix; **do not auto-dispatch.**

```bash
rush message send --from-agent claude --text \
  "Design-drift review: N findings across the last <window>. Top: <one-line>. Report: .agents/reports/design-drift-<date>.md + drafted tickets. Your call which to fix."
```

Only send when invoked with `--notify` (or from the routine). Skip the message on an
ad-hoc interactive run where the user is watching.

## Don'ts

- **Never edit, create, or delete source code.** This routine flags messy code; it
  must not add any. The only files it writes are the report (in `.agents/reports/`)
  and its own scratch under `.agents/artifacts/`.
- **Don't write a parallel analyzer.** Reuse `quality`'s `signatures.ts` +
  `aggregate.ts` + architecture-pass shape. New analysis code here is the smell.
- **Don't auto-fix or auto-dispatch.** Tickets + a message; the human decides.
- **Don't flag legitimately-distinct surfaces.** message-to-agent ≠ notify-a-human.
  Require evidence of real overlap; when in doubt, drop it.
- **One ticket per consolidation**, not per file.
