---
kind: visual
template: visual.v1
title: 'Test suite: what to cut, and what the cutting is really about'
summary: 'The bloat is not weak assertions — it is fragmentation. 13,945 tests, three test homes, one module with 17 test files and 11 copies of the same fixture.'
header: 'agents-cli · test-suite refactor'
footer: ''
project: agents-cli
context: 'Scan of apps/cli + apps/ext test suites, 2026-08-20'
repository: phnx-labs/agents-cli
branch: test-suite-hygiene
tracking: ''
status: draft
harness: claude
agent: claude
human: Muqsit
host: yosemite-s1
session: 8662c823
date: '2026-08-20'
facts: []
links: []
assets: []
---

## Story

You asked to delete the silly tests. I went looking for them and mostly did not find
them — and that turns out to be the useful result.

The dumb-assertion patterns are near-absent: **one** `expect(typeof x).toBe('function')`
in 12,439 tests, zero snapshots, `toBeDefined()` at 286 uses against 16,126 `toBe`. Four
independent audits covering 413 test files and roughly 5,300 individual cases came back
saying the same thing: most of this suite exercises real filesystem, subprocess, ssh and
sqlite behaviour with no mocking, and pins named regressions. That is the bar, not the
problem.

The problem is **fragmentation**. `src/lib/session/active.ts` is one module and it has
**17 test files**, of which **11 independently declare their own `mkdtempSync` temp-home
fixture**. `discover.ts` has 25. Nobody ever edits an existing test file here — each
ticket adds `active.<its-own-topic>.test.ts` — because with three competing conventions
and no shared fixture, starting a new file is cheaper than finding the right one. That is
how a suite reaches 216,863 lines and 2,789 CPU-seconds, and it is also why adding a
scenario to a core module feels expensive, which is the second half of what you asked for.

So the deletions are the small tier, and they are already landed. The real work is giving
a module one test home and one fixture, so the next scenario goes *into* an existing file.

## Data

### Scorecard

| Measure | Value | Source |
|---|---|---|
| Test files (repo) | 1,037 | `rg --files -g '*.test.ts'` |
| Test LOC / source LOC | 216,863 / 346,722 | `wc -l` |
| CLI tests / suites | 12,439 / 4,012 | vitest json reporter |
| CLI wall / CPU time | 254s / 2,789s | vitest json reporter |
| ext tests | 1,506 in 16s | `bun test` — **degraded**, see below |
| Tests finishing under 1ms | 7,194 of 12,439 (58%) | per-test durations |
| Tests over 1s | 641 (5%) | per-test durations |
| Test homes in use | 3 (845 colocated · 140 `__tests__/` · 52 `tests/`) | path census |
| Modules with tests split across two homes | 18 → 36 files, 16,278 LOC, 1,135 tests | stem match + subject check |
| `__tests__/` files whose subject lives in the parent dir | 45 of 140 | subject resolution |
| `apps/cli/tests/` files that spawn no subprocess | 29 of 52 | `rg spawnSync\|execSync` |
| `mkdtempSync` call sites in tests | 1,062 across 509 files | `rg -o` |
| Shared test-fixture modules in the whole repo | 1 (`staleness/__tests__/_fixtures.ts`) | `rg --files` |
| Failing tests on `main` | 1 (a wall-clock assertion) | baseline run |

<div class="artifact-callout-warn">
<strong>Degraded measurement.</strong> The <code>apps/ext</code> run reports 20 failures and
19 errors in this checkout, all from <code>Cannot find package 'react'</code> — the
<code>ui/settings</code> dependencies are not installed here. Its 1,506-test count is real;
its pass/fail is not, and no finding below rests on an ext run result.
</div>

### The claim the docs make, and what the tree does

`apps/cli/CLAUDE.md` states: *"Tests are `*.test.ts` next to source; integration in
`tests/`."* Two homes, cleanly split by kind. The tree has three, and the third is not
sorted by kind: **29 of the 52 files in `apps/cli/tests/` spawn no subprocess at all** —
they are ordinary unit tests sitting in the integration directory. Meanwhile 45 of the 140
`__tests__/` files test a module that lives one directory up, which the documented
convention says should be colocated. The doc is not wrong about intent; the tree drifted
away from it, and neither is load-bearing enough to win by itself.

### Where the time goes

| Test | Cost | What it asserts |
|---|---|---|
| `commands/routines.test.ts:1436` | **36.0s** — 14% of suite wall time | that `-D, --device` appears exactly once in each of ~15 subcommand `--help` outputs, each a cold `node --import tsx` boot |
| `commands/sessions.test.ts` | 243s CPU | real CLI spawns across resolve/list/status paths |
| `commands/routines.test.ts` (file) | 227s CPU | as above |
| `lib/self-heal/isolated-soak.integration.test.ts` | 70.7s (one test) | a genuine soak |

The 641 tests over 1s are not the bloat — they are the end-to-end coverage the repo's
no-mocking rule asks for. The `routines --help` loop is the one paying full subprocess
price for a commander.js registration check.

## Figure

