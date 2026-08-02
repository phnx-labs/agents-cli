# agents-cli — Specifications

> Status: **accepted** · Kind: **normative spec** · Scope: the top-level
> behavioral contracts for agents-cli's major subsystems.

This is the **source-of-truth contract** for agents-cli: what a human, an agent,
or a downstream tool is entitled to rely on, stated as testable requirements —
one section per major functionality. It exists because features have regressed by
quietly deviating from an unwritten contract (a harness parser that throws on a
malformed line; a renderer that drops the preview; a `--json` shape change that
breaks fleet fan-out; a secret that materializes into an agent's transcript).
**When code and this spec disagree, one of them is a bug** — fixing the drift is
mandatory, not optional.

This doc holds the **contracts** (the guarantees). The per-feature reference docs
— [`05-sessions.md`](05-sessions.md), [`secrets.md`](secrets.md),
[`architecture.md`](architecture.md), [`08-secrets-agent-process-model.md`](08-secrets-agent-process-model.md),
[`../../../docs/design/secrets-trust-boundaries.md`](../../../docs/design/secrets-trust-boundaries.md)
— hold the **implementation-level detail and how-to**. Read the spec for the
guarantee, the reference for the mechanism.

## Conventions of this document

- Requirement keywords **MUST / MUST NOT / SHOULD / SHOULD NOT / MAY** are used
  per [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) /
  [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174), and only when capitalized.
- **Requirement id families are section-namespaced** so an id is globally unique.
  Each family is prefixed with its section (`SES` sessions, `SEC` secrets, `EXEC`
  agent execution):
  - `<SEC>-<n>` — a normative behavioral requirement (e.g. `SES-8`, `SEC-15`, `EXEC-1`).
  - `<SEC>-IF-<n>` — an interface / output / exit-code contract.
  - `<SEC>-CROSS-<n>` — a cross-platform parity requirement.
  - `<SEC>-COMPAT-<n>` — a compatibility / stability guarantee.
  - `<SEC>-GAP-<n>` — a known implemented-vs-intended gap (informative, non-normative).
- **Every requirement has a status.** Unmarked requirements describe **Current**
  behavior (what the code does today). A requirement the code does **not yet fully
  meet** carries a trailing `Status:` line tagging it **`[Intended]`** (the contract
  is the target; the shortfall is named in a `-GAP-`) or **`[Drift]`** (a named
  deviation from another requirement in this document). Normative `MUST`/`SHOULD`
  bodies state only the contract; the shortfall lives in the `-GAP-` entry. An entry
  that exists purely to record such a deviation carries no RFC-2119 keyword.
- Every requirement cites the implementing `file:line` under `apps/cli/src/` unless
  noted, and SHOULD name the symbol/function/constant. **Line numbers drift as code
  moves — the cited symbol is the durable anchor, not the number.**
- Behavioral scenarios are written Given/When/Then so they map 1:1 to tests.
- Each section ends with **known gaps** (`-GAP-`). A new feature MUST NOT widen a
  gap and SHOULD close the one it touches.

## Contents

- [Sessions](#sessions) — `agents sessions`: discovery, parsing, preview, metadata, lifecycle, sync
- [Secrets](#secrets) — `agents secrets`: storage & materialization boundaries, sharing, no-noise
- [Agent execution](#agent-execution) — `agents run`: the one execution engine, env, isolation, fallback, dispatch
- [Watchdog](#watchdog) — `agents watchdog`: detect idle agents, decide nudge/skip, deliver to the exact split

---

## Sessions

This is the **contract** for `agents sessions`: what a human, an agent, or a
downstream tool is entitled to rely on, stated as testable requirements — not a
how-to (that is [05-sessions.md](05-sessions.md)). It exists because features
have regressed by quietly deviating from an unwritten contract (a new harness
parser that throws on a malformed line; a renderer that drops the preview; a
`--json` shape change that breaks fleet fan-out). When code and this spec
disagree, one of them is a bug; fixing the drift is mandatory.

Requirement keywords **MUST / MUST NOT / SHOULD / MAY** are used per
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Every requirement cites the
`file:line` that implements it, under `apps/cli/src/` unless noted. Behavioral
scenarios are Given/When/Then so they map 1:1 to tests.

---

### 1. Purpose & scope

`agents sessions` is the unified read layer over agent conversation transcripts:
it **discovers and parses sessions from every session-capable harness**, indexes
them, **renders a preview by default**, exposes rich per-session **metadata**
(including where a session started), and makes all of it available **locally,
across the fleet, and cross-platform**.

**In scope:** discovery + harness parsing, the SQLite/FTS index, the preview and
metadata contract, the list/active/overview display, session lifecycle
(active/idle/waiting, detach/attach/fork/migrate), and cross-machine reach
(`--host` live query, export/import bundles, R2+CRDT sync).

**Out of scope (non-goals):** writing transcripts (that is the harnesses
themselves + `packages/session-tracker`); an identity/authorization layer beyond
SSH access (§7); rendering sessions that no harness produced.

---

### 2. Terminology

- **Harness** — an agent CLI whose transcripts we parse. The session-capable set
  is `SESSION_AGENTS` (`lib/session/types.ts:14`), a **subset** of the broader
  `AGENTS` capability registry.
- **`SessionMeta`** — the durable indexed row, one per transcript
  (`lib/session/types.ts:85-192`).
- **`ActiveSession`** — the live, in-process view of a currently-running agent
  (`lib/session/active.ts:75-207`).
- **Preview** — the one-line "what this session is/was doing" string shown in a
  list row; distinct from the multi-line **picker preview** (`--preview`, the
  interactive picker).
- **Provenance** — where a live agent *process* physically runs (host / SSH /
  tmux pane), for reply-routing (`lib/session/provenance.ts`).

---

### 3. Requirements

#### 3.1 Discovery & harness parsing

- **SES-1 (MUST).** The canonical session-capable harness set is
  `SESSION_AGENTS` — exactly these 11, in display order: `claude, codex, gemini,
  antigravity, opencode, openclaw, rush, hermes, grok, kimi, droid`
  (`lib/session/types.ts:14`). Adding harness discovery MUST extend this set (and
  its parser + `dispatchAgentScan` arm), not special-case a caller.
- **SES-2 (MUST).** Each harness's transcript location + on-disk format is fixed
  and MUST be parsed from its native shape (JSONL / single-JSON / SQLite / CLI
  stdout) as tabled in [05-sessions.md](05-sessions.md#architecture) and
  `lib/session/discover.ts` / `lib/session/parse.ts`. Roots MUST include the live
  home, every version-home, and backup mirrors, deduped by realpath, **live root
  scanned first** (`lib/session/discover.ts:772-787,1092-1093`).
- **SES-3 (MUST).** A malformed JSONL **line** MUST be skipped, never thrown —
  for every harness (`lib/session/parse.ts:292-298,501-507,1120,1327-1332,1509-1513,1654-1658`).
- **SES-4 (MUST).** An unrecognized path MUST fail loudly
  (`Cannot detect agent type from path`), never be silently mis-indexed
  (`lib/session/parse.ts:143-147`); an unknown agent id in the scanner is a no-op,
  not a crash (`lib/session/discover.ts:340`). A *recognized* harness that has no
  file (OpenClaw) MAY parse to `[]` — distinct from unknown.
- **SES-5 (MUST).** Incremental re-scan of a grown transcript MUST produce an
  index row byte-identical to a full reparse: apply only newline-terminated
  lines, defer the unterminated tail. For **Claude and Codex** it MUST also
  re-derive first-event identity so an in-place rewrite at the same path forces a
  full reparse (`lib/session/discover.ts` Claude ~`:3355-3422`, Codex
  ~`:3870-3946`). **Kimi** needs no such re-check — its session dir is keyed by
  UUID and `wire.jsonl` is append-only, so a path can never change identity
  (`lib/session/discover.ts:4413-4415`); do not require it of Kimi.
- **SES-6 (MUST).** `normalizeCwd` MUST collapse `.`/`..`/dup separators and
  follow symlinks, and MUST NOT rebase a foreign absolute path onto the current
  drive on Windows (`lib/session/discover.ts:474-485,480`; test
  `discover.normalize-cwd.test.ts:52-60`). The index-time and query-time
  normalization MUST agree byte-for-byte (`discover.filter-parity.test.ts:62-135`).
- **SES-7 (MUST).** A parallel dotfile sweep MUST be bounded + staggered
  (concurrency 2, 15ms stagger) so it does not read like a ransomware bulk-enum to
  behavioral EDR (`lib/session/discover.ts:236-239,309-310`).

#### 3.2 The preview contract — **prefer to always show a preview**

- **SES-8 (MUST).** Every list-row renderer MUST show a non-empty preview cell.
  The fallback chain is: live preview (the current turn) → `label` → first-prompt
  `topic` → `'-'` (`buildSessionDescription`, `commands/sessions.ts:343-356`). A
  row MUST NOT render a blank preview cell.
  - `--active` rows satisfy this: `buildSessionDescription(s) || '-'`
    (`commands/sessions.ts:485`).
  - overview / tree rows satisfy this: `... session.topic) || '-'`
    (`commands/sessions.ts:1447`).
  - picker / `--preview <id>` satisfy this: fallback at every branch
    (`commands/sessions-picker.ts:348-350,85-100`).

  Status: `[Intended]` — two renderers do not yet meet it (`--flat` and the
  interactive picker share an unguarded `renderTopicCell`); the shortfall is
  SES-GAP-1.
- **SES-9 (MUST).** The preview MUST be deterministic and non-LLM: live rows use
  the state-engine's latest-turn string; static rows use the persisted
  first-prompt `topic`; the picker uses pure regex/heuristic digests
  (`lib/session/digest.ts:1-9`). No preview path may make a network/LLM call or
  block on async I/O.
- **SES-10 (MUST).** A preview string MUST be cleaned of terminal/harness noise
  (OSC titles, CSI/SGR, harness tags, collapsed whitespace) before display
  (`cleanPreview`, `commands/sessions.ts:329-337`), and truncated width-aware
  (never splitting a wide glyph, reserving one cell for `…`)
  (`lib/session/width.ts:61-74`).
- **SES-11 (MUST).** `topic` extraction MUST fall through noise-only leading user
  messages to the first message that yields a real topic
  (`lib/session/prompt.ts:72-86`; test `prompt.test.ts:23-28`).

#### 3.3 Metadata

- **SES-12 (MUST).** `agents sessions <id> --json` and `--json` listing MUST emit
  the `SessionMeta` shape (`lib/session/types.ts:85-192`). The field set, its
  derivation, and whether each is always populated is the table in
  [05-sessions.md](05-sessions.md#sessionmeta-list-output) — that table is
  normative for field names.
- **SES-13 (MUST).** "Where the session started" is carried by **three distinct
  axes**, and consumers MUST NOT expect a single `origin` field to hold all of it:
  - `cwd` — the filesystem launch dir, read verbatim from the transcript
    (`lib/session/discover.ts:2892`); `project` is its basename.
  - `provenance` — where the live *process* runs: `host`, `transport`
    (`local`|`ssh`), `ssh` IPs, tmux `mux` pane — read from
    `/proc/<pid>/environ` or `ps eww`, **never guessed**
    (`lib/session/provenance.ts:66-79,225-230`), attached only to rows with a
    live pid (`lib/session/active.ts:1352-1358`).
  - `context` — the launch context (`terminal`|`teams`|`cloud`|`headless`)
    (`lib/session/active.ts:76`).
  - The adjacent `SessionMeta.origin` (`cli`|`routine`,
    `lib/session/types.ts:90`) is *row provenance* (live scan vs archived routine
    run), not launch location; `isTeamOrigin` (`:170`) flags a teams-spawned
    session.
- **SES-14 (MUST).** `label` (the session name) MUST resolve by priority: agent
  title / `/rename` > `agents run --name` handle > unset (listing then falls back
  to `topic`); an empty incoming label MUST NOT clobber a stored non-empty one
  (`lib/session/db.ts:800-803,1098-1100`; test `db.names.test.ts:50-128`).
- **SES-15 (MUST).** A timestamp-less source MUST fall back to file mtime and
  MUST NOT bind NULL into the `NOT NULL` timestamp column
  (`lib/session/discover.ts:4198-4202,1238-1243`).
- **SES-16 (SHOULD).** Cross-harness durable signals (todos/checklist, PR url,
  ticket id, created tickets) SHOULD be extracted by shared agent-agnostic
  extractors so a harness earns them by emitting the right event
  (`lib/session/state.ts:164-317`).

  Status: `[Intended]` — coverage is uneven today (the live path forces
  non-Codex→Claude, and no harness populates `costUsd`); the shortfall is
  SES-GAP-2.

#### 3.4 Lifecycle

- **SES-17 (MUST).** Liveness MUST be `process.kill(pid,0)` guarded against PID
  reuse by comparing recorded start-time within a 60s tolerance; Windows falls
  back to bare existence (`lib/session/active.ts:287,327-338`; test
  `active.liveness.test.ts:35-37`).
- **SES-18 (MUST).** Session status MUST be derived honestly, and a LIVE process
  MUST NEVER resolve to `unknown`. Every tracked harness (not only Claude/Codex)
  MUST be parsed into a real `working`/`waiting_input`/`idle` when its transcript
  is locatable + parseable (`computeLiveSignals` / `findSessionFileForKind`,
  `lib/session/active.ts`); an opaque/untracked kind or an unreadable transcript
  MUST fall back to `resolveFallbackStatus`, which reports `running` for any live
  process (never a blanket `unknown`, never a fabricated `idle`)
  (`lib/session/active.ts`). A dead process MUST report `closed`; a transcript not
  written for `ABANDONED_STALE_MS` MUST report `abandoned`, whether its PID is dead
  or still alive. `unknown` is reserved for the sole un-answerable case: no PID
  signal and no file signal; modern local scanners pass a definite PID-liveness
  boolean, but `unknown` remains valid input from older remote peers. A structural
  `AskUserQuestion` / `ExitPlanMode` as last event MUST report `waiting_input` and
  MUST NOT decay with the freshness window (`lib/session/state.ts`; test
  `state.test.ts`).
- **SES-19 (MUST).** Detach/attach presence MUST be **derived, never asserted**:
  the record only says "this session was detached"; `background` vs `parked` is
  decided live from the recorded pid + start-time fingerprint
  (`lib/session/detached.ts:98-109`; test `detached.test.ts:117-137`).
- **SES-20 (MUST).** `migrate` MUST NOT kill the source before the transcript is
  on the target and its session is confirmed live
  (`commands/sessions-migrate.ts:590-593`; the invariant also stated at
  [05-sessions.md](05-sessions.md):476-477). A non-native-resumable harness MUST
  transparently fall back to rehydrate, never a silent skip
  ([05-sessions.md](05-sessions.md):471-474).
- **SES-21 (MUST).** `fork` MUST copy the transcript under a fresh UUID (git-branch
  semantics), leaving the original untouched, and MUST refuse harnesses it can't
  yet handle with a clear message (Claude-only in v1)
  (`lib/session/fork.ts:1-16,84-86`).

#### 3.5 Sync & remote

- **SES-22 (MUST).** `--host`/`--device` MUST run the peer's **own**
  `agents sessions` over hardened SSH; transcripts stay on the origin machine and
  there is no identity layer beyond SSH access (`lib/session/remote.ts:1-11`). A
  recursion guard (`AGENTS_SESSIONS_LOCAL=1`) MUST prevent re-fan-out
  (`lib/session/remote-active.ts:20`) and MUST also suppress the interactive
  browser, so a peer answering a fan-out can never open a TUI
  (`commands/sessions.ts` `isBareBrowserListing`).
  - **Streaming vs. merging.** A **non-interactive** invocation (`--json`, piped
    stdout, `--no-interactive`, a positional query, a render/filter flag,
    `--cloud`, or more than one host) MUST stream the peer's stdout back verbatim
    under a per-host banner. A **bare interactive** one-host listing instead folds
    the peer's `--json` rows into the local merged browser (`gatherRemoteList`),
    which renders and selects locally. Both keep transcripts on the origin.
- **SES-23 (MUST).** Remote fan-out MUST degrade, never throw or blank: an
  unreachable host (ssh 255) falls back to offline cache, a slow host is killed
  to `[]`, and overall `process.exitCode=1` signals partial failure
  (`lib/session/remote.ts:141-146,220-261`; `remote-list.ts:88-108`; test
  `remote.test.ts:167-181`).
  - **In the browser**, where the full-screen repaint hides the fan-out's stderr
    note and there is no exit code to read, the unreachable peers MUST be surfaced
    as data instead — `RemoteListResult.unreachable`, rendered in the browser
    header — so "that box is asleep" stays distinguishable from "that box has no
    matching sessions" (`lib/session/remote-list.ts`; `commands/sessions-browser.ts`).
  - **A host scope MUST NOT widen.** An explicit `--host`/`--device` naming only
    this machine leaves nothing remote to dial; the fan-out MUST be skipped rather
    than passing an empty list to `gatherRemoteList`, which reads `[]` as "no hosts
    given" and sweeps every online device.
- **SES-24 (MUST).** R2 sync MUST converge as a CRDT **G-Set union** of transcript
  events keyed by SHA-256 of raw line bytes — associative, commutative,
  idempotent, byte-identical across machines regardless of order
  (`lib/session/sync/crdt.ts:6-19,73-117`). Each machine MUST be the single writer
  of its own R2 prefix (`lib/session/sync/sync.ts:5-7`).
- **SES-25 (MUST).** When an encryption key is configured, sync MUST be
  zero-knowledge: each transcript body is sealed client-side with AES-256-GCM
  (fresh IV) under the shared `R2_SYNC_ENC_KEY` — separate from the R2 access
  token, never leaving the machine — so the bucket only ever holds ciphertext;
  merge identity stays over plaintext
  (`lib/session/sync/transcript-crypto.ts:13-24,83-96`). If no `R2_SYNC_ENC_KEY`
  is configured, sync MAY fall back to plaintext upload with a loud once-per-cycle
  warning (`lib/session/sync/sync.ts:94-99`); that fallback is explicitly **not**
  zero-knowledge — the SES-25 guarantee holds only in the encrypted mode.
  Fail-closed instead of the plaintext fallback is a reasonable future hardening
  (see SES-GAP-9).
- **SES-26 (MUST).** A partial fetch MUST be safe: if any copy of a session fails
  to fetch this tick, the whole session is skipped (no write, no pull-state
  stamp) and retried intact (`lib/session/sync/sync.ts:260-284,343-379`).
  Peer-controlled paths MUST be containment-checked so `../` cannot escape the
  mirror root (`lib/session/sync/agents.ts:213-221`).
- **SES-27 (MUST).** Sync/import credentials MUST come only from the `r2.backups`
  keychain bundle, never env/disk (`lib/session/sync/config.ts:3-5,59-64`).
  Cross-machine sync is an **opt-in beta, off by default**
  (`lib/session/sync/config.ts:12-15`).

#### 3.6 Index / DB

- **SES-28 (MUST).** The index MUST open with WAL + `busy_timeout=30000` so
  multiple processes read concurrently, and use the built-in sqlite binding
  (`bun:sqlite`/`node:sqlite`), never `better-sqlite3` (`getDB()` in
  `lib/session/db.ts` — `journal_mode = WAL` ~`:442`, `busy_timeout = 30000`
  ~`:450`; binding selected in `lib/sqlite.ts:23-24`).
- **SES-29 (MUST).** Schema migrations MUST run on open, land a several-versions-old
  DB on the current `SCHEMA_VERSION` (**18** at time of writing,
  `lib/session/db.ts:23` — treat the constant as the source of truth, not this number) in
  one call, MUST NOT drop existing rows, and MUST bump the stamp only after the
  migration succeeds so a mid-migration crash re-enters cleanly
  (`lib/session/db.ts` around the `getDB` migration gate; tests `db.migrate-v10.test.ts:78-93`,
  `db.migrate-v14.test.ts:98-106`). A migration that changes how a column is
  derived MUST force a full rescan.
- **SES-30 (MUST).** One malformed row's constraint failure MUST NOT roll back the
  batch and MUST NOT stamp that row's ledger entry, so it is retried next scan
  (self-healing) (`lib/session/db.ts:975-982,1035-1039`).

---

### 4. Interface contract

#### 4.1 Command surface

The command surface (bare `sessions [query]`, `tail`, `sync`, `resume`, `focus`,
`detach`, `attach`, `inject`, `export`, `import`, `migrate`/`relocate`,
`migrations`, `fork`) with flags is the reference in
[05-sessions.md](05-sessions.md); this spec governs the guarantees behind it.

#### 4.2 Machine-readable output (STABLE — agents depend on these)

- **SES-IF-1 (MUST).** `sessions --json` (listing) MUST emit a JSON **array** of
  `SessionMeta` (`serializeSessionsJson`, `commands/sessions.ts:695-701,1272`);
  `sessions <id> --json` MUST emit `{ session, events }` (a bare event array is
  the pre-1.20.51 shape — consumers read `output.events`,
  [05-sessions.md](05-sessions.md):142-147). The fleet browser itself shells peers
  with `sessions --all --json --limit 500` (`commands/sessions-browser.ts:219`),
  so the array shape is load-bearing across the fleet.
- **SES-IF-2 (MUST).** `sessions --active --json` MUST emit `ActiveSession[]` with
  `ticketId`/`project`/`prLink` always present as keys (test
  `sessions.serialize.test.ts:76-115`); `tail --json` MUST pass raw JSONL through
  one event per line (`commands/sessions-tail.ts:229-232`); `sync --json`,
  `inject --json`, `migrations --json` emit their documented shapes.
- **SES-IF-3 (MUST).** The export **bundle format** is NDJSON, `kind`
  `agents-session-bundle`, `version` 1; parse MUST reject a wrong kind/version;
  per-record `hash`/`size` are always over **plaintext** for byte-exact dedup;
  bundle files are written `0600` (`lib/session/bundle.ts:28-29,110-113,188-227`).
- **SES-IF-4 (MUST).** `SessionEvent.type` is a **closed union** of the 9 documented
  types (`lib/session/types.ts:17-41`); a parser MUST NOT introduce a tenth.

#### 4.3 stdout / stderr / exit discipline

- **SES-IF-5 (MUST).** Machine-readable output (`--json`, `--markdown`, `tail`
  stream, bundle NDJSON) goes to **stdout**; human/diagnostic/skip notes go to
  **stderr**, so piping a session is never polluted.
- **SES-IF-6 (MUST).** Exit codes are a contract: `sessions --waiting` sets exit **1**
  to signal matching (waiting-on-you) sessions exist
  (`commands/sessions.ts:905,942`); `tail` uses **2** for usage/unsupported-agent
  vs **1** for no-match (`commands/sessions-tail.ts:185,192,196`); remote
  partial-failure sets exit **1** without throwing (SES-23).

---

### 5. Cross-platform parity matrix

Discovery is rooted at `os.homedir()` on every platform. The matrix below is
normative — a change that widens/narrows a cell is a spec change.

| Behavior | macOS | Linux | Windows |
|---|---|---|---|
| Discovery & parsing (all 11 harnesses) | yes | yes | yes |
| Process table source | `ps` | `ps` | `Get-CimInstance Win32_Process` (`active.ts:793-799`) |
| PID-reuse start-time guard | yes | yes | **no** — bare existence (`active.ts:299-300`) |
| Live-process provenance | `ps eww` | `/proc/<pid>/environ` | **none** (`provenance.ts:196-217`) |
| cwd of a live process | `lsof` | `lsof`/`/proc` | pid-registry only (no `lsof`, `active.ts:856-858`) |
| Codex home relocation (SUN_LEN socket) | yes (`lib/codex-home.ts` ~`:64-70`) | n/a | n/a |
| Foreign-absolute-cwd drive rebase | n/a | n/a | **prohibited** (SES-6) |
| Remote shell for `--host` | `bash -lc` | `bash -lc` | PowerShell (`remote.ts:117-121`) |

- **SES-CROSS-1 (MUST).** All three desktop platforms MUST be supported for discovery,
  parsing, listing, and `--host`. Windows-specific gaps (no provenance, no
  start-time reuse guard) are documented deviations, not silent behavior.

---

### 6. Compatibility & stability guarantees

- **SES-COMPAT-1 (MUST).** The `--json` listing array shape and `<id> --json`
  `{ session, events }` shape MUST NOT change incompatibly without a version note;
  additive fields are allowed (SES-IF-1).
- **SES-COMPAT-2 (MUST).** `SessionEvent.type` (the 9-value union) and the export
  bundle `kind`/`version` MUST remain backward-compatible; a bundle producer that
  bumps `version` MUST keep the parser rejecting unknown versions loudly (SES-IF-3/SES-IF-4).
- **SES-COMPAT-3 (MUST).** Schema migrations MUST be forward-only and lossless
  (SES-29), and a CLI that opens a DB written by a newer CLI MUST fail safe
  rather than proceed (`lib/session/db.ts` schema gate ~`:453-461`).

  Status: `[Intended]` — no `currentVersion > SCHEMA_VERSION` guard exists yet,
  so the fail-safe half is unenforced; the shortfall is SES-GAP-8.
- **SES-COMPAT-4 (MUST).** On the streaming path, `--host` forwards every other flag
  verbatim to the peer's same-version binary; the SSH target MUST stay validated
  against `SSH_TARGET_RE` to block argv-flag smuggling
  ([05-sessions.md](05-sessions.md):277). The interactive one-host browser
  (SES-22) is the documented exception: it asks each peer a fixed
  `sessions --all --json --limit 500` (plus `--since`/`--teams`), so `--limit`,
  `--unmanaged`, and `--no-live` do not reach the peer there
  (`commands/sessions-browser.ts` `fetchRawPool`).

---

### 7. Non-goals & known gaps

**Non-goals (by design):**
- Not a transcript **writer** — sessions are produced by the harnesses +
  `packages/session-tracker`; this tool only reads/indexes/renders.
- No identity layer beyond SSH: "if you can `ssh <host>`, you own the box"
  ([05-sessions.md](05-sessions.md):277-278).

**Known gaps (implemented-vs-intended drift to fix, not to hide):**
- **SES-GAP-1.** `flatSessionRow` (`--flat`) and the picker's `formatPickerLabel`
  both feed `renderTopicCell` (~`commands/sessions.ts:1500`, `:2060` →
  `:1851`) without the `'-'` fallback the other renderers use, so a session with
  no live preview, no tag, and an empty `topic` renders a **blank** cell —
  untested. Directly contradicts "always show a preview" (SES-8).
- **SES-GAP-2.** Metadata coverage is uneven. PR/ticket extractors are agent-agnostic
  (`lib/session/state.ts` ~`:332-358`) but the live path forces non-Codex→Claude
  (`lib/session/active.ts` ~`:541-546`), so signals are effectively claude/codex
  only. And **`costUsd` is populated by no harness in the session pipeline** — it
  is an unset schema slot (`lib/session/db.ts` writes `meta.costUsd ?? null`;
  nothing sets it); real cost accounting lives in the separate budget ledger
  (`lib/budget/ledger.ts`). If per-harness metadata parity is the intended
  contract (SES-16), this is the break.
- **SES-GAP-3.** No `model` and no `repo`/git-remote field is persisted on
  `SessionMeta` — only transient `SessionEvent.model` and `gitBranch`/`worktreeSlug`
  (`lib/session/types.ts:32,105,135`). Surfacing either needs a schema addition.
- **SES-GAP-4.** `opencode` has a reserved `SYNC_AGENTS` slot but SQLite→JSONL export
  is **not implemented** (`lib/session/sync/agents.ts:130-138`) — opencode
  sessions do not sync today.
- **SES-GAP-5.** `dedupeBySession` runs only over local sources, never across the
  local↔remote seam; a session surfacing both locally and via a peer's self-report
  is not provably collapsed and is untested
  (`lib/session/active.ts:1324` vs `remote-active.ts:43-47`).
- **SES-GAP-6.** Whole-**file** JSON parse failure is inconsistent: Gemini throws
  (and `parseSession` has no outer catch), while Hermes/Antigravity degrade to
  `[]` (`lib/session/parse.ts:143-169,691-696`). Standardize on degrade-to-empty.
- **SES-GAP-7.** Doc drift (fixed in this change): [05-sessions.md](05-sessions.md)
  said schema version 13; the code is 18 (`lib/session/db.ts`, `SCHEMA_VERSION`).
  Any hardcoded schema number in prose drifts — cite the constant. The stale
  `lib/session/db.ts` header path comment (missing `.history/`) is corrected here
  too (real path `~/.agents/.history/sessions/sessions.db`).
- **SES-GAP-8.** No `currentVersion > SCHEMA_VERSION` guard exists (SES-COMPAT-3): an
  older CLI opening a DB written by a newer one silently proceeds instead of
  failing safe (`lib/session/db.ts` schema gate). The "fail safe on newer DB"
  guarantee is aspirational until a guard is added.
- **SES-GAP-9.** The zero-knowledge guarantee (SES-25) is opt-in, not enforced:
  with no `R2_SYNC_ENC_KEY` in the `r2.backups` bundle, `pushOwn` warns once per
  cycle and uploads transcript bodies in **plaintext** rather than refusing
  (`lib/session/sync/sync.ts:90-99`, comment: *"the feature predates
  encryption"*). Provisioning mints a key when one is absent
  (`lib/session/sync/provision.ts:71-77`), so the plaintext path is reachable
  mainly by a pre-encryption or hand-edited bundle — but a machine that loses its
  key downgrades from sealed to readable without failing. Fail-closed (refuse the
  upload unless a key is present, or require an explicit opt-in flag) is the
  hardening; neither branch is covered by a test today.

---

### 8. Given/When/Then scenarios

**GWT-1 — Codex transcript discovered with correct harness + metadata.**
Given a Codex JSONL at `~/.codex/sessions/**` with a `session_meta` line;
When `agents sessions` runs; Then it appears with `agent='codex'`, cwd/gitBranch
from `session_meta`, and `tokenCount` from the last cumulative snapshot priced
once (`discover.ts:3477-3526`).

**GWT-2 — Live copy beats backup mirror.**
Given the same session id in the live root and a `backups/<agent>/<ts>/` mirror;
When both change in one scan; Then the indexed `file_path` is the live path
(`discover.ts:1122-1131`; test `discover.dir-ledger.test.ts:298-321`).

**GWT-3 — Malformed line tolerated.**
Given a Claude JSONL whose 3rd line is invalid JSON; When parsed; Then line 3 is
skipped, the rest still parse, and the scan does not throw (`parse.ts:292-298`).

**GWT-4 — Streaming append, no double-count.**
Given a Codex transcript whose last record is written bytes-then-newline across
two scans; When scanned mid-write then after the newline lands; Then the record
counts exactly once (`discover.ts:3705-3744`).

**GWT-5 — Live session shows its current turn as the preview.**
Given a running Claude session mid-checklist (6 of 8 done); When its row renders;
Then the preview shows `Plan 6/8: <in-progress step>` with a `●` glyph
(`parse.ts:226-235`; `commands/sessions.ts:394`) — not the static topic. (Note:
the live-row checklist string is `Plan N/M: <item>`, not `✓N/M`.)

**GWT-6 — Idle session falls back to first-prompt topic; never blank (except the
`--flat` gap).**
Given a non-live indexed session with no live preview; When rendered via
`--active` / overview / tree; Then the cell is `topic`, or `'-'` if topic is
absent (`commands/sessions.ts:355,485,1447`); **but** via `--flat` with a
noise-only first prompt the cell is blank today — the SES-GAP-1 violation.

**GWT-7 — "Where it started" spans three axes.**
Given a live SSH-launched session with a pid; When metadata is enriched; Then
`cwd` gives the launch dir, `provenance` gives `host`/`transport:'ssh'`/`ssh` IPs
from `/proc/<pid>/environ`, and `context` gives the launch context — no single
`origin` field carries all three (`discover.ts:2892`; `provenance.ts:225-230`;
`active.ts:76,1352-1358`).

**GWT-8 — CRDT sync converges, encrypted, and never half-writes.**
Given two machines each appended distinct events to one session with
`R2_SYNC_ENC_KEY` set; When each pushes to its own prefix and both pull+merge;
Then both derive a byte-identical union (R2 stored only AES-256-GCM envelopes),
and if any copy 404s this tick the whole session is skipped and retried intact
(`crdt.ts:73-117`; `transcript-crypto.ts:83-96`; `sync.ts:260-284`).

**GWT-9 — Remote fan-out degrades, never blanks.**
Given 3 fleet hosts, one unreachable (ssh 255) and one slow past budget; When
`agents sessions --active` fans out; Then reachable hosts return, the unreachable
host replays offline cache, the slow host is killed to `[]`, and overall
`process.exitCode=1` — no throw, no empty result (`remote.ts:141-146,220-261`;
`remote-list.ts:88-108`).

**GWT-10 — Old DB auto-migrates without data loss.**
Given a v9 `sessions.db` with a `name` column and rows; When `getDB()` opens it;
Then schema reaches the current version, `name` folds into `label` then drops, and every prior row
survives searchable (`db.migrate-v10.test.ts:78-93`; `db.migrate-v14.test.ts:98-106`).

---

## Secrets

This is the **contract** for `agents secrets`: what a human, an agent, or a
downstream tool is entitled to rely on, stated as testable requirements — not a
how-to (that is [secrets.md](secrets.md)). It exists because features have
regressed by quietly deviating from an unwritten contract. When code and this
spec disagree, one of them is a bug; fixing the drift is mandatory, not optional.

Requirement keywords **MUST / MUST NOT / SHOULD / MAY** are used per
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Every requirement cites the
`file:line` that implements it, under `apps/cli/src/` unless noted. Behavioral
scenarios are written Given/When/Then so they map 1:1 to tests.

---

### 1. Purpose & scope

`agents secrets` exists to **share credentials between humans and agents safely
and without noise**: a human (or agent) stashes a secret once; any later agent
run injects it into the child process that needs it, on any of the user's
machines, without the value ever landing on disk as plaintext, in shell history,
in the agent's context window, or in the session transcript — and without a wall
of prompts or output.

**In scope:** storage backends (macOS Keychain, Linux libsecret, Windows
Credential Manager, encrypted-file fallback, age synced vault), the bundle model,
the human↔agent and agent↔agent sharing flows, the plaintext trust boundary,
prompt/noise suppression, and cross-fleet sync.

**Out of scope (non-goals):** defending a logged-in user against another binary
running as that same user (§7); being a team secret-manager with server-side
access control (that is 1Password/Vault; this tool is device-local first).

---

### 2. Terminology

- **Bundle** — a named container mapping env-var names to values or typed refs
  (`SecretsBundle`, `lib/secrets/bundles.ts:237-255`).
- **Ref kind** — how a var's value is sourced: `keychain` / `literal` / `env` /
  `file` / `exec` (`REF_PATTERN`, `lib/secrets/index.ts:51`).
- **Backend** — where values physically live: `keychain` | `file` | `vault`
  (`SecretsBackend`, `lib/secrets/bundles.ts:64`).
- **Policy** — per-bundle prompt tier: `always` | `daily` | `never`
  (`SecretsPolicy`, `lib/secrets/bundles.ts:234`; persisted under the legacy key
  `tier`).
- **Broker / secrets-agent** — the macOS-only in-memory holder that dedups Touch
  ID across processes (`lib/secrets/agent.ts`).
- **Materialize** — print a resolved plaintext value to this process's stdout
  (where an agent reader captures it into context + transcript).
- **Inject** — place a resolved value only into a child process's environment
  (invisible to the agent reader).

---

### 3. Requirements

#### 3.1 Storage boundary — plaintext never on disk

- **SEC-1 (MUST).** A secret value MUST NOT exist as on-disk plaintext in the
  primary path on any platform. macOS stores it in the data-protection Keychain
  (`lib/secrets/keychain-helper.swift:47-53`); Linux via `secret-tool`/libsecret
  (`lib/secrets/linux.ts:161-166`); Windows via Credential Manager
  `CRED_TYPE_GENERIC`/`CRED_PERSIST_LOCAL_MACHINE` (`lib/secrets/windows.ts:89-90`).
- **SEC-2 (MUST).** When no OS store is usable (headless Linux/Windows with a
  locked/absent keyring, or an opt-in `--backend file` bundle), the value MUST be
  encrypted at rest with AES-256-GCM under a scrypt-derived key, written mode
  `0600` in a `0700` directory (`lib/secrets/filestore.ts:259-260,267-270,324-328,44`).
- **SEC-3 (MUST).** `--synced` bundles MUST be sealed in a single age-encrypted
  `~/.agents/vault.age` blob (mode `0600`, scrypt work-factor 2^18) via the
  re-invoked `agents __vault-age-helper` child, never written as plaintext
  (`lib/secrets/vault.ts:49,209,349`).
- **SEC-4 (MUST).** Bundle **metadata** (names, descriptions, var list, `--value`
  literals) MUST be stored WITHOUT the biometry ACL, so enumeration is silent —
  only actual values carry the policy ACL (`lib/secrets/bundles.ts:602-613`;
  test `bundles.test.ts:476-495`). Literals are non-sensitive **by contract**;
  callers MUST NOT put a secret in a `--value` literal.
- **SEC-5 (SHOULD).** On macOS, stored keychain **service names** SHOULD be
  opaque HMAC-SHA256 hashes (`agents-cli.h.*`) so a passive enumerator learns
  only counts/grouping, never bundle/key/provider names
  (`lib/secrets/index.ts:178-217`). See SEC-CROSS-3 for the platform gap.

#### 3.2 Materialization boundary — the agent never sees plaintext unless a command says so

- **SEC-6 (MUST).** Every command MUST be on exactly one side of the
  materialization boundary **by construction** — there is no "sometimes"
  (`../../../docs/design/secrets-trust-boundaries.md:28-29`). The classification
  in §4.2 is normative.
- **SEC-7 (MUST).** The injection path MUST place resolved values only in the
  child process env, never on this process's stdout: `agents secrets exec` and
  `agents run --secrets` build the child env with `buildSecretsExecEnv` and
  `spawn(..., { stdio: 'inherit', env })` (`commands/secrets.ts:369-376,2006-2009`).
- **SEC-8 (MUST).** The master passphrase MUST be stripped from every injected
  child env: `buildSecretsExecEnv` deletes `AGENTS_SECRETS_PASSPHRASE` before
  spawn (`commands/secrets.ts:369-376`, quoted in
  `../../../docs/design/secrets-trust-boundaries.md:61-65`).
- **SEC-9 (MUST).** Materializing commands (`export --plaintext`, `view --reveal`,
  `get`) are the ONLY commands that print a plaintext value, and each MUST require
  an explicit opt-in flag or be a declared automation primitive: `export` refuses
  without `--plaintext` (`commands/secrets.ts:1921-1924`); `--reveal` in a
  non-TTY refuses without `--plaintext` (`commands/secrets.ts:1069-1072`); `get`
  is the deliberately-ungated scripting primitive (`commands/secrets.ts:1156,1172-1181`).
- **SEC-10 (MUST).** `exec:` refs MUST be gated by the bundle's `allow_exec` at
  both write and resolve time (`commands/secrets.ts:1388-1390`;
  `lib/secrets/index.ts:1398-1403`) and MUST run argv-only (`shell:false`,
  `execFileSync`) so a secret identifier can never inject a shell command
  (`lib/secrets/index.ts:1404-1405`).

#### 3.3 The "without noise" contract

- **SEC-11 (MUST).** `agents secrets list` and every internal metadata scan MUST
  complete with no Touch ID prompt and MUST print metadata only, never values
  (`commands/secrets.ts:900-903`; SEC-4).
- **SEC-12 (MUST).** Value reads MUST be batched so a bundle costs at most one
  Touch ID prompt, not one per key (`commands/secrets.ts:1073-1076`;
  `lib/secrets/bundles.ts:772-776,1262-1273`).
- **SEC-13 (MUST).** A headless/detached (no-TTY) context on macOS MUST resolve
  broker-only and fail loudly, and MUST NOT pop a Touch ID sheet on the
  interactive user's screen (`isHeadlessSecretsContext`,
  `lib/secrets/bundles.ts:1245-1260`; `commands/secrets.ts:1172-1175,1925-1929`;
  `mcp.ts:112-114`).
- **SEC-14 (MUST).** A broker `get` for a bundle it does not hold MUST return
  `{ ok:true, hit:false }` — never an error, never a prompt, never a human
  escalation — and the caller MUST fall through to the real store
  (`lib/secrets/agent.ts:356-363,840-844`; test `agent.test.ts:43-46`).
- **SEC-15 (MUST NOT).** The `lib/secrets` layer MUST NOT print a secret **value**
  to `console.*`; state changes flow through structured audit events whose
  payloads MUST NOT carry values — only bundle name + key NAMES + count. Every
  value read and every unlock grant funnels through the canonical
  `emitSecretAudit` helper (`lib/secrets/audit.ts`), which emits `secrets.get`
  (a value was read) or `secrets.unlocked` (a bundle was granted into the broker),
  value-free, tagged with the resolving agent scope
  (`lib/secrets/bundles.ts` reader sites; `commands/secrets.ts` `view --reveal` /
  raw `get` / `unlock`; `lib/secrets/sync.ts`; `lib/secrets/remote.ts`). (The lib layer is *not* fully `console`-free — a
  few operational diagnostics use `console.error` for names/paths only, e.g.
  `lib/secrets/index.ts:500,505`, `lib/secrets/vault-age-helper.ts:41`; the
  invariant is "no value on any stream," not "no console at all.")
- **SEC-16 (MUST).** The following non-actionable operations — and no others
  without a change to this spec — MUST be silent no-ops rather than errors: `lock`/`unlock` on a non-macOS host
  (exit 0, no value output), a best-effort session-store write that fails
  (resolution still succeeds), and a throttled `last_used` stamp
  (`commands/secrets.ts:2219,2282`; `lib/secrets/session-store.ts:24-25`;
  `lib/secrets/bundles.ts:938-945`). A silent no-op MUST NOT be used to swallow an
  actionable failure (a real resolution error, a missing bundle, a decrypt
  failure) — those MUST surface.
- **SEC-17 (SHOULD).** `agents doctor` SHOULD warn (name + line only, never the
  value) when a credential-shaped var is exported from a shell rc file, and point
  the user at `agents secrets exec` (`lib/secrets/rc-hygiene.ts:16-17,157-179`).

#### 3.4 Authorization model

- **SEC-18 (MUST).** Authorization MUST be **filesystem-scoped, not
  role-scoped**: there is no human-vs-agent identity branch. Broker requests
  (except liveness `ping`) MUST carry a per-broker capability token stored `0600`
  in a `0700` dir; a missing/empty token MUST reject everything but `ping`
  (`lib/secrets/agent.ts:188-195,400-416`).
- **SEC-19 (MUST).** The `never` policy MUST store items with no biometry ACL
  (fully silent reads) and MUST be gated behind explicit acknowledgment
  (`--i-understand` or an interactive confirm), because it is the
  on-disk-plaintext-equivalent downgrade (`keychain-helper.swift:557-559`;
  `commands/secrets.ts:2457-2483`). It MUST NOT be settable as a global default.
- **SEC-20 (MUST).** Destructive ops (`delete`) MUST confirm interactively and
  MUST refuse in a non-interactive shell without `--yes`
  (`commands/secrets.ts:1565-1582`).

#### 3.5 Sharing & sync

- **SEC-21 (MUST).** `agents secrets exec <bundle>@<host>` / `--host` /
  `run --secrets <bundle>@<host>` MUST resolve a peer's bundle over hardened SSH,
  inject the values ephemerally, and MUST NOT write them to this machine's
  keychain or disk (`lib/secrets/remote.ts:11,165-234`).
- **SEC-22 (MUST).** A peer's exported env is untrusted input: dangerous
  override-shaped keys (loader/interpreter vars, `GIT_*`, `*_PROXY`,
  `*_BASE_URL`) MUST be stripped, with one stderr line, before injection
  (`lib/secrets/remote.ts:29-51,214-219`).
- **SEC-23 (MUST).** `push`/`pull` MUST seal the bundle client-side with
  AES-256-GCM (PBKDF2-SHA256, 600k iterations, per-envelope random salt+IV, GCM
  tag verified) before upload; the sync backend MUST only ever see ciphertext +
  KDF params (`lib/secrets/sync.ts:37-104`; `lib/secrets/sync-backend.ts:14-15,43-52`).
- **SEC-24 (MUST).** `pull` MUST refuse to overwrite an existing local bundle
  without `--force` (`lib/secrets/sync.ts:272-278`). Sync has no merge/CRDT model:
  `push` is an unconditional overwrite of the remote copy and `updated_at` is
  stored but never consulted for conflict resolution
  (`lib/secrets/sync.ts:230-251`).
- **SEC-25 (MUST).** `import-keyring` and `migrate-acl` MUST be **dry-run by
  default** (`--commit` to write), print item names + status only (never values),
  and `migrate-acl` MUST write an AES-encrypted backup and verify read-back before
  mutating (`commands/secrets-import.ts:24-34,58-68`;
  `commands/secrets-migrate.ts:129-131,148-150,236`).

---

### 4. Interface contract

#### 4.1 Command surface

The command surface is the reference table in [secrets.md](secrets.md#command-reference)
(bundle / secret / agent / sync / utility commands). That table is normative for
flags and examples; this spec governs the **guarantees** behind them.

#### 4.2 Materialization classification (normative)

| Command | Boundary side | Evidence |
|---|---|---|
| `secrets exec <b> -- <cmd>` | **Inject** (child env) | `commands/secrets.ts:2006-2009` |
| `run --secrets <b>` | **Inject** (run child env) | `commands/exec.ts:2181` |
| `secrets export --host` (SSH push) | **Inject** (over ssh stdin) | `commands/secrets.ts:1850` |
| `secrets export --to-1password` / `--to-file` | **Neither** (to `op` argv / AES file) | `commands/secrets.ts:1905,1794` |
| `secrets mcp` (`get_secret`) | **JIT, per-request** — never `process.env`, names-only in `tools/list` | `lib/secrets/mcp.ts:83-91,173-188` |
| `secrets export --plaintext` | **Materialize** | `commands/secrets.ts:1946` |
| `secrets view --reveal` | **Materialize** | `commands/secrets.ts:1117-1126` |
| `secrets get [b] [KEY]` | **Materialize** (automation primitive, ungated) | `commands/secrets.ts:1156,1181` |
| `list` / `view` (default) / all CRUD / `unlock` / `lock` / `status` / `push` / `pull` | **Neither** (metadata/status/counts only) | e.g. `commands/secrets.ts:1115,2262` |

Rule of thumb (normative): **if `--plaintext`, `--reveal`, or `get` appears in an
agent's transcript, a key entered the agent's context there.** Injection and MCP
do not (`../../../docs/design/secrets-trust-boundaries.md:110-111`).

#### 4.3 stdout / stderr / exit discipline

- **SEC-IF-1 (MUST).** Machine-readable value output goes to **stdout** only
  (`get`, `export --plaintext`, `--format json`); human/advisory/warning output
  goes to **stderr** (dangerous-key drops, rc-hygiene notices) so a piped value
  is never polluted (`lib/secrets/remote.ts:214-219`; `rc-hygiene` advisories).
- **SEC-IF-2 (MUST).** A masked marker (`redact()` emits `'*'` × min(len,8)) MUST be
  shown wherever a value would otherwise appear but reveal was not requested
  (`commands/secrets.ts` `redact`, ~`:647-650`).
- **SEC-IF-3 (MUST).** Error strings MUST reference names/paths only, never values or
  the passphrase (`commands/secrets.ts:452,1361,1463`).

---

### 5. Cross-platform parity matrix

The backend API is uniform (`KeychainBackend`: `has/get/set/delete/list`,
`lib/secrets/index.ts:134-142`); the **guarantees** are not. This matrix is
normative — a change that widens or narrows a cell is a spec change.

| Guarantee | macOS | Linux | Windows |
|---|---|---|---|
| OS-backed store | Keychain | libsecret / `secret-tool` | Credential Manager |
| Encrypted-file fallback (AES-256-GCM) | opt-in `--backend file` | auto on locked/absent keyring | auto on locked/absent keyring |
| User-presence gate (biometry/passcode) | **yes** (`keychain-helper.swift:35-39`) | **no** (`index.ts:12`) | **no** (`index.ts:18`) |
| Single-prompt batch read | yes (`index.ts:6-8`) | n/a (no prompt) | n/a (no prompt) |
| Service-name confidentiality (HMAC hashing) | **yes** (`index.ts:178-217`) | **no** — names verbatim (`linux.ts:17,148`) | **no** — names verbatim (`windows.ts:24-26`) |
| Broker / secrets-agent (Touch ID dedup) | yes (`agent.ts`) | n/a (no-op) | n/a (no-op) |
| `never` policy = silent read | yes | yes (already silent) | yes (already silent) |
| Value-size ceiling | none | none | 2560 B → file fallback (`windows.ts:64,415-420`) |

- **SEC-CROSS-1 (MUST).** All three desktop platforms MUST be supported. Windows IS
  a first-class backend (`lib/secrets/windows.ts`, full Credential Manager
  implementation + tests) — the stale "Windows is not supported" line in
  `secrets.md` is corrected by this change.
- **SEC-CROSS-2 (SHOULD).** Off-macOS, the biometry/broker layer is a documented
  no-op; `unlock`/`lock`/`status` SHOULD degrade to friendly no-ops, not errors
  (`docs/secrets.md:563`).
- **SEC-CROSS-3 (KNOWN WEAKER GUARANTEE).** Service-name confidentiality (SEC-5)
  holds on macOS only. On Linux/Windows, item names are stored verbatim and are
  enumerable by any same-user process. This is a real asymmetry to close or
  document, not to hide.

---

### 6. Compatibility & stability guarantees

- **SEC-COMPAT-1 (MUST).** Policy MUST persist under the legacy `tier` wire key
  (`session`≡`daily`, `biometry`≡`always`, `none`≡`never`, absent≡inherit) so
  bundles stay readable across mixed CLI versions on synced machines
  (`docs/secrets.md:546`; `lib/secrets/bundles.ts:243-244,567-576`).
- **SEC-COMPAT-2 (MUST).** The `--format json` wire output of `secrets export` is the
  machine-readable contract other subsystems (remote resolve, `--secrets`) depend
  on; its shape MUST NOT change incompatibly without a version note
  (`docs/secrets.md:173`).
- **SEC-COMPAT-3 (MUST).** An older CLI that predates a capability MUST fail closed,
  not silently downgrade: a pre-`set-no-acl` helper MUST reject a `never` write
  rather than store it as an ACL'd item (`docs/secrets.md:542`); a stale install
  after re-key MUST NOT be assumed to see re-keyed items (`docs/secrets.md:497`).
- **SEC-COMPAT-4 (MUST).** Bundle name charset `^[a-z0-9][a-z0-9\-_.]{0,48}$/i` and
  key charset (with optional `.account` suffix) MUST remain accepted
  (`lib/secrets/bundles.ts:266-268,319-334`).

---

### 7. Non-goals & known gaps

**Non-goals (by design):**
- Not a defense against another process running as the same logged-in user, nor
  against a user who approves an attacker's Touch ID prompt, nor against `root`
  (`docs/secrets.md:505-510`).
- No server-side per-teammate access control — device-local first; sharing is
  SSH-scoped or client-encrypted push/pull.

**Known gaps (implemented-vs-intended drift to fix, not to paper over):**
- **SEC-GAP-1 (fixed here).** `secrets.md`'s platform line said "Windows is not
  supported" while `lib/secrets/windows.ts` implements a full backend (SEC-CROSS-1).
  This change corrects that line to "cross-platform."
- **SEC-GAP-2.** The `env:`-ref allowlist control exists (`envAllowlist` on
  `ResolveOptions`, `lib/secrets/index.ts` ~`:1392,1411`) but no command wires it
  up — `env:` refs are effectively unrestricted today. Either wire it or remove it.
- **SEC-GAP-3.** No reserved `auth` bundle exists in code, despite a design note
  describing one for setup-tokens. The only reserved concept is
  `RESERVED_ENV_NAMES` (env keys, not bundle names,
  `lib/secrets/bundles.ts:273-277`). If the convention is intended, it is
  unimplemented; until then, `auth` is an ordinary bundle name.
- **SEC-GAP-4.** The broker's per-request capability-token auth (SEC-18) is not
  reflected in `secrets.md` / `08-secrets-agent-process-model.md`, which still
  describe only the same-UID/socket-permission model.

---

### 8. Given/When/Then scenarios

**GWT-S1 — Injection never materializes.**
Given a bundle `prod` with a `keychain:STRIPE_API_KEY` ref;
When an agent runs `agents secrets exec prod -- ./deploy.sh`;
Then the value is placed only in the child env (`commands/secrets.ts:2009`), is
never written to this process's stdout, and does not appear in the agent's
tool-call output or the session `.jsonl`.

**GWT-S2 — `get` always materializes, by design.**
Given the same bundle; When an agent runs `agents secrets get prod STRIPE_API_KEY`;
Then the plaintext is written to stdout with no TTY gate
(`commands/secrets.ts:1181`) and lands in the agent's context + transcript — this
is the automation primitive, and its appearance in a transcript is the audit
signal, not a bug.

**GWT-S3 — `list` is silent and value-free.**
Given several `daily`/`always` bundles; When the human runs `agents secrets list`;
Then only names/counts print and no Touch ID fires, because metadata is written
no-ACL (`bundles.ts:602-613`; test `bundles.test.ts:476-479`).

**GWT-S4 — Repeated agent reads never re-prompt.**
Given `agents secrets unlock prod` ran once (one Touch ID) and the broker holds
`prod`; When N concurrent runs read `prod` within the TTL;
Then each read returns from broker memory over the `0600`-token-authorized socket
with no prompt (`agent.ts:1-25,412-416`).

**GWT-S5 — Silent miss, not escalation.**
Given the broker does not hold `staging`; When an agent requests `get staging`;
Then it gets `{ ok:true, hit:false }` (`agent.ts:356-363`) and falls through to
the real store — no error, no prompt.

**GWT-S6 — Master passphrase never reaches the child or an rc file.**
Given `AGENTS_SECRETS_PASSPHRASE` is set; When `agents secrets exec prod -- printenv`;
Then the child env has `prod`'s values but not the passphrase
(`commands/secrets.ts:374`), and `agents doctor` warns (name+line only) if that
var is exported from any shell rc file (`rc-hygiene.ts:157-179`).

**GWT-S7 — Cross-host resolve strips override-shaped keys, stays ephemeral.**
Given a peer holds `ci` with a benign `TOKEN` plus `LD_PRELOAD` and
`NPM_CONFIG_PROXY`; When `agents secrets exec ci@peer -- <cmd>` resolves over SSH;
Then `LD_PRELOAD`/`*_PROXY` are dropped with one stderr line
(`remote.ts:29-51,214-219`) and `TOKEN` is injected without touching the local
keychain (`remote.ts:11,165-234`).

**GWT-S8 — Sync ships ciphertext only; pull won't clobber.**
Given local `prod` and a remote copy; When `push prod` then `pull prod`;
Then push sends an AES-256-GCM/PBKDF2-600k envelope the backend can't read
(`sync.ts:66-85`), and pull refuses to overwrite the local copy without `--force`
(`sync.ts:272-278`).

**GWT-S9 — `never` policy double-warns and is never a default.**
Given a bundle; When `agents secrets policy prod never`;
Then a red warning prints that reads become fully silent and confirmation /
`--i-understand` is required (`commands/secrets.ts:2457-2483`); the global default
can never be `never` (`docs/secrets.md:544`).

**GWT-S10 — Linux/Windows fall back with no biometry (weaker by construction).**
Given a headless Linux server with a locked keyring; When `agents secrets get`
runs; Then `isLockedCollectionError` fires (`linux.ts:79-82`) and the value
round-trips through AES-256-GCM keyed by the resolved passphrase
(`filestore.ts:259-291`) — at no point a biometric/user-presence check, unlike
macOS.

---

## Agent execution

This is the **contract** for `agents run`: what a human, an agent, or a
downstream tool (`agents teams`, routines, `--host` dispatch) is entitled to
rely on when a run is dispatched, stated as testable requirements. It exists
because "one execution engine" is a real architectural claim
(`apps/cli/AGENTS.md` / repo `CLAUDE.md`, §Core concepts) that code can
silently violate — a new agent added without env isolation, a bypass path that
skips the audit funnel, a flag that stops crossing the `--host` SSH boundary.
When code and this spec disagree, one of them is a bug; fixing the drift is
mandatory, not optional.

Requirement keywords **MUST / MUST NOT / SHOULD / MAY** are used per
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Every requirement cites the
`file:line` that implements it, under `apps/cli/src/` unless noted. Behavioral
scenarios are written Given/When/Then so they map 1:1 to tests.

---

### 1. Purpose & scope

`agents run <agent> [prompt]` (`commands/exec.ts:502`) is the single funnel
every agent invocation passes through — interactive or headless, local or
`--host`-dispatched, single-shot or `--loop`, primary or a `--fallback` chain
entry. Its job: translate one `ExecOptions` into (a) an isolated child process
env and (b) the right CLI argv for whichever of the 16 registered agents is
being run, spawn it, and return one exit code.

**In scope:** env composition and merge order; per-version config isolation;
the buildExecEnv → execAgent/runWithFallback invariant and its one named
exception (`--acp`); rate-limit fallback/retry semantics; `--host` SSH
dispatch (what crosses the hop, what is refused); how `--secrets` reaches a
run's child env; POSIX/Windows spawn parity; the exit-code contract.

**Out of scope (non-goals, §7):** the secrets storage/materialization
boundary itself (see [Secrets](#secrets) — this spec only covers the call
site where a run consumes resolved secrets); a cross-agent JSON output
schema (`--json` passes through each agent's native stream format).

---

### 2. Terminology

- **`ExecOptions`** — the typed input to the engine: agent, version, prompt,
  mode, effort, cwd, env overrides, secrets, session id, etc.
  (`lib/exec.ts:167-244`).
- **Version home** — the isolated config directory for one installed agent
  version, `getVersionHomePath(agent, version)` = `<versionDir>/home`
  (`lib/versions.ts:1054-1056`).
- **Chain / fallback entry** — one `{ agent, version?, envOverride? }` in a
  `--fallback` sequence tried in order on rate-limit failure
  (`lib/exec.ts:1793-1820`).
- **Actor** — the human or agent identity credited for a run, resolved by
  `resolveActor()` and exported via `actorEnv()` (`lib/actor.ts`).
- **Launch id** — `AGENT_LAUNCH_ID`, the correlation key that joins a spawned
  pid to the exact session its SessionStart hook records, and that a
  `--host` launcher forwards across the SSH hop to resolve a remote-coined
  session id (`lib/exec.ts:331-349`).
- **Governance chokepoint** — `recordDispatchedRun`, the one audit call every
  finalized run path makes (`commands/exec.ts:1571,2470,2628,2683`).

---

### 3. Requirements

#### 3.1 Env build & merge order

- **EXEC-1 (MUST).** Every run's child env starts from
  `sanitizeProcessEnv(process.env)` — the ambient env with dynamic-loader /
  interpreter-hijack vars stripped (`LD_*`, `DYLD_*`, `NODE_OPTIONS`,
  `PYTHONPATH`, `PYTHONSTARTUP`, `BASH_ENV`, `ENV`, `PERL5OPT`, `RUBYOPT`,
  `PROMPT_COMMAND`, `IFS`, `CDPATH`) (`lib/exec.ts:358`;
  `lib/secrets/bundles.ts:292-318`).
- **EXEC-2 (MUST).** `buildExecEnv` MUST pin a per-version config-dir var for
  claude/codex/copilot/kimi ONLY (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` /
  `COPILOT_HOME` / `KIMI_CODE_HOME`) and MUST delete the other three agents'
  vars on every branch, so a config pointer from a different agent's shell
  never leaks into this invocation (`lib/exec.ts:364-437`).
- **EXEC-3 (MUST).** `buildExecEnv` MUST set `AGENTS_MAILBOX_DIR` +
  `AGENT_SESSION_ID` + `AGENTS_SESSION_ID` when a valid session id is present
  (`lib/exec.ts:444-449`), `AGENTS_RUNTIME` to `terminal`/`headless` from
  `resolveInteractive` (`lib/exec.ts:450`), `AGENTS_AGENT_NAME`
  (`lib/exec.ts:452-454`), `AGENTS_CWD` when a cwd is given
  (`lib/exec.ts:455-457`), and `AGENT_SESSION_NAME` when `--name` is given
  (`lib/exec.ts:462-464`).
- **EXEC-4 (MUST).** `buildExecEnv` MUST assign actor-provenance env
  (`AGENTS_ACTOR`, `_KIND`, and when known `_NAME`/`_EMAIL`/`_GITHUB`, plus
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` for a resolved human) from
  `actorEnv(resolveActor())` (`lib/exec.ts:470`; `lib/actor.ts:180-196`), so
  the agent's own `git commit` credits the person, not the shared account.
- **EXEC-5 (MUST).** `buildExecEnv` MUST apply `options.env` LAST, overriding
  every var set above — the single caller-override seam:
  `return { ...result, ...options.env }` (`lib/exec.ts:472-475`).
- **EXEC-6 (MUST).** At the command layer, `agents run`'s `--secrets`/`--env`
  handling MUST compose `options.env` in the fixed order **profile env <
  auto-share token < secrets bundles < `--env K=V`**, later wins
  (`commands/exec.ts:2296-2304`, comment: *"Merge order (later wins): profile
  env < auto share token < secrets bundles < --env K=V."*).
- **EXEC-7 (MUST).** "Profile env" comes from `resolveProfileEnv(profile)` —
  a static `env` block plus, when the profile declares `auth`, a Keychain
  token read live at exec time and merged in under `auth.envVar`, so the
  profile YAML itself never carries a secret (`lib/profiles.ts:380-393`).
- **EXEC-8 (MUST).** The "auto share token" (`shareRuntimeEnv`) MUST be
  best-effort: it MUST NOT throw or block an unrelated run when the share
  bundle is missing or locked (`lib/share/config.ts:117-136`, wrapped in
  `try/catch`, doc comment: *"Never throws."*).
- **EXEC-9 (MUST).** `--secrets <bundle>` resolution MUST go through
  `readAndResolveBundleEnv`, which MUST fail atomically before spawn on any
  resolution error — no partial env is ever returned to the caller
  (`lib/secrets/bundles.ts:1301,1505-1563`).
- **EXEC-10 (MUST).** `--secrets-keys` MUST restrict injection to the named
  subset and MUST throw if a requested key is absent from the bundle — never
  a silent skip (`lib/secrets/bundles.ts:979-984,1469`).
- **EXEC-11 (MUST).** An expired secret MUST abort the run unless
  `--allow-expired` is passed (`lib/secrets/bundles.ts:1006,1470`).
- **EXEC-12 (MUST).** A headless/agent-launched run MUST NOT be able to
  trigger a Touch ID prompt for a keychain-backed bundle: `agentOnly`
  (from `isHeadlessSecretsContext`, `lib/secrets/bundles.ts:1260-1286`) makes
  `readAndResolveBundleEnv` throw, naming `agents secrets unlock <bundle>`,
  instead of raising the sheet (`lib/secrets/bundles.ts:1382-1391`).

#### 3.2 Version-home isolation

- **EXEC-13 (MUST).** Every installed agent version has an isolated home
  directory: `getVersionHomePath(agent, version)` =
  `<historyDir>/versions/<agent>/<version>/home` (`lib/versions.ts:1050-1056`,
  doc comment: *"Each version has its own config isolation (like jobs
  sandbox)."*).
- **EXEC-14 (MUST, scoped).** `buildExecEnv` realizes that isolation ONLY for
  claude/codex/copilot/kimi, by pinning `CLAUDE_CONFIG_DIR` /
  `resolveCodexHome(...)` / `COPILOT_HOME` / `KIMI_CODE_HOME` at
  `<versionHome>/<configDir>` (`lib/exec.ts:373,396-398,413,427`).
- **EXEC-15 (clarifying note).** `buildExecEnv` MUST NOT set the raw `HOME`
  var for any agent — no `result.HOME = …` exists anywhere in `lib/exec.ts`.
  Isolation is realized purely through the agent-specific config-dir vars in
  EXEC-14. This is narrower than `docs/00-concepts.md:87`'s framing ("sets
  `HOME` to the matching version home before exec-ing the binary") — that
  claim describes the generated **bash shim** script's own inline exports
  (`lib/shims.ts:280-330`), a separate code path from `buildExecEnv`, and even
  there no literal `HOME=` assignment exists (verified: no `HOME="` writer in
  `lib/shims.ts` — only `AGENTS_USER_DIR`/`GROK_DOWNLOADS` etc. *read* `$HOME`).
- **EXEC-16.** The other 12 registered agents
  (gemini, cursor, opencode, openclaw, amp, kiro, goose, antigravity, grok,
  droid, hermes, forge) get **no** per-version config-dir var from
  `buildExecEnv` itself — its per-agent branch has no arm for them
  (`lib/exec.ts:364-437`, the `else` branch only deletes the four known vars).
  A separate mechanism — the generated default-name bash shim
  (`generateShimScript`, `lib/shims.ts:271-330`) and the generated
  version-pinned alias shim (`lib/shims.ts:940-1010`) — additionally exports
  `GROK_HOME` (grok, `lib/shims.ts:315,982`) and `OPENCODE_CONFIG_DIR`
  (opencode, `lib/shims.ts:322,989`) inline in bash, but only when the spawn
  target actually resolves to one of those shim scripts;
  `buildExecCommand`'s own version-resolution fallback
  (`lib/exec.ts:770-778`) can instead resolve straight to the real npm
  binary, bypassing that isolation entirely. Antigravity workflows and
  OpenCode auth are separately, explicitly documented as account-global —
  not per-version — by design (`apps/cli/AGENTS.md:150`;
  `lib/agents.ts:1410-1425`, doc comment: *"account-global (not
  per-version)"*).

  Status: `[Drift]` — a named deviation from EXEC-13's per-version isolation
  contract, scoped (with the two ways to close it) in EXEC-GAP-1.
- **EXEC-17 (MUST).** The Windows `.cmd` shim delegate
  (`execShimPassthrough`) MUST route its env through the same `buildExecEnv`
  `agents run` uses (`lib/exec.ts:1059`) — so on Windows the isolated-agent
  set is identical to, never broader than, `agents run`'s (EXEC-14).

#### 3.3 The single execution engine

- **EXEC-18 (MUST).** Every non-ACP `agents run` invocation MUST resolve to
  `buildExecCommand` (argv, `lib/exec.ts:725-983`) + `buildExecEnv` (env) +
  `spawn`, reached via `execAgent` (single-shot, `lib/exec.ts:986-989`) or
  `runWithFallback` (chain, `lib/exec.ts:1874-1969`) — the plain path
  (`commands/exec.ts:2657-2687`) and the `--loop` path
  (`commands/exec.ts:2591-2637`) both terminate in one of those two calls; a
  `--host` run re-execs `agents run` itself on the remote box (§3.5), so it
  is the same engine one hop further out, not a third path.
- **EXEC-19 (NAMED EXCEPTION).** `--acp` is the one documented bypass: it
  routes through `runAcpHeadless` (`lib/acp/run.ts`) instead of
  `buildExecEnv`/`execAgent`, calling `recordDispatchedRun` directly as its
  own finalize (`commands/exec.ts:2459-2470`, comment: *"Governance
  chokepoint (#347): the --acp path exits here, bypassing the normal
  finalize below."*).
- **EXEC-20.** The ACP child spawn passes `env: process.env` verbatim
  (`lib/acp/client.ts:65-69`) — it receives NONE of `buildExecEnv`'s
  guarantees: no `sanitizeProcessEnv` stripping, no per-version config-dir
  pin, no actor provenance, no mailbox/session wiring, no `AGENTS_RUNTIME`
  label.

  Status: `[Drift]` — EXEC-19 names `--acp` as a routing exception, but the env
  guarantees it forfeits (EXEC-1 sanitize, EXEC-3 mailbox/session + the
  `AGENTS_RUNTIME` label, EXEC-4 actor
  provenance, EXEC-14 per-version pin) are an undeclared consequence of that
  exception, not a scoped one; see EXEC-GAP-2.
- **EXEC-21 (MUST).** Every finalized run path (plain, fallback, loop, ACP)
  MUST call `recordDispatchedRun` exactly once as its audit funnel
  (`commands/exec.ts:1571,2470,2628,2683`, each commented *"Governance
  chokepoint (#347)"*).
- **EXEC-22 (MUST).** `buildExecCommand` MUST resolve the requested `Mode`
  against the target agent's declared capabilities before building flags:
  `resolveMode`/`resolveHeadlessMode` (`lib/exec.ts:103-146`) — `auto`
  degrades to `edit` when unsupported; `plan` degrades to
  `capabilities.modes[0]`, or (headless-only, e.g. kimi/grok) to `auto` with
  a stderr warning when the agent's plan mode is known to stall headless;
  `skip` on an unsupported agent throws naming the agent's real modes.
- **EXEC-22a (MUST).** When the resolved mode puts Codex in its `workspace-write`
  sandbox (`resolvedMode === 'edit'`), `buildExecCommand` MUST grant the user's
  `~/.agents` dir as an extra writable root. Codex's sandbox blocks `$HOME`, but
  the CLI tooling Codex shells out to (the SSH askpass shim at
  `~/.agents/.cache/devices/askpass.sh`, secrets, session state, config tunings)
  writes there — without it those inner writes fail with `EROFS`. Fresh runs pass
  it via `--add-dir` (deduped against user `--add-dir`s); resume forms, which
  reject `--add-dir`, pass it via `-c sandbox_workspace_write.writable_roots`
  (`lib/exec.ts`, `codexWritableRootsConfig`). `plan` (read-only) and `skip`
  (sandbox dropped) MUST NOT add it.
- **EXEC-23 (MUST).** A prompt-less run inferred as interactive at a
  non-TTY MUST be refused before spawn rather than hang on dead stdin
  (`inferredInteractiveWithoutTty`, `lib/exec.ts:270-276`; enforced
  `commands/exec.ts:2645-2655`).
- **EXEC-24 (MUST).** A slash-command prompt run headless under the
  implicit default `plan` mode MUST be refused before spawn — it would hang
  forever at `ExitPlanMode` with no TTY to approve it
  (`headlessPlanStallCommand`, `lib/exec.ts:72-85`; enforced
  `commands/exec.ts:2205-2222`).

#### 3.4 Fallback & retry

- **EXEC-25 (MUST).** `runWithFallback` MUST run the primary first with the
  original prompt, and MUST cascade to the next chain entry ONLY when
  `detectRateLimit` matches the failed attempt's stderr OR its captured
  stdout tail (`lib/exec.ts:1950-1957`); every other failure (auth failure,
  compile error, missing flag) MUST bubble up from whichever entry produced
  it, untouched — `runWithFallback` never inspects auth-failure detectors at
  all (`isAuthFailureFromLog` is not called from the cascade path).
- **EXEC-26 (MUST).** A same-host retry (identical agent+version to the
  previous chain entry — a profile `fallback_model` swap) MUST keep the
  original prompt; a genuine handoff to a different agent/version MUST
  rewrite it via `buildFallbackPrompt` — `/continue <id>` when the next
  agent is claude with a known prior session id, else an explicit
  retry-with-context note pointing at `agents sessions <id>`
  (`lib/exec.ts:1832-1936`).
- **EXEC-27 (MUST).** Workflow tool/MCP scoping (`--tools`/`--mcp-config`/
  `--strict-mcp-config`) is enforced on claude only; `runWithFallback` MUST
  warn loudly on stderr when scoping is active and the chain contains a
  non-claude agent, since a rate-limit handoff would otherwise run that
  fallback silently unscoped (`lib/exec.ts:1887-1898`).
- **EXEC-28 (SHOULD).** A non-primary (`i>0`) chain entry that fails to
  spawn with `ENOENT` MUST be skipped, not fatal, so an uninstalled fallback
  agent doesn't kill the whole chain (`lib/exec.ts:1942-1948`).
- **EXEC-29 (MUST).** The caller-supplied `dispatchSink` out-param MUST be
  updated to the agent+version actually attempted on every chain step, so
  the audit record (EXEC-21) reflects the fallback that really ran, not
  always the primary (`lib/exec.ts:1807-1819,1904`).

#### 3.5 `--host` SSH dispatch

- **EXEC-30 (MUST).** A headless `--host` run MUST re-exec
  `agents run <agent> "<prompt>" --quiet …` on the remote box over SSH,
  detached, with the remote's stdout/stderr redirected to a log file and its
  exit code written to a sidecar `.exit` file (`lib/hosts/dispatch.ts`:
  `launchDetached`/`buildDetachedLaunchCommand`); an interactive `--host`
  run streams the same style invocation live via `sshStream` instead
  (`runInteractiveOnHost`).
- **EXEC-31 (MUST).** Actor-provenance env MUST cross the SSH hop:
  `withActorEnv()` prepends `actorEnv(resolveActor())` as shell exports
  ahead of the remote invocation, so the remote process is credited to the
  ORIGINATING actor rather than re-resolved from the remote's own
  `SSH_CONNECTION` (`lib/hosts/dispatch.ts`, RUSH-2028).
- **EXEC-32 (MUST).** A flag-classification table
  (`RUN_OPTION_FORWARDING`, `lib/hosts/remote-cmd.ts:86-144`) governs every
  `agents run` flag crossing the hop: `mode`/`effort`/`model`/`env`/
  `addDir`/`name`/`resume`/`sessionId`/`timeout`/`fallback`/`balanced`/
  `strategy`/loop flags/`json`/`verbose`/`yes`/`acp`/`autoSecrets`/
  `emitSessionId` all forward; `secrets`/`secretsKeys`/`allowExpired`/
  `resumeCheckpoint` are classified `'reject'` and MUST fail loud
  pre-dispatch rather than be silently dropped (`commands/exec.ts:1170-1173`).
- **EXEC-33 (MUST NOT).** `--secrets` bundle VALUES MUST NEVER be resolved
  locally and shipped to a `--host`-dispatched run — the dispatcher refuses
  outright (`RUN_OPTION_REJECT_MESSAGES.secrets`,
  `lib/hosts/remote-cmd.ts:148-151`: *"--secrets cannot cross the SSH
  boundary — Keychain values are never sent to a host implicitly."*).
  Workflow-frontmatter auto-secrets (`autoSecrets`, classified `'forward'`)
  instead resolve from the REMOTE host's own keychain, never the
  launcher's.
- **EXEC-34 (MUST).** `--copy-creds` MUST only target a host whose SSH host
  key is pinned in the managed known_hosts store
  (`decideCopyCredsGate`/`isHostPinned`, `commands/exec.ts:278-299`), MUST
  force strict host-key checking and disable SSH connection multiplexing
  for that call (a shared control socket could bypass the strict check),
  and MUST shred the copied credentials on the remote after the run
  regardless of exit code (`wrapHostCommandWithCredentials` setup/teardown
  wrapper, `lib/hosts/credentials.ts:47-59`).
- **EXEC-35 (MUST).** A `~`/`$HOME`-anchored `--cwd` MUST be re-rooted onto
  the REMOTE user's home via an unquoted `"$HOME"` shell expansion
  evaluated on the remote side, never expanded locally (`/home/<me>` vs
  `/Users/<me>` — `lib/hosts/dispatch.ts` `remoteCdPrefix`/
  `toRemotePortable`); an explicit `--remote-cwd` is used byte-for-byte
  verbatim and is never re-rooted.
- **EXEC-36 (MUST).** `--no-follow` MUST return immediately with the local
  task record left `status: 'running'` and no known exit code, and the
  local process MUST exit 0 regardless of the eventual remote outcome
  (`commands/exec.ts:1469-1480`); a following dispatch MUST resolve the
  real remote exit code from the sidecar `.exit` file, and MUST map a
  follow-window-closed-but-still-running result to local exit 0 rather than
  a guessed outcome (`lib/hosts/dispatch.ts` `followHostTask`, `-1` sentinel;
  `commands/exec.ts:1484-1485`).
- **EXEC-37 (MUST).** The remote-coined session id (every agent except
  claude, whose id is forced up front via `--session-id`) MUST ride back to
  the launcher via a one-line stdout sentinel (`sessionIdMarkerLine`,
  `lib/hosts/session-marker.ts:21-22,32-34`) that the follower parses from
  the combined log, or — for the interactive path — a one-shot SSH lookup
  keyed on the shared `AGENT_LAUNCH_ID`; a lookup failure MUST leave the run
  unmapped rather than mismap it to the wrong session
  (`commands/exec.ts:1390-1397`, comment: *"best-effort ... leaves the run
  un-mapped rather than mis-mapped."*).

#### 3.6 Secrets injection into a run

(This subsection is the call site; the storage/materialization guarantees
themselves are normative in [§Secrets](#secrets) — SEC-6..SEC-14 govern.)

- **EXEC-38 (MUST).** `--secrets <bundle>@<host>` — a single bundle resolved
  from a PEER machine, independent of offloading the whole run via
  `--host` (§3.5) — MUST resolve over SSH via `remoteResolveEnv` and inject
  ephemerally, and MUST reject `--secrets-keys`/`--allow-expired` for a
  remote bundle ref, since those flags don't yet cross the SSH resolver
  (`commands/exec.ts:2247-2264`, `assertRemoteBundleFlagsUnsupported`).
- **EXEC-39 (MUST).** Resolved secret values MUST reach the child only
  through the env object passed to `spawn` — the same **Inject** boundary
  as SEC-7: `agents run --secrets` builds the child env and spawns with
  `stdio:'inherit'`; it never prints a resolved value to this process's own
  stdout (`commands/secrets.ts:369-376,2006-2009`; classification table
  §4.2 of [Secrets](#secrets): `run --secrets <b>` → **Inject**,
  `commands/exec.ts:2181`).

#### 3.7 Cross-platform

- **EXEC-40 (MUST).** On POSIX, `spawnAgent` MUST exec the resolved binary
  directly with `shell:false` — no shell interposition
  (`lib/exec.ts:1468-1478`, `useShell` gate).
- **EXEC-41 (MUST).** On Windows, when the target is a `.cmd` wrapper or a
  non-absolute name, `spawnAgent` MUST compose ONE fully-quoted command
  line via `composeWin32CommandLine` and pass an EMPTY args array, so Node
  never concatenates the caller-controlled args array — which carries the
  raw prompt — into the shell line unescaped: a DEP0190 +
  command-injection guard (`lib/exec.ts:1468-1478`; the same rule mirrored
  for shim dispatch by `resolveShimSpawn`, `lib/exec.ts:1001-1020`).
- **EXEC-42 (MUST).** The interactive tmux spawn-wrap MUST be POSIX-only —
  Windows always uses the bare/shell spawn path
  (`shouldWrapInTmux`, `lib/exec.ts:1135-1143`, `platform === 'win32'`
  excluded outright).
- **EXEC-43 (MUST).** A persisted tmux `SessionMeta.cmd`
  (`buildTmuxAgentCommand`) MUST redact env VALUES (`<redacted>`) while the
  live launched command keeps the real values, so a resolved secret never
  lands on disk via the informational `cmd` field
  (`lib/exec.ts:1155-1175`, RUSH-1758).

---

### 4. Interface contract

#### 4.1 Command surface

`agents run <agent> [prompt]` (`commands/exec.ts:502`) — ~50 `.option()`
declarations (`commands/exec.ts:500-627`) grouped into: mode/effort/model,
env/secrets\* (`--env`, `--secrets`, `--no-auto-secrets`, `--secrets-keys`,
`--allow-expired`), cwd/project/addDir, output (`--json`/`--quiet`/
`--verbose`), interactivity (`--headless`/`--interactive`/`--no-auth-check`),
resume (`--resume`/`--session-id`/`--name`), tmux (`--raw`/`--no-tmux`/
`--disable-tmux`), reliability (`--timeout`/`--fallback`/`--balanced`/
`--strategy`), `--acp`, budget (`--yes`), loop (`--loop`/
`--resume-checkpoint`/`--max-iterations`/`--budget`/`--until`/`--interval`),
and host/lease dispatch (`--host`/`--device`/`--remote-cwd`/`--no-follow`/
`--any`/`--copy-creds`/`--lease`/`--box`/`--keep-box`/`--reuse`/`--bare`/
`--tailscale`).

#### 4.2 Exit code contract (STABLE)

| Path | Exit code | Evidence |
|---|---|---|
| Plain run / fallback chain | the child's own exit code, verbatim | `commands/exec.ts:2687` |
| `--acp` | `runAcpHeadless`'s own exit code, verbatim | `commands/exec.ts:2473` |
| `--loop` | `loopExitCode(stoppedBy)`: `condition-met`/`max`→0, `budget`→7, `signal`→130, `stalled`/`error`→1 | `commands/exec.ts:373-387` |
| Live budget hard-cap kill (non-loop) | 7 (`BUDGET_KILL_EXIT_CODE`) | `lib/exec.ts:1571,1584` |
| `--host`, followed to completion | the remote's own exit code (read from the sidecar `.exit` file), or 1 if unknown | `commands/exec.ts:1484-1485` |
| `--host`, `--no-follow` or follow window closed | 0 locally; the remote run continues untethered | `commands/exec.ts:1469-1485` |

- **EXEC-IF-1 (MUST).** Exit code 7 MUST mean "budget-killed," never overloaded
  for any other failure — shared between the live watcher's hard-cap kill
  and a loop's budget stop, so CI/headless callers can tell it apart from an
  ordinary failure (`lib/exec.ts:1584`; `commands/exec.ts:379`, comment:
  *"mirrors BUDGET_KILL_EXIT_CODE."*).
- **EXEC-IF-2 (MUST).** Fallback/retry/handoff banners MUST print to stderr,
  never stdout, so a piped `agents run … | jq` stays parseable
  (`lib/exec.ts:1932-1937,1963`).
- **EXEC-IF-3 (SHOULD).** `--json` streams the underlying agent's own event
  format per `AGENT_COMMANDS[agent].jsonFlags` (`lib/exec.ts:511-713`) — the
  run layer does not normalize a single cross-agent JSON schema (contrast
  [Sessions](#sessions) EXEC-IF-1..4, which do normalize their own output).

---

### 5. Cross-platform parity matrix

| Guarantee | POSIX (macOS/Linux) | Windows |
|---|---|---|
| Spawn method | direct exec, no shell | shell-composed single command line (DEP0190-safe) for `.cmd`/non-absolute targets |
| Interactive tmux wrap (`%pane` addressing, re-attach) | yes | **no** — excluded outright |
| Version-home isolation via `buildExecEnv` | claude/codex/copilot/kimi | same 4 (via `execShimPassthrough` → `buildExecEnv`, EXEC-17) |
| Version-home isolation via generated shim script | +grok, +opencode (inline bash `export`) | **not replicated** — the `.cmd` delegate routes through `buildExecEnv` only |
| Command-line injection guard | not applicable (no shell) | `composeWin32CommandLine`, empty `args[]` (EXEC-41) |

---

### 6. Compatibility & stability guarantees

- **EXEC-COMPAT-1 (MUST).** `AGENT_COMMANDS[agent].modeFlags` keys MUST agree
  with `AGENTS[agent].capabilities.modes` — a test asserts this
  (`lib/exec.ts:508-510`); `buildExecCommand` throws an "Internal error" as
  defense-in-depth if they ever drift (`lib/exec.ts:804-811`).
- **EXEC-COMPAT-2 (MUST).** `AGENT_LAUNCH_ID`, once minted or adopted, MUST stay
  the stable join key threaded through `options.env` for the lifetime of one
  launch — the pid-registry / hook-session-index reconciliation depends on
  it never changing mid-launch (`lib/exec.ts:331-349,1407-1409`).
- **EXEC-COMPAT-3 (MUST).** The `full` mode spelling MUST continue to be accepted
  as a permanent silent alias for `skip` (`normalizeMode`,
  `lib/exec.ts:45-53`) — not a deprecation to remove.
- **EXEC-COMPAT-4 (MUST).** `BUDGET_KILL_EXIT_CODE` (7) MUST stay in sync with
  `loopExitCode`'s `budget` mapping (`commands/exec.ts:379`; `lib/exec.ts:1584`)
  — EXEC-IF-1 depends on the two never diverging.

---

### 7. Non-goals & known gaps

**Non-goals (by design):**
- Not a cross-agent JSON schema normalizer — `--json` passes through each
  agent's native stream format (EXEC-IF-3).
- Not the secrets storage/materialization boundary itself — that contract is
  [§Secrets](#secrets); this spec only covers the run-time call site (§3.6).

**Known gaps (implemented-vs-intended drift to fix, not to paper over):**
- **EXEC-GAP-1.** `buildExecEnv` isolates only 4 of 16 registered agents
  (EXEC-16). `docs/00-concepts.md:87` reads as if `HOME` itself were swapped
  for every shimmed launch ("sets HOME to the matching version home before
  exec-ing the binary"); no literal `HOME=` assignment exists anywhere in
  the run engine (EXEC-15), and the doc's own claim is imprecise even for
  the shim it describes. Either wire the remaining 12 agents into
  `buildExecEnv` (so `agents run` and the shim path agree) or narrow the doc.
- **EXEC-GAP-2.** `--acp` bypasses every `buildExecEnv` guarantee (EXEC-20) — no
  `sanitizeProcessEnv`, no per-version isolation, no actor provenance, no
  mailbox/session wiring. This is undocumented as an isolation exception
  anywhere outside this spec.
- **EXEC-GAP-3.** Antigravity workflows and OpenCode auth are explicitly
  account-global, not per-version (`apps/cli/AGENTS.md:150`;
  `lib/agents.ts:1410-1425`) — a deliberate, named exception to "isolated
  version home" — but `buildExecEnv`'s own doc comment only claims
  "Pins CLAUDE_CONFIG_DIR for Claude, CODEX_HOME for Codex, and
  COPILOT_HOME for GitHub Copilot" (`lib/exec.ts:352-355`), silent on Kimi
  (which it also handles) and silent on the 12 agents it doesn't.
- **EXEC-GAP-4.** A detached (`--no-follow`) `--host` run skips the local
  `recordDispatchedRun` audit funnel entirely — no call site records it
  (EXEC-21's four sites are all reachable only from a path that knows the
  exit code). The launcher exits before an outcome is known, so a
  `--no-follow` dispatch produces no local audit trail unless later
  reconciled through `agents hosts ps`/`logs`.

---

### 8. Given/When/Then scenarios

**GWT-E1 — `--env` wins the merge, `--secrets` wins over a profile.**
Given a profile that sets `MODEL=x` and a `--secrets prod` bundle that also
sets `MODEL=y`, plus `--env MODEL=z`; When `agents run claude "..." --secrets
prod --env MODEL=z` runs; Then the child sees `MODEL=z` — `--env` is applied
last in both the command-layer merge (`commands/exec.ts:2296-2304`) and
`buildExecEnv`'s own final spread (`lib/exec.ts:472-475`).

**GWT-E2 — Version-home isolation holds for claude.**
Given claude versions `2.1.90` and `2.1.196` both installed; When
`agents run claude@2.1.90 "..."` then `agents run claude@2.1.196 "..."` run
back to back; Then each sees a distinct `CLAUDE_CONFIG_DIR` pointing at its
own `<versionDir>/home/.claude` (`lib/exec.ts:373`) — no config bleed between
versions.

**GWT-E3 — The same isolation does NOT hold for grok via `agents run`.**
Given grok versions `1.0.0` and `1.1.0` both installed with no version-pinned
alias shim materialized on disk; When `agents run grok@1.0.0 "..."` runs;
Then `buildExecEnv` sets no `GROK_HOME` (its per-agent branch has no grok
arm, `lib/exec.ts:364-437`) and `buildExecCommand` resolves the spawn target
straight to the real npm binary (`lib/exec.ts:770-778`) — the run is not
version-isolated the way EXEC-2 promises for claude (EXEC-GAP-1).

**GWT-E4 — Single engine, one named exception.**
Given a plain headless run and an `--acp` run of the same agent+prompt; When
both execute; Then the plain run's child env is `buildExecEnv`'s output
(sanitized, isolated, actor-stamped) while the ACP run's child env is raw
`process.env` (`lib/acp/client.ts:68`) — the only two shapes a run's child
env can take, and the divergence is exactly the documented "Governance
chokepoint" bypass (EXEC-19, EXEC-GAP-2).

**GWT-E5 — Fallback cascades on a rate limit, never on an auth failure.**
Given `--fallback codex` and a primary claude run that exits 1 with "Invalid
authentication credentials" on stderr; When `runWithFallback` evaluates the
result; Then it returns claude's exit code directly without ever spawning
codex, because `detectRateLimit` does not match auth-failure text
(`lib/exec.ts:1950-1957,1698-1706`) — contrast a "5-hour limit" stderr, which
does cascade.

**GWT-E6 — `--host` forwards actor env, refuses `--secrets`.**
Given `agents run claude "..." --host workbox --secrets prod`; When the
command is built; Then it fails loud pre-dispatch with
`RUN_OPTION_REJECT_MESSAGES.secrets` (`lib/hosts/remote-cmd.ts:148-151`)
rather than silently resolving `prod` locally and shipping the values; a
retry without `--secrets` instead prepends `actorEnv(resolveActor())` as
shell exports ahead of the remote `agents run` invocation (EXEC-31).

**GWT-E7 — Windows spawn never lets the prompt reach a shell unescaped.**
Given a prompt containing `"; rm -rf /` and a Windows `.cmd`-wrapped agent;
When `spawnAgent` builds the child process; Then it calls
`composeWin32CommandLine(executable, args)` and passes an EMPTY `args[]` to
`child_process.spawn` (`lib/exec.ts:1468-1478`) — the prompt is embedded in
the single quoted command line, never concatenated by Node into an
already-open shell invocation.

**GWT-E8 — Budget kill and loop-budget-stop share one exit code.**
Given a `--budget 1000` run whose live stream-json usage crosses the cap
mid-run; When the watcher fires; Then `spawnAgent` sends `SIGTERM`/`SIGKILL`
and resolves exit code 7 (`lib/exec.ts:1571,1584`); given instead a `--loop
--budget 1000` run whose cumulative iteration spend crosses the same cap;
Then the driver stops with `stoppedBy: 'budget'` and `loopExitCode` maps it
to the same 7 (`commands/exec.ts:379`) — a CI caller can `if exit==7` for
"budget," regardless of which path produced it.

---

## Watchdog

The normative contract for `agents watchdog` — the routine that detects **idle** agents
and steers them to completion. The how-it-works companion is [watchdog.md](watchdog.md).
Requirement keywords **MUST / MUST NOT / SHOULD / MAY** are per RFC 2119; scenarios are
Given/When/Then so they map 1:1 to tests.

### 1. Purpose & scope

The watchdog exists to get **idle** agents moving to completion. In scope: detecting a
stalled/idle session, deciding nudge-vs-skip, and delivering a steering message to the
exact terminal split. Out of scope: sessions that explicitly stopped for the human
(`waiting_input`) — those surface in the user's feed and are the feed's responsibility,
not the watchdog's.

### 2. Requirements

#### 2.1 Trigger & lifecycle

- **WD-1 (MUST).** The always-on watchdog MUST be a daemon-fired cron routine, not a
  bespoke loop — the routine command is `agents watchdog --nudge` on
  `WATCHDOG_ROUTINE_SCHEDULE` (`lib/watchdog/routine.ts`). Each fire MUST run exactly one
  bounded tick.
- **WD-2 (MUST).** Delivery MUST occur only when `--nudge` is set; without it a tick is a
  dry run that reports "would nudge" and delivers nothing (`lib/watchdog/runner.ts`).
- **WD-3 (MUST).** `enable`/`disable` MUST be backed by the routine store (create/pause the
  job), and `status` MUST reflect the routine's real state (`commands/watchdog.ts`).

#### 2.2 Detection — idle is the target

- **WD-4 (MUST).** A candidate MUST be a session idle at least `WATCHDOG_STALL_MS` and less
  than `WATCHDOG_DORMANT_MS`, past its per-session cooldown (thresholds in
  `lib/watchdog/read.ts:19-21`; the gate `classifyTerminal` in `lib/watchdog/watchdog.ts:84`).
  Idle age is derived from the transcript's last-write time.
- **WD-5 (MUST).** A session whose inferred activity is `working` MUST NOT be nudged
  (`lib/session/state.ts`).
- **WD-6 (MUST NOT).** The watchdog MUST NOT fight the feed: a session in `waiting_input`
  (asked a question / permission prompt) is the feed's to surface; the watchdog MUST either
  leave it for the human or escalate to the brain — never blind-nudge it as if idle
  (`deterministicDecision`, `lib/watchdog/runner.ts`).
- **WD-7 (SHOULD).** When several candidates exist, the watchdog SHOULD prioritize the ones
  active most recently (a warm session is likeliest to be steerable).
- **WD-8 (MUST).** A session whose transcript cannot be located (no timestamp) MUST be
  skipped, not guessed — and transcript resolution MUST search every version home, not just
  the live `~/.claude`. Both resolvers do so via `getAgentSessionDirs`: the status/timestamp
  path (`findClaudeSessionFile`, `lib/session/active.ts:412`, which sets the row's
  last-activity time) and the tail-read path (`resolveWatchdogSessionPath`,
  `lib/watchdog/read.ts:139`). So an agent-version upgrade does not blind the watchdog.

#### 2.3 Decision — nudge vs skip

- **WD-9 (MUST).** The default per-tick decision MUST be a cheap deterministic pre-filter;
  judgment-heavy cases (parked-on-question, ambiguous stall) MUST escalate to an LLM brain
  via `agents run … --mode plan` (`makeDefaultSmartDecider`, `lib/watchdog/runner.ts`). A
  decider failure MUST resolve to a safe skip, never a blind nudge.
- **WD-10 (MUST).** The brain MUST skip (leave for the human) on: credentials/auth, an
  irreversible or outward-facing action needing sign-off (publish/release, delete prod,
  spend, external message), a genuine product/intent decision, a completed task, or an
  unreadable state (`WATCHDOG_SYSTEM_PROMPT`, `lib/watchdog/watchdog.ts`).
- **WD-11 (MUST).** A nudge message MUST carry context — restate the goal and name ONE
  concrete next step (the specific action, a forgotten tool, or the sensible default). A
  generic "use your judgment and finish" with no concrete step MUST NOT be emitted.
- **WD-12 (SHOULD).** When the blocker is resolvable by a tool the agent already has
  (`agents computer`, `agents browser`, `agents ssh <mac> "agents computer …"`), the nudge
  SHOULD name that tool rather than escalating to the human.
- **WD-13 (MAY).** A user playbook at `~/.agents/playbooks/watchdog.md` MAY be appended as
  House Rules to tune the nudge/skip line per fleet (`composePromptWithPlaybook`).

#### 2.4 Delivery

- **WD-14 (MUST).** A nudge MUST be delivered into the exact split the session lives in,
  resolved by the single canonical `resolveInjectTargetForSession`
  (`lib/terminal/resolve.ts`, precedence `tmux > iterm > vscodium > pty`) and injected by
  `injectIntoTerminal` (`lib/terminal/inject.ts`).
- **WD-15 (MUST).** `agents sessions inject` MUST resolve targets through the same
  `resolveInjectTargetForSession` as the watchdog, so the manual unblock path and the
  watchdog agree on which sessions are addressable (no duplicate weaker resolver).
- **WD-16 (MUST).** When no addressable split exists, the tick MUST fall back (mailbox or
  headless `--resume`) or refuse-and-flag — it MUST NOT silently claim delivery.
- **WD-17 (MUST).** Every decision MUST be appended to `watchdog.log` in the Factory event
  shape (`lib/watchdog/log.ts`).

#### 2.5 Per-session policy

- **WD-18 (MUST).** `agents watchdog policy <id> off|keep|handsoff` MUST be honored:
  `off` excludes the session; `handsoff` detects+flags but never delivers; `keep` is the
  default path (`readPolicySentinel`/`writePolicySentinel`, `lib/watchdog/runner.ts`).

### 3. Given/When/Then scenarios

**GWT-W1 — Idle promise-without-toolcall is nudged with a concrete step.**
Given a session idle past `WATCHDOG_STALL_MS` whose tail shows an announced action and no
following tool call; When a `--nudge` tick runs; Then the brain returns `nudge` and the
message restates the goal and names the next step (WD-11), delivered into the session's
exact split (WD-14).

**GWT-W2 — A release ask is left for the human.**
Given an idle session whose last turn asks to publish/release; When the tick runs; Then the
brain returns `skip` (WD-10) and nothing is delivered.

**GWT-W3 — A working session is never nudged.**
Given a session whose inferred activity is `working` (fresh transcript writes); When the
tick runs; Then it is not a candidate and no nudge is sent (WD-5).

**GWT-W4 — VSCodium session is addressable by both paths.**
Given a live `codium`-hosted session with a session id; When either the watchdog or
`agents sessions inject <id>` resolves a target; Then both return an addressable `vscodium`
rail via `resolveInjectTargetForSession` (WD-14, WD-15).

**GWT-W5 — Upgrade does not blind the watchdog.**
Given a running session whose transcript lives under an earlier version home while
`~/.claude` points at a newer version; When the tick classifies it; Then the transcript is
found via `getAgentSessionDirs` and the session is evaluated, not skipped as "no activity
timestamp" (WD-8).

### 4. Known gaps

- **WD-GAP-1.** The brain is not yet seeded with the full fleet-wide
  `agents sessions --active --json` snapshot as its starting context; it reads
  per-candidate tails. Planned (see [watchdog.md](watchdog.md) roadmap).
- **WD-GAP-2.** There is no distinct `done` state — a completed session is inferred as
  `idle` and skipped via completion hints rather than a first-class status. Planned.
- **WD-GAP-3.** Live status inference covers Claude/Codex; other harnesses fall to
  `unknown` and are not yet steered (`findSessionFileForKind`,
  `lib/session/active.ts`). Planned.
- **WD-GAP-4.** No default `watchdog/WORKFLOW.md` decider ships in this repo; absent
  one, the built-in `WATCHDOG_SYSTEM_PROMPT` runs.
