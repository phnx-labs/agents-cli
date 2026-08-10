---
kind: plan
title: "Browser and computer-use sessions become first-class rows in the session DB"
surface: cli
---

## Focus for review

- **The store.** Browser + computer-use sessions become rows in each device's local `sessions.db`, alongside agent sessions — not sidecar files, not the 7-day event ledger.
- **Metadata only.** We persist what a row needs to be listed and linked. We do **not** copy screenshots into the DB.
- **Captures.** Screenshots/PDFs/recordings stay on disk; the durable pointer is a row. Optional offload rides the **existing** `r2.backups` sync used for transcripts — not a new bucket, and not the public `agents share` path.
- **Retention.** A tool-session row outlives its task, its daemon, and the event ledger's 7-day prune. Confirm that is what you want for both.
- **Scope.** Two subsystems in one change (browser + computer). Confirm you want them landed together rather than browser first.

## Purpose

> "We should not delete the identity the moment the task stops. If anything, we should store the browser sessions also in the session DB. Each device has a local session db… as well as we should store the computer-use sessions as well."
>
> "We don't need to store all the screenshots and everything. If anything, screenshots should go like into R2 maybe. We can show the metadata of the browser just like we store the session's metadata."

`agents sessions --browser` shows every row as `unlinked` (RUSH-2549). That is the symptom; the cause is that browser task identity lives in ephemeral daemon state and is deleted the moment the task stops. Rather than patch that store, move both tool-session histories into the store that already solves durability, identity, and cross-device sync for agent sessions.

## Proposed Changes

### What happens when X

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="mockup">
<strong>Today — every row unlinked</strong>
<pre><code>$ agents sessions --browser
swift-phoenix-aurora-1988941e  comet-local@endpoint-0   1 min ago   shots 3   unlinked
lucky-phoenix-raven-8ff51d0d   comet-local@endpoint-0   1 hour ago  shots 6   unlinked
golden-aurora-cedar-b38c6005   default@endpoint-0       2 hours ago shots 4   unlinked
keen-otter-dragon-bbe8f638     comet-local@endpoint-0   2 days ago  shots 6   unlinked

Unlinked — no owning agent session is known for this task
(last known owner: UNRESOLVED@zion).</code></pre>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
<strong>After — the driving agent session, durably</strong>
<pre><code>$ agents sessions --browser
swift-phoenix-aurora-1988941e  comet-local@endpoint-0   1 min ago   shots 3   claude d34becfb  rush-2549 diagnosis
lucky-phoenix-raven-8ff51d0d   comet-local@endpoint-0   1 hour ago  shots 6   claude 95ed19d1  linkedin scout
golden-aurora-cedar-b38c6005   default@endpoint-0       2 hours ago shots 4   codex  e0fc509d  docs shots
keen-otter-dragon-bbe8f638     comet-local@endpoint-0   2 days ago  shots 6   —      (pre-migration)

Linked via sessions.db · captures on disk, 4 files · session still resolvable
after the task stopped and the daemon restarted.</code></pre>
  </div>
</div>

| When you… | Today | After |
|---|---|---|
| Run `agents sessions --browser` after a task stopped | Every row reads `unlinked` | Each row names the agent session that drove it, forever |
| Run `agents sessions --computer` 8 days later | The run is gone — the ledger pruned it at 7 days | Still listed; its metadata outlived the ledger |
| Restart the browser daemon mid-task | Identity for every live task is wiped | Identity was persisted at task start; unaffected |
| Ask "what did this agent session do?" | A `used_browser` boolean | Its browser tasks and computer runs, listed by name |
| Look for a screenshot | On disk under `.cache/browser/<profile>/sessions/<task>/` | Unchanged on disk; the row records count + path, never the bytes |

### Current architecture

Three stores exist today, and only one is durable.