The shape of the problem, on the module that shows it most clearly. Every number below is
a file count or LOC read off the tree today.

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="rg --files -g 'active*.test.ts' src/lib/session; wc -l; rg -c mkdtempSync">
    <svg viewBox="0 0 440 330" role="img" aria-label="Today: session/active.ts is covered by 17 test files across three naming conventions, 11 of which declare their own temp-home fixture">
      <text x="8" y="18" fill="currentColor" font-size="13" font-weight="bold">CURRENT — one module, 17 test files</text>
      <rect x="150" y="34" width="140" height="30" rx="4" stroke="currentColor" fill="none"/>
      <text x="220" y="53" fill="currentColor" font-size="12" text-anchor="middle">session/active.ts</text>
      <text x="220" y="78" fill="currentColor" font-size="10" text-anchor="middle">2,625 loc</text>

      <rect x="8" y="98" width="130" height="24" rx="3" stroke="currentColor" fill="none"/>
      <text x="73" y="114" fill="currentColor" font-size="10" text-anchor="middle">active.test.ts</text>
      <text x="73" y="136" fill="currentColor" font-size="9" text-anchor="middle">376 loc · 41 tests</text>

      <rect x="152" y="98" width="136" height="24" rx="3" stroke="currentColor" fill="none" stroke-dasharray="4 3"/>
      <text x="220" y="114" fill="currentColor" font-size="10" text-anchor="middle">__tests__/active.test.ts</text>
      <text x="220" y="136" fill="currentColor" font-size="9" text-anchor="middle">166 loc · 13 tests</text>

      <rect x="302" y="98" width="130" height="24" rx="3" stroke="currentColor" fill="none" stroke-dasharray="1 3"/>
      <text x="367" y="114" fill="currentColor" font-size="10" text-anchor="middle">active.&lt;topic&gt;.test.ts</text>
      <text x="367" y="136" fill="currentColor" font-size="9" text-anchor="middle">15 files · 1,791 loc</text>

      <path d="M180 64 L 90 96" stroke="currentColor" fill="none"/>
      <path d="M220 64 L 220 96" stroke="currentColor" fill="none"/>
      <path d="M262 64 L 350 96" stroke="currentColor" fill="none"/>

      <text x="8" y="170" fill="currentColor" font-size="11" font-weight="bold">3 naming conventions, no rule picks one</text>
      <rect x="8" y="182" width="424" height="52" rx="4" stroke="currentColor" fill="none"/>
      <text x="20" y="202" fill="currentColor" font-size="10">11 of the 17 declare their OWN mkdtempSync temp-home fixture.</text>
      <text x="20" y="220" fill="currentColor" font-size="10">Repo-wide: 1,062 mkdtempSync sites / 509 files / 1 shared fixture module.</text>

      <text x="8" y="260" fill="currentColor" font-size="11">Adding a scenario costs: read 17 files to find the home,</text>
      <text x="8" y="276" fill="currentColor" font-size="11">or write file #18 with a 12th copy of the fixture.</text>
      <text x="8" y="300" fill="currentColor" font-size="11" font-weight="bold">Total: 2,333 test loc · 160 tests</text>
      <text x="8" y="318" fill="currentColor" font-size="9">(topic names are ticket subjects: registry-retention, live-session-id, tmux-identity, …)</text>
    </svg>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="derived: one home per module + one shared fixture; scenario files kept, fixture bodies removed">
    <svg viewBox="0 0 440 330" role="img" aria-label="Proposed: one colocated home per module plus a shared session fixture, so scenario files carry only scenarios">
      <text x="8" y="18" fill="currentColor" font-size="13" font-weight="bold">PROPOSED — one home, one fixture</text>
      <rect x="150" y="34" width="140" height="30" rx="4" stroke="currentColor" fill="none"/>
      <text x="220" y="53" fill="currentColor" font-size="12" text-anchor="middle">session/active.ts</text>
      <text x="220" y="78" fill="currentColor" font-size="10" text-anchor="middle">2,625 loc — unchanged</text>

      <rect x="80" y="98" width="128" height="24" rx="3" stroke="currentColor" fill="none"/>
      <text x="144" y="114" fill="currentColor" font-size="10" text-anchor="middle">active.test.ts</text>
      <text x="144" y="136" fill="currentColor" font-size="9" text-anchor="middle">core behaviour</text>

      <rect x="232" y="98" width="128" height="24" rx="3" stroke="currentColor" fill="none" stroke-dasharray="1 3"/>
      <text x="296" y="114" fill="currentColor" font-size="10" text-anchor="middle">active.&lt;topic&gt;.test.ts</text>
      <text x="296" y="136" fill="currentColor" font-size="9" text-anchor="middle">scenario clusters</text>

      <path d="M196 64 L 150 96" stroke="currentColor" fill="none"/>
      <path d="M250 64 L 290 96" stroke="currentColor" fill="none"/>

      <text x="8" y="170" fill="currentColor" font-size="11" font-weight="bold">__tests__/active.test.ts — merged away, file removed</text>

      <rect x="8" y="182" width="424" height="52" rx="4" stroke="currentColor" fill="none"/>
      <text x="20" y="202" fill="currentColor" font-size="10" font-weight="bold">NEW: session/testing/fixture.ts — one tmpHome() helper</text>
      <text x="20" y="220" fill="currentColor" font-size="10">every scenario file imports it; 11 hand-rolled copies deleted</text>
      <path d="M144 180 L 144 124" stroke="currentColor" fill="none" stroke-dasharray="3 3"/>
      <path d="M296 180 L 296 124" stroke="currentColor" fill="none" stroke-dasharray="3 3"/>

      <text x="8" y="260" fill="currentColor" font-size="11">Adding a scenario costs: open the topic file that already</text>
      <text x="8" y="276" fill="currentColor" font-size="11">covers it, import the fixture, write the assertion.</text>
      <text x="8" y="300" fill="currentColor" font-size="11" font-weight="bold">Same 160 tests. Fewer files, no duplicated setup.</text>
      <text x="8" y="318" fill="currentColor" font-size="9">Coverage preserved by construction — this move deletes fixtures, not cases.</text>
    </svg>
  </div>
