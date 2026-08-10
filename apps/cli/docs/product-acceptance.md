# Product acceptance (user stories for agent orchestration)

How to prevent **product regressions** when agents write the code and humans only
orchestrate. This is not OpenSpec/Spec Kit marketing — it is the missing layer in
**this** stack’s loop: HTML plans + technical design + unit tests.

Related: [Specifications](specifications.md) (normative subsystem contracts) ·
[Landscape](landscape.md) · plan-render skill (HTML plans)

**Browser-friendly examples:** [product-acceptance-user-stories.html](../../../.agents/artifacts/2026-08-04/product-acceptance-user-stories.html)
(bad vs good stories, three full Product cards, regression pack).

---

## How we develop today

```
intent (chat / ticket)
  → HTML implementation plan  (.agents/artifacts/<yyyy-mm-dd>/plan-*.html)
  → optional mock / technical design
  → agent implements (run / teams / worktree + PR)
  → unit/integration tests + CI
  → review → merge
  → F3: run the real user-visible path (often incomplete)
```

Typical plan sections (from real plans in this repo):

| Section | What it optimizes for |
|---|---|
| Why / gap | problem framing |
| Design thesis / API | **how** it works |
| Integration / files | what to edit |
| Verification | checks for the **new** surface |

Plans are strong **implementation design** docs. They are weak as **product
behavior contracts**.

`specifications.md` exists for Sessions / Secrets / Agent execution / Watchdog
precisely because features **regressed by quietly leaving unwritten contracts**.
That is the same failure mode, already named for core subsystems.

---

## Why product regressions happen

When humans stop reading every line of code, **whatever is not written and checked
is free to break**. Agents carefully implement the plan’s *new path*. They do not
automatically protect journeys never listed as acceptance.

| Failure mode | What goes wrong |
|---|---|
| Plan ≠ product contract | Plan says *how*; regression is *what must stay true* |
| Verification is “new only” | §Verification rarely lists must-not-break journeys |
| Unit green ≠ user outcome | Tests assert internals matching the plan, not the operator journey |
| Parallel agents | Shared flags/JSON/defaults drift without a behavior ledger |
| Approval is visual/technical | HTML plan + mock train “looks right,” not “still works for users” |
| Specs only on some cores | New surfaces ship without MUST/GWT; next PR regains silence |

```
  WHAT WE HAVE                          GAP
  HTML plan (how)                       Product acceptance (what)
  Technical design / files              User stories + Given/When/Then
  Unit tests on new code                Must-not-break journey list
  CI green                              F3 product walk with quoted output
                    │
                    ▼
           PRODUCT REGRESSION
      (old behavior broken, new path green)
```

---

## Vocabulary (this stack)

| Artifact | Answers | You are… | Stops regressions? |
|---|---|---|---|
| HTML plan | How we will build it | Planning | Weak alone |
| Mock / prototype | What it might look/feel like | Prototyping | No until frozen |
| Technical design | Mechanisms, files, APIs | Designing | Weak alone |
| **Product card** (stories + GWT) | Who needs what outcome | **Product-speccing** | Strong if tested |
| Normative contract (`specifications.md`) | MUST over time | Spec-anchoring | Strongest |
| Unit test | Code path correct | Verifying implementation | Medium |
| Product walk / F3 | Live surface still works | Verifying outcome | Strong |

### Plan → mockups → “figure out behavior”

| You ask the agent for… | Classification |
|---|---|
| A plan only | Planning |
| Mockups / HTML protos | Prototyping / design exploration |
| Behavior *in chat only* | Exploration — **not yet** a contract |
| Behavior as **accepted** Given/When/Then + must-not-break | **Product-speccing** |

You are **speccing** only when correct user outcomes are **durable and checkable** —
not when the plan looks smart or the mock looks good.

---

## The Product card (required for user-visible work)

Every change that touches a user-visible surface carries a short **Product card**
before implementation detail. Keep it short: 1 page, not a PRD.

### Template

```markdown
## Product acceptance

### Stories
**P1 — <title>**
As a <role>, I want <capability>, so that <outcome>.

Independent test: <one concrete action that proves the story alone>.

### Acceptance scenarios
1. **Given** … **When** … **Then** …
2. **Given** … **When** … **Then** …
3. **Given** … **When** … **Then** …

### Must not break
- <adjacent surface or flag>
- <stable --json field / exit code / default>

### Proof commands (F3)
```bash
# quote real output in the PR
agents <cmd> …
```

### Tests
- <file or case name that maps to each P1 scenario>
```

