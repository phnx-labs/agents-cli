# Design-drift review — 2026-08-03

Nightly scan for **design drift**: new primitives introduced where an existing one should have been reused/extended — overlapping surfaces that work but are messy and hard to improve. Read-only analysis; no code was changed. Each finding names the existing primitive that should have absorbed the new code and a concrete consolidation proposal. Muqsit decides per-issue whether to dispatch a fix — this routine does **not** auto-fix.

- **Window:** merges since `14 days ago` on `origin/main` · **200** PRs · **1273** files changed
- **Findings:** 11 (ranked, most consolidation value first)
- **Engine:** reuses the `quality` skill's behavioral-signature + architecture passes

| # | Severity | Finding | Existing primitive to reuse |
|---|---|---|---|
| 1 | HIGH | Fleet SSH fan-out is implemented twice: gatherRemoteList reimplements gatherRemoteAgentsJson | apps/cli/src/lib/remote-agents-json.ts:65 `gatherRemoteAgentsJson` — a |
| 2 | HIGH | Three hand-rolled openclaw-Telegram senders bypass the registered ChannelProvider (and two hardcode the owner number) | apps/cli/src/lib/channels/resolve.ts:13 `resolveTransport(channel, met |
| 3 | HIGH | The event provenance floor (#1796/#1801) never reached the activity store — ActivityEvent lacks actor/kind/parentSessionId | apps/cli/src/lib/events.ts:601 `resolveProvenance` + apps/cli/src/lib/ |
| 4 | HIGH | PRE-MERGE CATCH (open PRs #1788 + #1789): two separate SQLite secret-usage stores at the identical path, both bypassing the emitSecretAudit chokepoint | apps/cli/src/lib/secrets/audit.ts:76 `emitSecretAudit` (canonical sinc |
| 5 | MEDIUM | SSH fan-out + merge orchestration for the activity/feed streams is copy-pasted three times (with feature drift) | apps/cli/src/lib/remote-agents-json.ts `gatherRemoteAgentsJson` + `mer |
| 6 | MEDIUM | Three independent 'who is running this' resolvers instead of one shared detectCaller | apps/cli/src/lib/events.ts:526 `detectCaller` + the 8-harness TERMINAL |
| 7 | MEDIUM | agents sessions --active bypasses the canonical worktree-aware project resolver, so its project label disagrees with every other view | apps/cli/src/lib/project-key.ts:74 `resolveProjectKey` + apps/cli/src/ |
| 8 | MEDIUM | Factory picker caches: ResumePickerCache reimplements HostPickerCache's stale-while-revalidate instead of one shared primitive | apps/factory/src/core/hostPickerCache.ts:23-50 (HostPickerCache, parse |
| 9 | MEDIUM | runCloudSessions hand-rolls its own id match instead of the documented canonical session-query resolver | apps/cli/src/commands/sessions.ts:3068 `resolveSessionQuery` — documen |
| 10 | MEDIUM | feed-post.ts hand-copies machine-id.ts's exported normalizeHost() regex byte-for-byte instead of importing it | apps/cli/src/lib/machine-id.ts:16-18 `normalizeHost` — its docstring l |
| 11 | MEDIUM | Bash-command taxonomy hand-mirrored in TypeScript and Python with no test pinning them in sync | apps/cli/src/lib/session/bash-command.ts (TOOL_REGISTRY, exported, use |

## Findings

### 1. Fleet SSH fan-out is implemented twice: gatherRemoteList reimplements gatherRemoteAgentsJson

**Severity:** HIGH · **Type:** overlapping-primitives · **Confidence:** high

**Overlapping surfaces:**
  - `agents sessions (browse/search listing)` — `apps/cli/src/lib/session/remote-list.ts:182`
  - `shared fan-out primitive` — `apps/cli/src/lib/remote-agents-json.ts:65`
  - `duplicated ssh transport` — `apps/cli/src/lib/session/remote-list.ts:126`

```ts
// apps/cli/src/lib/session/remote-list.ts:182
export async function gatherRemoteList(forwardedArgs: string[], hosts?: string[]): Promise<RemoteListResult> {
```
```ts
// apps/cli/src/lib/remote-agents-json.ts:65
export async function gatherRemoteAgentsJson<T>(
```
```ts
// apps/cli/src/lib/session/remote-list.ts:126
function sshCapture(target: string, remoteCmd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
```

**Reuse instead:** apps/cli/src/lib/remote-agents-json.ts:65 `gatherRemoteAgentsJson` — already reused correctly by apps/cli/src/lib/session/remote-active.ts (gatherRemoteActive)

**Why it's drift:** remote-list.ts:10-14 admits the duplication in its own docstring: "This is the browse-listing sibling of remote-active.ts ... same transport, same device set, same recursion guard." Its device-discovery loop (remote-list.ts:190-216) and its `sshCapture` (remote-list.ts:126-144, spawn('ssh', [...SSH_OPTS, ...controlOpts(), target, remoteCmd]) + timeout + SIGKILL) independently re-type what remote-agents-json.ts:41-71 already provides. remote-active.ts consumes the shared primitive; remote-list.ts forks it.

**Consolidation proposal:** Make gatherRemoteList a thin wrapper over gatherRemoteAgentsJson, as gatherRemoteActive already is (args=forwardedArgs, noFanoutEnv, hosts, parse=parseRemoteListPayload). The one real divergence — remote-list's stricter 'malformed JSON on a zero-exit peer = unreachable' plus row-shape validation — is a small extension to the shared primitive (expose parse-failed peers in RemoteAgentsJsonResult), not a reason for a second fan-out implementation.

### 2. Three hand-rolled openclaw-Telegram senders bypass the registered ChannelProvider (and two hardcode the owner number)

**Severity:** HIGH · **Type:** non-reuse · **Confidence:** high

**Overlapping surfaces:**
  - `registered provider (canonical)` — `apps/cli/src/lib/channels/providers/openclaw-telegram.ts:29`
  - `agents feed --dispatch (notifyUrgentBlock)` — `apps/cli/src/lib/notify.ts:83`
  - `monitors notify action (dispatchAction)` — `apps/cli/src/lib/monitors/dispatch.ts:89`

```ts
// apps/cli/src/lib/channels/providers/openclaw-telegram.ts:29
await execFileAsync('openclaw', buildOpenClawNotifyArgs(text, { channel: 'telegram', target: opts.target }));
```
```ts
// apps/cli/src/lib/notify.ts:83
await execFileAsync('openclaw', buildOpenClawNotifyArgs(text, options));
```
```ts
// apps/cli/src/lib/monitors/dispatch.ts:89
await execFileAsync('openclaw', args);
```

**Reuse instead:** apps/cli/src/lib/channels/resolve.ts:13 `resolveTransport(channel, meta)` + apps/cli/src/lib/channels/registry.ts:50 `resolveChannelProvider` + the registered `openclawTelegramProvider.send()` (providers/index.ts:19) — already the single seam `agents send`/`agents notify` funnel every channel through

**Why it's drift:** All three sites build identical argv via the shared buildOpenClawNotifyArgs (notify.ts:40) then independently exec `openclaw` instead of calling the registered provider. Only the provider and notify.ts preflight-check the binary; monitors/dispatch.ts has none, so a missing openclaw surfaces as a raw ENOENT there. Worse, notify.ts:46 `const target = options.target ?? '6078999250';` and monitors/dispatch.ts pass no target — both silently inherit that hardcoded number, while `agents notify` resolves it from `readMeta().notify?.owner`. A change to notify.owner in agents.yaml is invisible to two of the three send paths.

**Consolidation proposal:** Make resolveTransport(channel, meta).send(text, opts) the one send primitive for every human-facing message. notifyUrgentBlock and the monitor notify action should call it with target = meta.notify?.owner?.to instead of hand-building argv. Deletes two duplicate `which openclaw` + exec blocks, gives monitors dry-run + consistent errors for free, and makes notify.owner the single source for where 'the owner' gets pinged. This is the exact feed/activity/notify/message/send smell the review exists to catch.

### 3. The event provenance floor (#1796/#1801) never reached the activity store — ActivityEvent lacks actor/kind/parentSessionId

**Severity:** HIGH · **Type:** non-reuse · **Confidence:** high

**Overlapping surfaces:**
  - `activity store schema` — `apps/cli/src/lib/activity.ts:135`
  - `activity record stamps a fabricated identity` — `apps/cli/src/lib/activity.ts:416`
  - `operational log chokepoint (canonical)` — `apps/cli/src/lib/events.ts:601`

```ts
// apps/cli/src/lib/activity.ts:135
export interface ActivityEvent {
```
```ts
// apps/cli/src/lib/activity.ts:416
osUser: ev.agent ?? 'agent',
```
```ts
// apps/cli/src/lib/events.ts:601
resolveProvenance()
```

**Reuse instead:** apps/cli/src/lib/events.ts:601 `resolveProvenance` + apps/cli/src/lib/events.ts:560 `auditOrigin` — the operational `emit()` stamps actor/kind/machineId/sessionId/agent/launchId/parentSessionId as defaults; the activity store never grew the same floor

**Why it's drift:** activity.ts:135-158 (ActivityEvent) has no actor/kind/parentSessionId field at all. activityEventToRecord() (activity.ts:402-433) fabricates `osUser: ev.agent ?? 'agent'` and stamps neither actor, kind, nor parentSessionId. The Python PostToolUse hook — the majority writer of activity events — never sets AGENTS_PARENT_SESSION_ID either (activity.ts:1729-1744). Yet commands/events.ts:6 claims 'Each is stamped with who ran it and from where' for BOTH merged streams. The out-of-process `agents events emit` path correctly reuses emit()/appendActivityEvent — so only the activity floor is missing.

**Consolidation proposal:** Add actor/kind/parentSessionId/launchId to ActivityEvent, and fill them via a shared stampProvenance() extracted from events.ts's resolveProvenance/auditOrigin — called from the TS in-process writer and re-derivable by the Python hook off the same env vars — so `agents events` shows consistent identity across both stores. exec.ts:502-507 already promises this as 'Phase 4'; it is not scoped to just the SSH hop.

### 4. PRE-MERGE CATCH (open PRs #1788 + #1789): two separate SQLite secret-usage stores at the identical path, both bypassing the emitSecretAudit chokepoint

**Severity:** HIGH · **Type:** overlapping-primitives · **Confidence:** high

**Overlapping surfaces:**
  - `agents secrets (PR #1788, usage-db.ts)` — `apps/cli/src/lib/secrets/usage-db.ts:76`
  - `agents secrets (PR #1789, activity.ts)` — `apps/cli/src/lib/secrets/activity.ts:52`
  - `incompatible env override (PR #1788)` — `apps/cli/src/lib/state.ts:345`
  - `incompatible env override (PR #1789)` — `apps/cli/src/lib/secrets/activity.ts:80`

```ts
// apps/cli/src/lib/secrets/usage-db.ts:76
CREATE TABLE IF NOT EXISTS usage_events ( id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, bundle TEXT NOT NULL, event TEXT NOT NULL,
```
```ts
// apps/cli/src/lib/secrets/activity.ts:52
CREATE TABLE IF NOT EXISTS events ( id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, bundle TEXT NOT NULL, kind TEXT NOT NULL,
```
```ts
// apps/cli/src/lib/state.ts:345
export function getSecretsDbPath(): string { return process.env.AGENTS_SECRETS_DB ?? path.join(USER_SECRETS_DIR, 'secrets.db'); }
```
```ts
// apps/cli/src/lib/secrets/activity.ts:80
export function secretsActivityDbPath(): string { if (process.env.AGENTS_SECRETS_DB_PATH) return process.env.AGENTS_SECRETS_DB_PATH;
```

**Reuse instead:** apps/cli/src/lib/secrets/audit.ts:76 `emitSecretAudit` (canonical since #1616 — 'Every path that reads a secret VALUE or grants an unlock funnels its audit through here'). PR #1814 already does the right consolidation and says so: 'emitSecretAudit is the SOLE write path ... Supersedes #1788 and #1789.'

**Why it's drift:** main (HEAD ed9aae69) is CLEAN — one chokepoint, no SQLite store in lib/secrets/. But PRs #1788 (secrets-usage-db) and #1789 (feat/secrets-activity) are both OPEN (mergedAt: null), both forked from the same base 8253f6d3, and each adds a DIFFERENT SQLite store at the SAME on-disk path ~/.agents/secrets/secrets.db with incompatible schemas (usage_events vs events+bundle_stats+meta) and incompatible env overrides (AGENTS_SECRETS_DB vs AGENTS_SECRETS_DB_PATH). Each calls its own recorder (recordSecretUsage / recordSecretActivity) directly from secrets.ts action sites, bypassing emitSecretAudit. Neither PR references the other. If either merges before #1814, main acquires exactly the overlapping-primitives problem this review exists to catch.

**Consolidation proposal:** Close #1788 and #1789 as superseded; merge #1814, which folds the SQLite mirror inside emitSecretAudit via a USAGE_KIND map (one instrumentation call per site) and reuses the already-merged list-filter.ts (#1779). This is a pre-merge catch — acting now prevents the drift instead of filing a cleanup ticket after it lands.

### 5. SSH fan-out + merge orchestration for the activity/feed streams is copy-pasted three times (with feature drift)

**Severity:** MEDIUM · **Type:** non-reuse · **Confidence:** high

**Overlapping surfaces:**
  - `agents feed (block fan-out)` — `apps/cli/src/commands/feed.ts:508`
  - `agents feed --filter updates (gatherStatusPosts)` — `apps/cli/src/commands/feed.ts:696`
  - `agents activity` — `apps/cli/src/commands/activity.ts:198`

```ts
// apps/cli/src/commands/feed.ts:508
const forceLocal = opts.local === true || process.env[FEED_NO_FANOUT_ENV] === '1';
```
```ts
// apps/cli/src/commands/feed.ts:696
const forceLocal = opts.local === true || process.env[FEED_NO_FANOUT_ENV] === '1';
```
```ts
// apps/cli/src/commands/activity.ts:198
const forceLocal = opts.local === true || process.env[ACTIVITY_NO_FANOUT_ENV] === '1';
```

**Reuse instead:** apps/cli/src/lib/remote-agents-json.ts `gatherRemoteAgentsJson` + `mergeActivityEvents`/`mergeFeedBlocks` — the dial-and-merge mechanics are shared; only the surrounding force-local/host-resolution/wantAll orchestration is re-derived three times. Same root as finding #1.

**Why it's drift:** feed.ts's block path (feed.ts:508-521) and its gatherStatusPosts sibling (feed.ts:696-706) reimplement the identical shape as activity.ts's action (activity.ts:218-233), except activity.ts additionally supports --devices-all/--hosts-all (activity.ts:200-201) that neither feed.ts copy has — a feature gap that exists only because the logic was not factored once.

**Consolidation proposal:** Extract a single fanOutAndMerge<T>({ localItems, args, noFanoutEnv, hosts, wantAll, self, parse, merge }) helper in lib/remote-agents-json.ts encoding the force-local check, host resolution, and --devices-all opt-in once. Have both feed.ts sites and activity.ts call it — this retroactively gives `agents feed --filter updates` the --devices-all fan-out `agents activity` already has, closing the drift instead of hiding it.

### 6. Three independent 'who is running this' resolvers instead of one shared detectCaller

**Severity:** MEDIUM · **Type:** overlapping-primitives · **Confidence:** high

**Overlapping surfaces:**
  - `events.ts (canonical, 8-harness map)` — `apps/cli/src/lib/events.ts:526`
  - `feed-post.ts (claude/codex only)` — `apps/cli/src/lib/feed-post.ts:409`
  - `activity.ts Python hook (defaults to 'claude')` — `apps/cli/src/lib/activity.ts:1729`

```ts
// apps/cli/src/lib/events.ts:526
export function detectCaller(
```
```ts
// apps/cli/src/lib/feed-post.ts:409
function detectAgentKind(env: NodeJS.ProcessEnv): string {
```
```ts
// apps/cli/src/lib/activity.ts:1729
# Identity (mirrors 10-feed-publish.py).
```

**Reuse instead:** apps/cli/src/lib/events.ts:526 `detectCaller` + the 8-harness TERMINAL_CALLERS map (events.ts:514-523)

**Why it's drift:** feed-post.ts:409-412 detectAgentKind recognizes only claude/codex ('if (env.CLAUDECODE === '1') return 'claude'; if (env.CODEX_CI || env.CODEX_HOME) return 'codex'; return 'agent';') versus events.ts detectCaller which resolves grok/cursor/opencode/gemini/antigravity too. The Python hook has a third, narrower resolver defaulting to 'claude' unconditionally (activity.ts:1744 `agent = os.environ.get("AGENTS_AGENT_NAME") or "claude"`). None call each other; each is a standalone guess at the same fact from the same env vars — a harness-parity gap that silently mislabels non-claude/codex agents.

**Consolidation proposal:** Export detectCaller (or resolveAgentKind) from events.ts; feed-post.ts::resolvePostIdentity calls it instead of detectAgentKind. For the Python hook, default agent to the caller-detected value forwarded via AGENTS_AGENT_NAME (buildExecEnv sets it at exec.ts:514) rather than hardcoding 'claude'.

### 7. agents sessions --active bypasses the canonical worktree-aware project resolver, so its project label disagrees with every other view

**Severity:** MEDIUM · **Type:** non-reuse · **Confidence:** high

**Overlapping surfaces:**
  - `agents sessions --active (row)` — `apps/cli/src/commands/sessions.ts:435`
  - `agents sessions --active --json` — `apps/cli/src/commands/sessions.ts:628`

```ts
// apps/cli/src/commands/sessions.ts:435
const project = s.cwd ? path.basename(s.cwd) : '';
```
```ts
// apps/cli/src/commands/sessions.ts:628
project: s.cwd ? path.basename(s.cwd) : null,
```

**Reuse instead:** apps/cli/src/lib/project-key.ts:74 `resolveProjectKey` + apps/cli/src/lib/projects.ts:338 `resolveProjectNameForCwd` — already reused by the bare `agents sessions` overview (sessions.ts:2118 overviewProjectKey) and by `agents activity` (activity.ts:396)

**Why it's drift:** project-key.ts:1-16 states the resolver exists precisely so a worktree cwd folds to the repo name and a defined multi-repo project reads as one bucket everywhere — 'They must agree, or the same session shows up under agents-cli in one view and my-branch-slug in another.' sessions.ts:435 and :628 (the --active surface #1809/#1765 shipped) recompute project via raw path.basename(s.cwd) — no worktree fold, no defined-project match — so --active disagrees with activity and the bare listing for the same session.

**Consolidation proposal:** Replace both path.basename(s.cwd) sites with resolveProjectNameForCwd(s.cwd, listProjectDefs()) falling back to resolveProjectKey(s.cwd), computed once per gatherActiveSessions() and threaded to render + serialize. Note: check the RUSH-1981 --active --json consumer (sessions.ts:604-610) that documents the basename shape as a deliberate join-stability choice before changing the JSON field.

### 8. Factory picker caches: ResumePickerCache reimplements HostPickerCache's stale-while-revalidate instead of one shared primitive

**Severity:** MEDIUM · **Type:** non-reuse · **Confidence:** medium

**Overlapping surfaces:**
  - `Agents: Resume` — `apps/factory/src/core/resumePicker.ts:55`
  - `Agents: New <Agent> (Pick Host)` — `apps/factory/src/core/hostPickerCache.ts:48`
  - `New <Agent> (Auto) launch-health` — `apps/factory/src/core/launchHistory.ts:92`
  - `hot-mirror bolted onto one cache only` — `apps/factory/src/vscode/extension.ts:540`

```ts
// apps/factory/src/core/resumePicker.ts:55
export interface ResumePickerCache {
  candidates: ResumeCandidate[];
  fetchedAt: number;
}
```
```ts
// apps/factory/src/core/hostPickerCache.ts:48
export function isHostPickerStale(cache: HostPickerCache | null | undefined, now = Date.now()): boolean {
  return !cache || now - cache.fetchedAt >= HOST_PICKER_STALE_MS;
}
```
```ts
// apps/factory/src/core/launchHistory.ts:92
if (!cache || now - cache.refreshedAt > LAUNCH_HEALTH_MAX_AGE_MS) return null;
```
```ts
// apps/factory/src/vscode/extension.ts:540
let hostPickerHot: HostPickerCache | null = null;
```

**Reuse instead:** apps/factory/src/core/hostPickerCache.ts:23-50 (HostPickerCache, parseHostPickerCache, isHostPickerStale) — the only one of the three persisted picker caches with a named, testable staleness function

**Why it's drift:** PR #1782 (commit 8253f6d3) message: 'Agents: Resume gets the same treatment (agents.resumePicker.v1, checks carried across the item swap)' — the same PR that introduced HostPickerCache hand-copied the persisted-snapshot / staleness / background-refresh pattern into ResumePickerCache rather than generalizing it. Staleness diverges: HOST_PICKER_STALE_MS=60_000 vs LAUNCH_HEALTH_MAX_AGE_MS=5*60_000 vs ResumePickerCache which defines no threshold at all (refreshes on every non-empty open, extension.ts:3283). An in-memory hot mirror exists only for HostPickerCache (extension.ts:540-552); the other two re-read+re-parse globalState on every open.

**Consolidation proposal:** Extract createStaleWhileRevalidateCache<T>(key, staleMs) owning globalState read/shape-check, staleness check, in-memory hot mirror, and background-refresh-and-swap. Reimplement HostPickerCache and ResumePickerCache as instances; migrate LaunchHealthCache when its refresh is next touched. One ticket, covers all three facets.

### 9. runCloudSessions hand-rolls its own id match instead of the documented canonical session-query resolver

**Severity:** MEDIUM · **Type:** non-reuse · **Confidence:** high

**Overlapping surfaces:**
  - `agents sessions --cloud <id>` — `apps/cli/src/commands/sessions.ts:2977`

```ts
// apps/cli/src/commands/sessions.ts:2977
const matches = sessions.filter(
    (s) => s.id === query || s.shortId === query || s.id.startsWith(query),
  );
```

**Reuse instead:** apps/cli/src/commands/sessions.ts:3068 `resolveSessionQuery` — documented as 'The single entry point for turning a sessions <query> argument into rows'; already reused by fleetCandidatesByQuery (sessions.ts:3459) and resolveIndexedMetadataRows (sessions.ts:3482)

**Why it's drift:** resolveSessionQuery gates id-shaped queries through looksLikeSessionId and keeps ranked search for phrases (sessions.ts:3063-3066). runCloudSessions applies none of that — a raw startsWith against any query string (sessions.ts:2978), so cloud sessions silently skip the id gate and ambiguity handling every other session source gets.

**Consolidation proposal:** Call resolveSessionQuery(sessions, query, { indexFallback: false }) in runCloudSessions the way fleetCandidatesByQuery and resolveIndexedMetadataRows already do, so cloud sessions get the same looksLikeSessionId gate and ambiguity/hint behavior as every other source.

### 10. feed-post.ts hand-copies machine-id.ts's exported normalizeHost() regex byte-for-byte instead of importing it

**Severity:** MEDIUM · **Type:** non-reuse · **Confidence:** high

**Overlapping surfaces:**
  - `feed-post.ts (inline copy)` — `apps/cli/src/lib/feed-post.ts:401`

```ts
// apps/cli/src/lib/feed-post.ts:401
function machineIdFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = env.AGENTS_SYNC_MACHINE_ID || undefined;
  if (raw) {
    return raw.split('.')[0].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown';
  }
  return machineId();
}
```

**Reuse instead:** apps/cli/src/lib/machine-id.ts:16-18 `normalizeHost` — its docstring literally says 'The single source for this transform'; feed-post.ts already imports `machineId` from the same module (feed-post.ts:25)

**Why it's drift:** machine-id.ts:16-18 normalizeHost body is byte-for-byte duplicated inline in feed-post.ts:401-406, in a file that already imports from ./machine-id.js — normalizeHost was one import away.

**Consolidation proposal:** Import normalizeHost alongside machineId in feed-post.ts and replace machineIdFromEnv's body with `return env.AGENTS_SYNC_MACHINE_ID ? normalizeHost(env.AGENTS_SYNC_MACHINE_ID) : machineId();` — one line, zero behavior change.

### 11. Bash-command taxonomy hand-mirrored in TypeScript and Python with no test pinning them in sync

**Severity:** MEDIUM · **Type:** overlapping-primitives · **Confidence:** medium

**Overlapping surfaces:**
  - `activity.ts Python hook (mirror)` — `apps/cli/src/lib/activity.ts:942`

```ts
// apps/cli/src/lib/activity.ts:942
# Canonical command taxonomy for Bash tool calls. Mirrors the TypeScript
# registry in lib/session/bash-command.ts; keep them in sync.
BASH_TOOL_REGISTRY = {
```

**Reuse instead:** apps/cli/src/lib/session/bash-command.ts (TOOL_REGISTRY, exported, used by session rendering / `agents sessions`)

**Why it's drift:** activity.ts:942-943 documents the duplication ('Mirrors the TypeScript registry ... keep them in sync') rather than generating the Python dict from the TS registry. The two currently agree, but neither activity.test.ts nor bash-command.test.ts asserts it — nothing fails CI if a future PR adds a tool to one and forgets the other, so `agents sessions` (TS reader) and `agents activity` (Python-hook writer) would silently disagree on a command's category.

**Consolidation proposal:** Either (a) generate BASH_TOOL_REGISTRY's Python literal from bash-command.ts's TOOL_REGISTRY at hook-install time (activity.ts already templates the hook as a string, so this is codegen, not a runtime import), or (b) add a test that parses both registries and fails on divergence — the same discipline activity.test.ts already applies to MILESTONE_EVENTS vs the Python hook's copy (activity.ts:120-125).

## Verified distinct (not flagged)

The review examined these look-alikes and confirmed they are **legitimately distinct**, not drift — recorded here so the false-positive discipline is auditable:

- **`agents message` vs `agents send --channel mailbox`** — both hit the same `enqueue()` seam, but the mailbox provider's own docstring (`lib/channels/providers/mailbox.ts:4-6`) says it is "a thin wrapper over the same enqueue seam that `agents message` uses," and `agents message` additionally does block-claim / inject / resume routing `send` never does. Correct reuse of one primitive behind two deliberate surfaces.
- **`agents feed post` broadcast sinks vs the channel-provider registry** — `lib/feed-broadcast.ts:9-14` are operator-configured argv templates ("Sinks are argv templates from config, never hardcoded integrations"), an OSS-neutrality choice, not a second typed send API.
- **`agents activity` / `agents feed` trailing lane / `agents events --module activity`** — all read the *same* `readRecentActivity` primitive (`lib/activity.ts:321`) with shared formatters; different lenses on one store, not parallel readers.
- **Factory host-picker PRs #1782/#1799/#1802** — legitimate iteration on ONE primitive: #1782 introduced `HostPickerCache`, #1799/#1802 extended it in place. (The drift is the *sibling* caches that hand-copied its pattern — the Factory picker-cache finding — not the picker PRs themselves.)
- **Session-query resolver** — well-consolidated: `resolveSessionQuery` (`sessions.ts:3068`) is the single entry point and every fleet path funnels through it; `findSessionsByShortIds` (#1765) is a deliberate batched variant for N tmux panes, not drift. (The one bypass — `runCloudSessions` — is flagged separately.)
- **Rollup formatters** (`rollupSessionsByProject`, `groupActivity`, `buildOverviewGroups`) — three genuinely different data shapes (live-session card, event timeline, history listing) for three purposes; legitimate parallel implementations.
- **`agents events emit` (out-of-process)** — correctly reuses `emit()` / `appendActivityEvent()` rather than re-implementing the write path. The operational-log provenance floor (`resolveProvenance`) IS a real single chokepoint; only the *activity store* half missed it (the activity-store provenance finding).
- **Secrets on `main` today** — healthy: one `emitSecretAudit` chokepoint, no parallel store. The drift (the secrets finding, blocker) lives in two still-open PRs, not on `main`.

## Drafted Linear tickets

> The `linear.app` secrets bundle was not reachable from the run host, so tickets are **drafted** here rather than filed. Run these once the bundle is present (`agents secrets exec linear.app -- ...`), or file them from a box that has it. Tag: `design-drift`.

```bash
linear issue create --title "design-drift: Fleet SSH fan-out is implemented twice: gatherRemoteList reimplements gatherRemoteAgentsJson" \
  --label design-drift --description "Overlapping surfaces:\n- agents sessions (browse/search listing) (apps/cli/src/lib/session/remote-list.ts:182)\n- shared fan-out primitive (apps/cli/src/lib/remote-agents-json.ts:65)\n- duplicated ssh transport (apps/cli/src/lib/session/remote-list.ts:126)\n\nReuse instead: apps/cli/src/lib/remote-agents-json.ts:65 `gatherRemoteAgentsJson` — already reused correctly by apps/cli/src/lib/session/remote-active.ts (gatherRemoteActive)\n\nWhy it's drift: remote-list.ts:10-14 admits the duplication in its own docstring: 'This is the browse-listing sibling of remote-active.ts ... same transport, same device set, same recursion guard.' Its device-discovery loop (remote-list.ts:190-216) and its `sshCapture` (remote-list.ts:126-144, spawn('ssh', [...SSH_OPTS, ...controlOpts(), target, remoteCmd]) + timeout + SIGKILL) independently re-type what remote-agents-json.ts:41-71 already provides. remote-active.ts consumes the shared primitive; remote-list.ts forks it.\n\nProposal: Make gatherRemoteList a thin wrapper over gatherRemoteAgentsJson, as gatherRemoteActive already is (args=forwardedArgs, noFanoutEnv, hosts, parse=parseRemoteListPayload). The one real divergence — remote-list's stricter 'malformed JSON on a zero-exit peer = unreachable' plus row-shape validation — is a small extension to the shared primitive (expose parse-failed peers in RemoteAgentsJsonResult), not a reason for a second fan-out implementation."
```

```bash
linear issue create --title "design-drift: Three hand-rolled openclaw-Telegram senders bypass the registered ChannelProvider (and two hardcode the owner number)" \
  --label design-drift --description "Overlapping surfaces:\n- registered provider (canonical) (apps/cli/src/lib/channels/providers/openclaw-telegram.ts:29)\n- agents feed --dispatch (notifyUrgentBlock) (apps/cli/src/lib/notify.ts:83)\n- monitors notify action (dispatchAction) (apps/cli/src/lib/monitors/dispatch.ts:89)\n\nReuse instead: apps/cli/src/lib/channels/resolve.ts:13 `resolveTransport(channel, meta)` + apps/cli/src/lib/channels/registry.ts:50 `resolveChannelProvider` + the registered `openclawTelegramProvider.send()` (providers/index.ts:19) — already the single seam `agents send`/`agents notify` funnel every channel through\n\nWhy it's drift: All three sites build identical argv via the shared buildOpenClawNotifyArgs (notify.ts:40) then independently exec `openclaw` instead of calling the registered provider. Only the provider and notify.ts preflight-check the binary; monitors/dispatch.ts has none, so a missing openclaw surfaces as a raw ENOENT there. Worse, notify.ts:46 `const target = options.target ?? '6078999250';` and monitors/dispatch.ts pass no target — both silently inherit that hardcoded number, while `agents notify` resolves it from `readMeta().notify?.owner`. A change to notify.owner in agents.yaml is invisible to two of the three send paths.\n\nProposal: Make resolveTransport(channel, meta).send(text, opts) the one send primitive for every human-facing message. notifyUrgentBlock and the monitor notify action should call it with target = meta.notify?.owner?.to instead of hand-building argv. Deletes two duplicate `which openclaw` + exec blocks, gives monitors dry-run + consistent errors for free, and makes notify.owner the single source for where 'the owner' gets pinged. This is the exact feed/activity/notify/message/send smell the review exists to catch."
```

```bash
linear issue create --title "design-drift: The event provenance floor (#1796/#1801) never reached the activity store — ActivityEvent lacks actor/kind/parentSessionId" \
  --label design-drift --description "Overlapping surfaces:\n- activity store schema (apps/cli/src/lib/activity.ts:135)\n- activity record stamps a fabricated identity (apps/cli/src/lib/activity.ts:416)\n- operational log chokepoint (canonical) (apps/cli/src/lib/events.ts:601)\n\nReuse instead: apps/cli/src/lib/events.ts:601 `resolveProvenance` + apps/cli/src/lib/events.ts:560 `auditOrigin` — the operational `emit()` stamps actor/kind/machineId/sessionId/agent/launchId/parentSessionId as defaults; the activity store never grew the same floor\n\nWhy it's drift: activity.ts:135-158 (ActivityEvent) has no actor/kind/parentSessionId field at all. activityEventToRecord() (activity.ts:402-433) fabricates `osUser: ev.agent ?? 'agent'` and stamps neither actor, kind, nor parentSessionId. The Python PostToolUse hook — the majority writer of activity events — never sets AGENTS_PARENT_SESSION_ID either (activity.ts:1729-1744). Yet commands/events.ts:6 claims 'Each is stamped with who ran it and from where' for BOTH merged streams. The out-of-process `agents events emit` path correctly reuses emit()/appendActivityEvent — so only the activity floor is missing.\n\nProposal: Add actor/kind/parentSessionId/launchId to ActivityEvent, and fill them via a shared stampProvenance() extracted from events.ts's resolveProvenance/auditOrigin — called from the TS in-process writer and re-derivable by the Python hook off the same env vars — so `agents events` shows consistent identity across both stores. exec.ts:502-507 already promises this as 'Phase 4'; it is not scoped to just the SSH hop."
```

```bash
linear issue create --title "design-drift: PRE-MERGE CATCH (open PRs #1788 + #1789): two separate SQLite secret-usage stores at the identical path, both bypassing the emitSecretAudit chokepoint" \
  --label design-drift --description "Overlapping surfaces:\n- agents secrets (PR #1788, usage-db.ts) (apps/cli/src/lib/secrets/usage-db.ts:76)\n- agents secrets (PR #1789, activity.ts) (apps/cli/src/lib/secrets/activity.ts:52)\n- incompatible env override (PR #1788) (apps/cli/src/lib/state.ts:345)\n- incompatible env override (PR #1789) (apps/cli/src/lib/secrets/activity.ts:80)\n\nReuse instead: apps/cli/src/lib/secrets/audit.ts:76 `emitSecretAudit` (canonical since #1616 — 'Every path that reads a secret VALUE or grants an unlock funnels its audit through here'). PR #1814 already does the right consolidation and says so: 'emitSecretAudit is the SOLE write path ... Supersedes #1788 and #1789.'\n\nWhy it's drift: main (HEAD ed9aae69) is CLEAN — one chokepoint, no SQLite store in lib/secrets/. But PRs #1788 (secrets-usage-db) and #1789 (feat/secrets-activity) are both OPEN (mergedAt: null), both forked from the same base 8253f6d3, and each adds a DIFFERENT SQLite store at the SAME on-disk path ~/.agents/secrets/secrets.db with incompatible schemas (usage_events vs events+bundle_stats+meta) and incompatible env overrides (AGENTS_SECRETS_DB vs AGENTS_SECRETS_DB_PATH). Each calls its own recorder (recordSecretUsage / recordSecretActivity) directly from secrets.ts action sites, bypassing emitSecretAudit. Neither PR references the other. If either merges before #1814, main acquires exactly the overlapping-primitives problem this review exists to catch.\n\nProposal: Close #1788 and #1789 as superseded; merge #1814, which folds the SQLite mirror inside emitSecretAudit via a USAGE_KIND map (one instrumentation call per site) and reuses the already-merged list-filter.ts (#1779). This is a pre-merge catch — acting now prevents the drift instead of filing a cleanup ticket after it lands."
```

```bash
linear issue create --title "design-drift: SSH fan-out + merge orchestration for the activity/feed streams is copy-pasted three times (with feature drift)" \
  --label design-drift --description "Overlapping surfaces:\n- agents feed (block fan-out) (apps/cli/src/commands/feed.ts:508)\n- agents feed --filter updates (gatherStatusPosts) (apps/cli/src/commands/feed.ts:696)\n- agents activity (apps/cli/src/commands/activity.ts:198)\n\nReuse instead: apps/cli/src/lib/remote-agents-json.ts `gatherRemoteAgentsJson` + `mergeActivityEvents`/`mergeFeedBlocks` — the dial-and-merge mechanics are shared; only the surrounding force-local/host-resolution/wantAll orchestration is re-derived three times. Same root as finding #1.\n\nWhy it's drift: feed.ts's block path (feed.ts:508-521) and its gatherStatusPosts sibling (feed.ts:696-706) reimplement the identical shape as activity.ts's action (activity.ts:218-233), except activity.ts additionally supports --devices-all/--hosts-all (activity.ts:200-201) that neither feed.ts copy has — a feature gap that exists only because the logic was not factored once.\n\nProposal: Extract a single fanOutAndMerge<T>({ localItems, args, noFanoutEnv, hosts, wantAll, self, parse, merge }) helper in lib/remote-agents-json.ts encoding the force-local check, host resolution, and --devices-all opt-in once. Have both feed.ts sites and activity.ts call it — this retroactively gives `agents feed --filter updates` the --devices-all fan-out `agents activity` already has, closing the drift instead of hiding it."
```

```bash
linear issue create --title "design-drift: Three independent 'who is running this' resolvers instead of one shared detectCaller" \
  --label design-drift --description "Overlapping surfaces:\n- events.ts (canonical, 8-harness map) (apps/cli/src/lib/events.ts:526)\n- feed-post.ts (claude/codex only) (apps/cli/src/lib/feed-post.ts:409)\n- activity.ts Python hook (defaults to 'claude') (apps/cli/src/lib/activity.ts:1729)\n\nReuse instead: apps/cli/src/lib/events.ts:526 `detectCaller` + the 8-harness TERMINAL_CALLERS map (events.ts:514-523)\n\nWhy it's drift: feed-post.ts:409-412 detectAgentKind recognizes only claude/codex ('if (env.CLAUDECODE === '1') return 'claude'; if (env.CODEX_CI || env.CODEX_HOME) return 'codex'; return 'agent';') versus events.ts detectCaller which resolves grok/cursor/opencode/gemini/antigravity too. The Python hook has a third, narrower resolver defaulting to 'claude' unconditionally (activity.ts:1744 `agent = os.environ.get('AGENTS_AGENT_NAME') or 'claude'`). None call each other; each is a standalone guess at the same fact from the same env vars — a harness-parity gap that silently mislabels non-claude/codex agents.\n\nProposal: Export detectCaller (or resolveAgentKind) from events.ts; feed-post.ts::resolvePostIdentity calls it instead of detectAgentKind. For the Python hook, default agent to the caller-detected value forwarded via AGENTS_AGENT_NAME (buildExecEnv sets it at exec.ts:514) rather than hardcoding 'claude'."
```

```bash
linear issue create --title "design-drift: agents sessions --active bypasses the canonical worktree-aware project resolver, so its project label disagrees with every other view" \
  --label design-drift --description "Overlapping surfaces:\n- agents sessions --active (row) (apps/cli/src/commands/sessions.ts:435)\n- agents sessions --active --json (apps/cli/src/commands/sessions.ts:628)\n\nReuse instead: apps/cli/src/lib/project-key.ts:74 `resolveProjectKey` + apps/cli/src/lib/projects.ts:338 `resolveProjectNameForCwd` — already reused by the bare `agents sessions` overview (sessions.ts:2118 overviewProjectKey) and by `agents activity` (activity.ts:396)\n\nWhy it's drift: project-key.ts:1-16 states the resolver exists precisely so a worktree cwd folds to the repo name and a defined multi-repo project reads as one bucket everywhere — 'They must agree, or the same session shows up under agents-cli in one view and my-branch-slug in another.' sessions.ts:435 and :628 (the --active surface #1809/#1765 shipped) recompute project via raw path.basename(s.cwd) — no worktree fold, no defined-project match — so --active disagrees with activity and the bare listing for the same session.\n\nProposal: Replace both path.basename(s.cwd) sites with resolveProjectNameForCwd(s.cwd, listProjectDefs()) falling back to resolveProjectKey(s.cwd), computed once per gatherActiveSessions() and threaded to render + serialize. Note: check the RUSH-1981 --active --json consumer (sessions.ts:604-610) that documents the basename shape as a deliberate join-stability choice before changing the JSON field."
```

```bash
linear issue create --title "design-drift: Factory picker caches: ResumePickerCache reimplements HostPickerCache's stale-while-revalidate instead of one shared primitive" \
  --label design-drift --description "Overlapping surfaces:\n- Agents: Resume (apps/factory/src/core/resumePicker.ts:55)\n- Agents: New <Agent> (Pick Host) (apps/factory/src/core/hostPickerCache.ts:48)\n- New <Agent> (Auto) launch-health (apps/factory/src/core/launchHistory.ts:92)\n- hot-mirror bolted onto one cache only (apps/factory/src/vscode/extension.ts:540)\n\nReuse instead: apps/factory/src/core/hostPickerCache.ts:23-50 (HostPickerCache, parseHostPickerCache, isHostPickerStale) — the only one of the three persisted picker caches with a named, testable staleness function\n\nWhy it's drift: PR #1782 (commit 8253f6d3) message: 'Agents: Resume gets the same treatment (agents.resumePicker.v1, checks carried across the item swap)' — the same PR that introduced HostPickerCache hand-copied the persisted-snapshot / staleness / background-refresh pattern into ResumePickerCache rather than generalizing it. Staleness diverges: HOST_PICKER_STALE_MS=60_000 vs LAUNCH_HEALTH_MAX_AGE_MS=5*60_000 vs ResumePickerCache which defines no threshold at all (refreshes on every non-empty open, extension.ts:3283). An in-memory hot mirror exists only for HostPickerCache (extension.ts:540-552); the other two re-read+re-parse globalState on every open.\n\nProposal: Extract createStaleWhileRevalidateCache<T>(key, staleMs) owning globalState read/shape-check, staleness check, in-memory hot mirror, and background-refresh-and-swap. Reimplement HostPickerCache and ResumePickerCache as instances; migrate LaunchHealthCache when its refresh is next touched. One ticket, covers all three facets."
```

```bash
linear issue create --title "design-drift: runCloudSessions hand-rolls its own id match instead of the documented canonical session-query resolver" \
  --label design-drift --description "Overlapping surfaces:\n- agents sessions --cloud <id> (apps/cli/src/commands/sessions.ts:2977)\n\nReuse instead: apps/cli/src/commands/sessions.ts:3068 `resolveSessionQuery` — documented as 'The single entry point for turning a sessions <query> argument into rows'; already reused by fleetCandidatesByQuery (sessions.ts:3459) and resolveIndexedMetadataRows (sessions.ts:3482)\n\nWhy it's drift: resolveSessionQuery gates id-shaped queries through looksLikeSessionId and keeps ranked search for phrases (sessions.ts:3063-3066). runCloudSessions applies none of that — a raw startsWith against any query string (sessions.ts:2978), so cloud sessions silently skip the id gate and ambiguity handling every other session source gets.\n\nProposal: Call resolveSessionQuery(sessions, query, { indexFallback: false }) in runCloudSessions the way fleetCandidatesByQuery and resolveIndexedMetadataRows already do, so cloud sessions get the same looksLikeSessionId gate and ambiguity/hint behavior as every other source."
```

```bash
linear issue create --title "design-drift: feed-post.ts hand-copies machine-id.ts's exported normalizeHost() regex byte-for-byte instead of importing it" \
  --label design-drift --description "Overlapping surfaces:\n- feed-post.ts (inline copy) (apps/cli/src/lib/feed-post.ts:401)\n\nReuse instead: apps/cli/src/lib/machine-id.ts:16-18 `normalizeHost` — its docstring literally says 'The single source for this transform'; feed-post.ts already imports `machineId` from the same module (feed-post.ts:25)\n\nWhy it's drift: machine-id.ts:16-18 normalizeHost body is byte-for-byte duplicated inline in feed-post.ts:401-406, in a file that already imports from ./machine-id.js — normalizeHost was one import away.\n\nProposal: Import normalizeHost alongside machineId in feed-post.ts and replace machineIdFromEnv's body with `return env.AGENTS_SYNC_MACHINE_ID ? normalizeHost(env.AGENTS_SYNC_MACHINE_ID) : machineId();` — one line, zero behavior change."
```

```bash
linear issue create --title "design-drift: Bash-command taxonomy hand-mirrored in TypeScript and Python with no test pinning them in sync" \
  --label design-drift --description "Overlapping surfaces:\n- activity.ts Python hook (mirror) (apps/cli/src/lib/activity.ts:942)\n\nReuse instead: apps/cli/src/lib/session/bash-command.ts (TOOL_REGISTRY, exported, used by session rendering / `agents sessions`)\n\nWhy it's drift: activity.ts:942-943 documents the duplication ('Mirrors the TypeScript registry ... keep them in sync') rather than generating the Python dict from the TS registry. The two currently agree, but neither activity.test.ts nor bash-command.test.ts asserts it — nothing fails CI if a future PR adds a tool to one and forgets the other, so `agents sessions` (TS reader) and `agents activity` (Python-hook writer) would silently disagree on a command's category.\n\nProposal: Either (a) generate BASH_TOOL_REGISTRY's Python literal from bash-command.ts's TOOL_REGISTRY at hook-install time (activity.ts already templates the hook as a string, so this is codegen, not a runtime import), or (b) add a test that parses both registries and fails on divergence — the same discipline activity.test.ts already applies to MILESTONE_EVENTS vs the Python hook's copy (activity.ts:120-125)."
```

---

_Produced by the `design-drift` skill — reuses the `quality` engine's behavioral-signature clustering + a cross-surface consolidation lens over the window's merged surfaces. Read-only: no code was changed. Every finding cites `file:line`; the owner decides per-ticket whether to dispatch a fix._