<figure>
<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three current stores: tasks.json deleted on stop, events.jsonl pruned at 7 days, sessions.db durable but used only by agent sessions">
  <defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#6b7280"/></marker></defs>
  <g font-family="ui-sans-serif, system-ui">
  <rect x="20" y="30" width="210" height="76" rx="6" fill="#14161a" stroke="#2c313a" stroke-width="1.5"/>
  <text x="34" y="56" fill="#e6e8eb" font-size="13">agents browser start</text>
  <text x="34" y="76" fill="#9aa4b2" font-size="11" font-family="ui-monospace, monospace">AGENT_LAUNCH_ID</text>
  <text x="34" y="94" fill="#f87171" font-size="11">present on 2 of 5 agents</text>

  <rect x="20" y="150" width="210" height="76" rx="6" fill="#14161a" stroke="#2c313a" stroke-width="1.5"/>
  <text x="34" y="176" fill="#e6e8eb" font-size="13">agents computer &lt;verb&gt;</text>
  <text x="34" y="196" fill="#9aa4b2" font-size="11" font-family="ui-monospace, monospace">AGENT_SESSION_ID</text>
  <text x="34" y="214" fill="#a3e635" font-size="11">present on 5 of 5 agents</text>

  <rect x="300" y="30" width="180" height="76" rx="6" fill="#14161a" stroke="#2c313a" stroke-width="1.5"/>
  <text x="314" y="56" fill="#e6e8eb" font-size="13">tasks.json</text>
  <text x="314" y="76" fill="#9aa4b2" font-size="11">daemon live-state map</text>
  <text x="314" y="94" fill="#f87171" font-size="11">deleted on stop</text>

  <rect x="300" y="150" width="180" height="76" rx="6" fill="#14161a" stroke="#2c313a" stroke-width="1.5"/>
  <text x="314" y="176" fill="#e6e8eb" font-size="13">events.jsonl</text>
  <text x="314" y="196" fill="#9aa4b2" font-size="11">durable audit ledger</text>
  <text x="314" y="214" fill="#f87171" font-size="11">pruned at 7 days</text>

  <rect x="556" y="90" width="184" height="76" rx="6" fill="#14161a" stroke="#2c313a" stroke-width="1.5"/>
  <text x="570" y="116" fill="#e6e8eb" font-size="13">sessions.db</text>
  <text x="570" y="136" fill="#9aa4b2" font-size="11">per-device, synced</text>
  <text x="570" y="154" fill="#a3e635" font-size="11">durable</text>

  <path d="M230 68 L296 68" stroke="#6b7280" stroke-width="1.5" fill="none" marker-end="url(#ar)"/>
  <path d="M230 188 L296 188" stroke="#6b7280" stroke-width="1.5" fill="none" marker-end="url(#ar)"/>
  <path d="M480 128 L552 128" stroke="#6b7280" stroke-width="1.5" fill="none" stroke-dasharray="4 4" marker-end="url(#ar)"/>
  <text x="484" y="120" fill="#9aa4b2" font-size="11">agent sessions only</text>
  </g>
</svg>
</figure>

- `saveTaskState` (`lib/browser/service.ts`) writes `Object.fromEntries(tasks)` — the live in-memory map. Stop removes the entry, so the next write drops it.
- `emitComputerAction` → `stampProvenance` (`lib/event-provenance.ts:56`) already reads `AGENT_SESSION_ID || AGENTS_SESSION_ID`. Computer-use gets identity right; it just writes to a ledger that prunes (`events.ts:95`, 7 days / 50 MiB).
- `sessions.db` already carries `used_browser` / `used_computer` booleans (`db.ts:117`) — the intent existed, only the linkage was missing.

### Proposed architecture