</div>

<div class="artifact-callout">
<strong>Scale:</strong> the figure shows 1 of the 18 split-home modules.
<code>active.ts</code> was picked because it is the worst case (17 files); the median split
module has 2.
</div>

### The moves, ranked

<div class="artifact-grid artifact-grid-3">
<div class="artifact-panel">
<strong>1 · One test home per module</strong><br/>
Merge the 18 split pairs into the colocated file; move the 29 non-spawning files out of
<code>tests/</code>; retire <code>__tests__/</code> where the subject is one dir up (45 of
140). Then correct <code>apps/cli/CLAUDE.md</code> to describe what is actually true.<br/>
<em>Pure file moves — no test bodies change.</em>
</div>
<div class="artifact-panel">
<strong>2 · Extract the test fixture layer</strong><br/>
One <code>tmpHome()</code> / session-fixture helper per subsystem, replacing 1,062
hand-rolled <code>mkdtempSync</code> sites. This is the move that makes adding a scenario
cheaper than adding a file — the actual cause of the growth.<br/>
<em>Highest payoff, largest blast radius.</em>
</div>
<div class="artifact-panel">
<strong>3 · Collapse the ticket-shaped scenario files</strong><br/>
<code>active.ts</code> 17 files → about 4, <code>discover.ts</code> 25 → about 5, grouped
by behaviour rather than by the ticket that prompted them. Depends on move 2 landing
first, or every merge re-conflicts on fixtures.
</div>
</div>

### Landed already — reversible tier, no gate, each one verified

| Change | Evidence it was needed |
|---|---|
| `teams/agents.meta-corruption.test.ts` rewritten | wrote a decoy file `saveMeta()` never touches, then asserted `meta.json` unchanged — a bare `writeFileSync` passed it. **Mutation-proven**: the rewrite fails against a non-atomic `saveMeta`, the original did not. |
| `version.test.ts` — 2 tests to 1 | `'getCliVersionFresh is not the memoized cache'` asserted `a === b` from two identical calls; a fresh-read that returned the cache passed. |
| `shims.test.ts` renamed and tightened | named for a `.gemini/antigravity-cli` path the generated script does not contain; asserted something else entirely. |
| `resource-patterns.test.ts` | `const result = …` assigned, never asserted — the invalid-token branch had zero coverage. |
| 5 data-mirror tests deleted | grok and spark model ids and `authOptional` pinned as literals from the line above them; `unmanaged-installs.test.ts` fully subsumed by `agents.test.ts:402-405`, which asserts the derivation rule instead. |
| `ssh.test.ts` de-flaked | 50ms slack around a 50ms timer; **the only failing test on `main`** (104ms against a 100ms ceiling). |

Deliberately **not** deleted, though they match the ceremony shape: the `SSH_OPTS`
hardening pins and `SHIM_SCHEMA_VERSION`. A dropped `BatchMode=yes` hangs every headless
ssh — that is an invariant a human would weaken silently, which is exactly when a literal
pin earns its place.

### Found, not fixed — filed rather than folded in

<div class="artifact-callout-danger">
These are production defects, not test cleanup. A refactor PR that also fixed them would
be unreviewable.
</div>

- **`atomicWriteJson` is implemented four times** — `feed/feed.ts:193`,
  `devices/registry.ts:213`, `teams/registry.ts:59`, `teams/agents.ts:385`. The fourth
  carries a comment acknowledging it mirrors the third.
- **9 tests in `agents.test.ts` silently require a prior `bun run build`** — they spawn
  `node -e` against `dist/lib/agents.js` and fail with a raw `ERR_MODULE_NOT_FOUND` in a
  fresh checkout, with nothing saying so.
- **Untested safety-critical paths**, each named by an audit with the function and line:
  `devices/registry.ts:writeReachability` (stale-write race, never called by any test),
  `devices/sync.ts:runDeviceSync` (soft-mode error path named in its own docblock),
  EACCES/EPERM anywhere in the encrypted secrets file store, and `withRegistryLock`'s
  stale-lock reclaim.