### Quality bar

| Bad | Good |
|---|---|
| “As a user I want better sessions so I can be productive.” | Role + specific command/UI + observable outcome + independent test |
| Scenarios that restate the implementation | Scenarios a second agent could implement without re-asking you |
| No must-not-break | Explicit adjacent surfaces (JSON, flags, AGI EXT, menubar) |
| “tests pass” as proof | Named proof command whose **output** is quoted |

---

## Examples (agents-cli shaped)

### 1. Sessions host column

**P1 — See where live agents run**  
As an operator on a busy laptop, I want `agents sessions --active` to show which
host each live agent is on, so I know where to attach without guessing.

**Independent test:** Two live agents (local + remote); one command shows distinct hosts.

1. **Given** a live Claude on zion and a live Codex on mac-mini  
   **When** I run `agents sessions --active`  
   **Then** each row shows the correct host (not blank / not wrong host).

2. **Given** no live agents  
   **When** I run `agents sessions --active`  
   **Then** exit 0 and empty state (not an error).

3. **Given** the same live set  
   **When** I run `agents sessions --active --json`  
   **Then** each object includes a stable `host` field Fleet can parse.

**Must not break:** preview one-liner; empty vs error exit codes; JSON field renames without COMPAT.

**Proof:** `agents sessions --active` and `agents sessions --active --json` (quote output).

---

### 2. Login preflight on run

**P1 — Warn before burning a dead session**  
As an operator, I want a clear “logged out” warning *before* a headless run waits
on a 401, so I do not waste minutes.

1. **Given** Claude is not authenticated on this version home  
   **When** I `agents run claude "hi"`  
   **Then** I see a warn naming the agent and how to log in (policy: warn+continue or hard-stop — stated).

2. **Given** the account is healthy  
   **When** I run the same command  
   **Then** no false logged-out warning.

**Must not break:** `agents doctor`, `agents view`, and menubar use the **same** probe.

**Proof:** run with a deliberately logged-out home; run with a healthy home.

---

### 3. Teams parallel ship

**P1 — Parallel tracks do not thrash main**  
As an operator, I want each teammate in its own worktree with clear Owns, so
parallel implement does not corrupt a shared checkout.

1. **Given** a team with two edit-mode teammates and `--enable-worktrees`  
   **When** both start  
   **Then** each writes only under its worktree path; main checkout stays clean.

2. **Given** teammate A’s Owns is `src/auth/*`  
   **When** A is briefed  
   **Then** the brief forbids `src/ui/*` (Must NOT touch).

**Must not break:** single-agent `agents run` still works without teams; default branch remains untouched.

**Proof:** `git -C <main> status --short` empty of teammate edits; worktree paths present.

---

## Where the Product card lives

| Moment | Where |
|---|---|
| Planning | HTML plan section **Product acceptance** (before files table) — required by plan-render for user-visible work |
| Implementation | Scenarios map 1:1 to tests or a scripted e2e |
| PR | Product card + **quoted** proof-command output |
| Stabilized surface | Promote repeated must-not-break items into [specifications.md](specifications.md) |

### What this is not

- Not a full OpenSpec/BMAD install for every PR  
- Not a ban on HTML technical plans — plans stay; acceptance is the **peer**  
- Not “write a novel PRD” — 1–3 stories, 3–7 scenarios, short must-not-break  

---

## Relationship to `specifications.md`

| Product card | `specifications.md` |
|---|---|
| Per change / feature | Per major subsystem over time |
| Approved before implement | Living contract after ship |
| Feeds F3 proof commands | SES/SEC/EXEC MUST + GWT + file:line |
| Disposable after merge *if* behavior is fully absorbed into subsystem specs | Durable |

When the same must-not-break line appears on three PRs, **promote it** into the
subsystem spec. That is how sessions/secrets stopped silently drifting.

---

## Checklist for agents (copy into briefs)

For any user-visible change:

- [ ] Product card written (stories + GWT + must-not-break + proof commands)
- [ ] Human approved the card (or plan section) before large implement
- [ ] At least one test or e2e per P1 scenario
- [ ] PR quotes real proof-command output
- [ ] Docs/CHANGELOG if the surface is user-visible (existing repo rule)

If you only have a plan and green unit tests, you have **not** closed the product
regression hole — you have closed the *implementation* hole.