<figure>
<svg viewBox="0 0 760 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Proposed: browser and computer both write durable metadata rows into sessions.db; captures stay on disk with optional R2 offload">
  <defs><marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#a3e635"/></marker></defs>
  <g font-family="ui-sans-serif, system-ui">
  <rect x="20" y="30" width="200" height="60" rx="6" fill="#14161a" stroke="#2c313a" stroke-width="1.5"/>
  <text x="34" y="56" fill="#e6e8eb" font-size="13">agents browser start</text>
  <text x="34" y="76" fill="#a3e635" font-size="11">+ AGENT_SESSION_ID</text>

  <rect x="20" y="150" width="200" height="60" rx="6" fill="#14161a" stroke="#2c313a" stroke-width="1.5"/>
  <text x="34" y="176" fill="#e6e8eb" font-size="13">agents computer &lt;verb&gt;</text>
  <text x="34" y="196" fill="#9aa4b2" font-size="11">already stamps it</text>

  <rect x="300" y="88" width="190" height="66" rx="6" fill="#14161a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="314" y="114" fill="#e6e8eb" font-size="13">sessions.db</text>
  <text x="314" y="134" fill="#9aa4b2" font-size="11" font-family="ui-monospace, monospace">browser_sessions</text>
  <text x="314" y="150" fill="#9aa4b2" font-size="11" font-family="ui-monospace, monospace">computer_sessions</text>

  <rect x="560" y="30" width="180" height="60" rx="6" fill="#14161a" stroke="#2c313a" stroke-width="1.5"/>
  <text x="574" y="56" fill="#e6e8eb" font-size="13">captures on disk</text>
  <text x="574" y="76" fill="#9aa4b2" font-size="11">bytes never in SQLite</text>

  <rect x="560" y="150" width="180" height="60" rx="6" fill="#14161a" stroke="#2c313a" stroke-width="1.5" stroke-dasharray="4 4"/>
  <text x="574" y="176" fill="#e6e8eb" font-size="13">r2.backups (opt-in)</text>
  <text x="574" y="196" fill="#9aa4b2" font-size="11">existing transcript sync</text>

  <path d="M220 62 L296 106" stroke="#a3e635" stroke-width="1.5" fill="none" marker-end="url(#ar2)"/>
  <path d="M220 180 L296 140" stroke="#a3e635" stroke-width="1.5" fill="none" marker-end="url(#ar2)"/>
  <path d="M490 108 L556 70" stroke="#6b7280" stroke-width="1.5" fill="none" marker-end="url(#ar)"/>
  <text x="496" y="104" fill="#9aa4b2" font-size="10">path + counts</text>
  <path d="M490 138 L556 172" stroke="#6b7280" stroke-width="1.5" fill="none" stroke-dasharray="4 4" marker-end="url(#ar)"/>
  </g>
</svg>
</figure>

### 1. Stamp identity in the caller, at task start

Identity must be resolved in the **calling CLI process**, never daemon-side — the daemon is shared and long-lived (the RUSH-2020 bug, preserved in `resolveTaskIdentity`'s docblock).

```diff
 const response = await sendIPCRequest({
   action: 'start',
   profile: profileName,
   taskName: opts.task,
   actor: resolveActor().id,
-  launchId: process.env.AGENT_LAUNCH_ID,
+  launchId: process.env.AGENT_LAUNCH_ID,
+  // The var 5/5 agents carry, vs 2/5 for launchId. Same source
+  // stampProvenance() already uses for computer.action events.
+  sessionId: process.env.AGENT_SESSION_ID || process.env.AGENTS_SESSION_ID,
 });
```

### 2. Write the row once, then never delete it

`tasks.json` stays exactly as it is — it is correct as *live* state. The durable row is written at start and updated on capture; **stop does not delete it**.

```diff
 conn.tasks.set(taskName, task);
 await this.saveTaskState(effectiveProfileName, conn.tasks);
+// Durable, outlives the task and the daemon. tasks.json remains live-state only.
+recordBrowserSession({ task: taskName, profile: effectiveProfileName, ...identity });
```

### 3. Resolve through the existing four-tier resolver

`sessions-list.ts:238` already claims parity with `feed-post.ts` `resolvePostIdentity` but adopted only its launchId tier. Use the real thing rather than writing a second resolver — repo policy is that cross-cutting changes go to the source.

### 4. Captures: pointer in the DB, bytes on disk

The row records `capture_dir` and per-kind counts. Bytes are never copied into SQLite. Offload is **opt-in** and reuses the transcript sync path (`lib/session/sync/`, `r2.backups`, already encrypted) — not `agents share`, which is public and wrong for private captures.

## Public Interface

Two new side tables in the existing per-device `sessions.db`, following the `session_resource_usage` precedent (`db.ts:271`) — keyed on `session_id`, metadata only.

```sql
CREATE TABLE IF NOT EXISTS browser_sessions (
  task TEXT NOT NULL,
  profile TEXT NOT NULL,
  session_id TEXT,          -- the agent session that drove it
  launch_id TEXT,           -- secondary join key, kept
  actor TEXT,               -- human/tailnet identity (not an agent)
  machine TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_activity INTEGER,
  screenshot_count INTEGER DEFAULT 0,
  pdf_count INTEGER DEFAULT 0,
  recording_count INTEGER DEFAULT 0,
  download_count INTEGER DEFAULT 0,
  capture_dir TEXT,         -- path on disk; bytes are NOT stored here
  captures_remote TEXT,     -- optional r2 prefix once offloaded
  PRIMARY KEY (profile, task)
);

CREATE TABLE IF NOT EXISTS computer_sessions (
  invocation_id TEXT PRIMARY KEY,
  session_id TEXT,
  launch_id TEXT,
  actor TEXT,
  machine TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_activity INTEGER,
  action_count INTEGER DEFAULT 0,
  task_preview TEXT         -- already bounded by events.ts truncate()
);
```

No new commands. Existing surfaces gain durable data:

```bash
agents sessions --browser     # rows now name their agent session
agents sessions --computer    # rows survive the 7-day ledger prune
```

## Validation

- A task that is **started, stopped, and re-listed** still resolves its owning session. This is the regression the whole ticket is about.
- A **daemon restart** between start and list does not lose identity.
- A computer run **older than the event ledger's retention** still lists.
- Real services only, no mocking (repo policy). Test file sits next to source; `lib/browser/sessions-list.test.ts` is the existing pattern.
- Verified by running the real command and quoting its output — not by asserting on a fixture alone.

## Risks

| Risk | Mitigation |
|---|---|
| Existing captures cannot be retroactively linked — identity is already gone from disk | Backfill rows from capture dirs with `session_id` NULL, so history still lists and is honestly labelled pre-migration. Do not fabricate a link |
| Schema change on a DB every device carries | New tables via `CREATE TABLE IF NOT EXISTS` + schema-version bump, exactly as `session_resource_usage` did |
| A second retention policy could diverge from the ledger's | The ledger is unchanged and stays the 7-day audit log; the DB is the durable history. No second pruner is added |
| Capture offload could leak private screenshots | Offload is opt-in and uses the already-encrypted `r2.backups` path, never the public `agents share` path |
| Writing a row on the browser hot path could slow `start` | Single local SQLite insert, same store the CLI already opens; no network on the hot path |

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> computer-use already resolves identity correctly via <code>AGENT_SESSION_ID</code> — browser is the outlier. The fix is to make browser use the same signal, and to move both histories into the one store that is actually durable.</aside>

## Checklist

- [ ] Schema: `browser_sessions` + `computer_sessions` tables, schema-version bump
- [ ] Forward `AGENT_SESSION_ID` from the caller in `browser.ts` start + stream
- [ ] Persist the row at task start; remove identity deletion on stop
- [ ] Persist computer runs from `emitComputerAction` alongside the event emit
- [ ] Repoint `sessions-list.ts` (browser + computer) at the DB, via `resolvePostIdentity`
- [ ] Backfill existing capture dirs as rows with NULL session_id
- [ ] Optional capture offload to `r2.backups`, opt-in
- [ ] Tests: stopped-then-relisted task resolves its session; run older than the prune still lists
- [ ] Docs + CHANGELOG

## Tracking

- **RUSH-2549** — the originating bug: browser identity deleted on stop, keyed off the wrong env var
