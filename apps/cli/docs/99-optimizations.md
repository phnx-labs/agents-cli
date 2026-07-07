# Optimizations

Running log of performance work: what was slow, why, what we changed, and measured results.

---

## OPT-01: Sync Manifest — Skip Unconditional Re-Sync on Agent Launch

### Problem

Every agent launch ran `syncResourcesToVersion` unconditionally. It would delete
all resource directories in the version home and re-copy everything from the
source repos — regardless of whether anything had changed.

CPU profiling (wall-clock breakdown across JS frames):

```
┌──────────────────────┬─────────────┬──────────────────────────────────────────┐
│      Operation       │    Time     │                What it is                │
├──────────────────────┼─────────────┼──────────────────────────────────────────┤
│ copyFile (3 sites)   │ 5.87s (37%) │ Copying resource files into version home │
│ unlink               │ 1.11s  (7%) │ Deleting old versions before re-copy     │
│ readdir (3 sites)    │ 1.11s  (7%) │ Listing source/dest dirs                 │
│ YAML parse/stringify │ 1.07s  (7%) │ Parsing hooks.yaml, permissions, etc.    │
│ GC                   │ 1.07s  (7%) │ V8 garbage collection                    │
│ chmod                │ 0.97s  (6%) │ Setting permissions on copied files      │
│ rmdir                │ 0.49s  (3%) │ Removing directory trees                 │
│ existsSync           │ 0.55s  (3%) │ Path probes                              │
│ mkdir                │ 0.40s  (3%) │ Creating target dirs                     │
│ lstat                │ 0.25s  (2%) │ Symlink probes                           │
│ Other JS             │ ~1.5s (10%) │ App code                                 │
│ Idle                 │ 0.75s  (5%) │ Event loop waiting                       │
└──────────────────────┴─────────────┴──────────────────────────────────────────┘
Total: ~16s wall time. Filesystem mutation accounts for ~10s of that.
```

With a typical install — 26 commands, 29 skills (each a directory tree of 5–20
files), 8 hooks, 6 rules, permissions — that's over 100 file operations per
launch, every time, regardless of whether a single source file had changed.

Three concurrent agent launches saturated the disk.

### Design

The fix is a **sync manifest**: a fingerprint file written after each full sync,
read before the next one. If all fingerprints match, skip the sync entirely.

```
First launch (cold)                    Subsequent launches (hot)

syncResourcesToVersion()               syncResourcesToVersion()
  │                                      │
  ├─ (no manifest)                       ├─ loadSyncManifest()  ~0.1ms
  │                                      │    │
  ├─ [full sync: ~20s]                   │    └─ isSyncStale()   ~7ms
  │   removePath + copyFile                          │
  │   per resource                                   ├─ all clean?
  │                                                  │    └─ return NOOP_SYNC_RESULT
  └─ saveSyncManifest()                              │         ← skip entire sync
       sha256 all sources ~3s               stale?   │
       write .sync-manifest.json             └─ full sync runs, manifest rewritten
```

#### Two-tier fingerprint

The hot-path cost comes entirely from `stat()` calls — no file reads:

```
For each source file:

  Tier 1 — stat(path): mtime + size          ~0.01ms/file
    match → CLEAN  (skip everything, no I/O)
    mismatch → ↓

  Tier 2 — sha256(readFile)                  ~0.1–0.5ms/file
    match → CLEAN  (mtime drifted, content same)
    mismatch → STALE
```

`stat()` is served from the kernel VFS cache. On a warm filesystem, a cold
`stat()` is ~0.01ms; for recently-touched files it's essentially free. The sha256
fallback only fires when mtime or size changed — which in practice means a real
edit.

Expected cost at scale (50 agents × nothing changed):

```
50 agents × ~100 files × 0.01ms/stat = ~50ms total
vs.
50 agents × ~16s unconditional sync  = ~800s total

8000× reduction in steady-state disk pressure.
```

Manifest writes are atomic: written to `{path}.tmp` then `fs.renameSync` (POSIX
atomic). If two agents race, last-write-wins — safe because both see the same
source state.

#### Manifest schema

One file per installed version, at:
`~/.agents-system/versions/{agent}/{version}/home/.sync-manifest.json`

```
SyncManifest {
  v: 1
  syncedAt: ISO timestamp

  commands:    { [name]: FileEntry }
  skills:      { [name]: DirEntry  }
  hooks:       { [name]: FileEntry }
  rules:       { files: { [name]: FileEntry } }
  mcp:         { [name]: FileEntry }
  permissions: { groups: { [name]: FileEntry }, permissionSet: string | null }
  subagents:   { [name]: DirEntry  }
}

FileEntry: { source: Fingerprint }
DirEntry:  { dirPath: string, files: Fingerprint[] }

Fingerprint: { path, mtime, size, sha256 }
```

`DirEntry` is used for skills and subagents — any file added, removed, or
modified anywhere in the directory tree triggers re-sync.

**Coverage across all user-defined resource types:**

```
Resource      In manifest   Notes
──────────── ─────────────  ──────────────────────────────────────────────────
commands      ✓ FileEntry   first-wins per name (project > user > system > extra)
skills        ✓ DirEntry    first-wins per name, full recursive dir fingerprint
hooks         ✓ FileEntry   first-wins per name
rules         ✓ FileEntry   first-wins per name; @-imports via isRulesStale()
mcp           ✓ FileEntry   first-wins per name (project > user > system)
permissions   ✓ FileEntry   first-wins per group name; env-var set captured
subagents     ✓ DirEntry    user > system, first-wins (matches sync code path)
promptcuts    — not tracked  hook reads ~/.agents/promptcuts.yaml directly;
                             no per-version copy exists to go stale
plugins       — not tracked  system-only (npm-installed); not user-authored
```

The `permissionSet` field captures the `AGENTS_PERMISSION_SET` env var at sync
time. If the user switches permission sets between launches, the manifest becomes
stale even if no group files changed.

#### Layering correctness

Resources resolve from three scopes: **project > user > system** (plus extra repos
last). The manifest stores the **winning source path** for each resource name.
This handles all scope transitions correctly:

```
Event                                      How detected
────────────────────────────────────────── ────────────────────────────────────
Winning file content changes             → sha256 mismatch
Project file added (now shadows user)    → resolved path changes → path mismatch
Project file removed (user now wins)     → resolved path changes → path mismatch
New resource name added in any scope     → name set grows: available ≠ manifest keys
Resource name removed from all scopes    → name set shrinks: available ≠ manifest keys
Non-winning file changes (shadowed)      → not detected (correct — doesn't affect output)
Permission set env var changes           → permissionSet field mismatch
```

Name-set comparison runs first (O(1) set comparison) and exits early if any
category's available names differ from the manifest keys. Per-file fingerprint
checks only run if name sets match.

#### Rules compilation

For agents that don't support native `@`-import resolution (Codex, Cursor),
`AGENTS.md` is pre-compiled into a flat file with all `@path` references inlined.
This path has its own sidecar manifest (`{compiledFile}.manifest.json`) managed
by `rules-compile.ts`. The sync manifest delegates rules staleness to
`isRulesStale(agent, version)` rather than duplicating that logic.

`isRulesStale` was also improved to use the same two-tier fingerprint — the
original implementation called `sha256(readFile)` on every source file on every
check. The updated version records `mtime` and `size` alongside `sha256` and
skips the read when both match.

### Guard placement

The guard sits at the very top of `syncResourcesToVersion`, before any file
mutations:

```
syncResourcesToVersion(agent, version, selection?, options)
  │
  ├─ [selection set] ──────────────────────────────▶ skip guard (explicit sync)
  │
  ├─ [options.force] ──────────────────────────────▶ skip guard (forced)
  │
  └─ loadSyncManifest()
       │
       ├─ [null or v≠1] ──────────────────────────▶ full sync (cold start)
       │
       └─ isSyncStale(manifest, available, ...)
            │
            ├─ [true]  ───────────────────────────▶ full sync + saveSyncManifest()
            │
            └─ [false] ───────────────────────────▶ return NOOP_SYNC_RESULT
                                                     (zero file operations)
```

The guard only engages for **full, unselected syncs** — the path taken on every
agent launch. Explicit user interactions (`agents sync`, interactive add) bypass
it so users always get exactly what they asked for.

### Results

Measured on a machine with 26 commands, 29 skills, 8 hooks, 1 memory file, no
MCP servers:

```
Cold launch (manifest written):    ~24s   (sync + sha256 all sources)
Hot launch  (guard fires, skip):   ~600ms
```

The hot-path cost breaks down as:
- `getAvailableResources()`: ~16ms (readdir across all source repos)
- `loadSyncManifest()`: ~0.4ms
- `isSyncStale()` stat passes: ~7ms (29 skill dirs × N files each)

The 600ms is mostly `getAvailableResources` — the guard itself adds ~7ms on top.
Further reduction would require caching `getAvailableResources` output, which
trades correctness guarantees for speed.

### New files

| File | Role |
|------|------|
| `src/lib/sync-manifest.ts` | Manifest types, load/save, `buildManifest`, `isSyncStale`; covers all seven user-defined resource types |

### Modified files

| File | Change |
|------|--------|
| `src/lib/versions.ts` | Guard + manifest write in `syncResourcesToVersion`; `force?` option; skip dotfiles in `copyDir` |
| `src/lib/rules-compile.ts` | Add `mtime?`/`size?` to `CompileManifest`; two-tier fast path in `isRulesStale` |

---

## OPT-02: SSH Transport — One Multiplexed Engine

Full design rationale: [09-ssh-transport.md](09-ssh-transport.md).

### Problem

Every remote surface (`run/view/sync/sessions/teams … --host`, remote secrets,
the CDP tunnel) forks the system `ssh`. On the laptop that drives the fleet, each
fork is a process, a socket, and a full TCP+auth handshake. OpenSSH connection
multiplexing was implemented in the choke point but was **opt-in**, and only 3 of
~13 call paths opted in — the hottest ones did not:

```
followHostTask  poll loop      2 un-muxed ssh / 1.5s   ≈ 4,800 spawns/hour
ensureHostReady dispatch gate  3 sequential connections (2 un-muxed)
runRemoteSessions fan-out      private SSH_OPTS copy, no multiplexing
SSH_OPTS                       no keepalive → dropped links hang as zombies
```

### Design

Two shared primitives; everything composes from them:

- **`SSH_OPTS`** — the one hardened baseline, now with keepalive
  (`ServerAliveInterval=15` / `ServerAliveCountMax=3`, ~45 s to reap a dead link).
- **`controlOpts()`** — multiplexing, flipped to **default-on**
  (`opts.multiplex === false ? [] : controlOpts()`). Every routed caller reuses
  the control socket for free; degrades to a fresh connection if the socket can't
  open; no-ops on Windows.

Plus two hot-path rewrites: the follow loop now does **one** combined round-trip
per cycle (sentinel-framed `tail; printf; cat`) with adaptive backoff, and
readiness collapses **3 probes into 1** compound `readyProbe`.

### Results

Live Tailscale-relayed host, `scripts/bench-ssh.mjs`, wall-clock on the laptop:

```
┌──────────────────────────────┬──────────┬──────────┬───────────────────────────┐
│            Path              │  Before  │  After   │           Win             │
├──────────────────────────────┼──────────┼──────────┼───────────────────────────┤
│ P3 repeated --host (per call)│  ~444ms  │  ~75ms   │ ~6-7x                     │
│ P2 readiness per dispatch    │ 1.5-1.8s │  ~0.8s   │ ~2x                       │
│ P1 follow loop (per cycle)   │  ~706ms  │  ~33ms   │ ~21-23x, 50% fewer spawns │
└──────────────────────────────┴──────────┴──────────┴───────────────────────────┘
```

Reproduce: `bun run build && node scripts/bench-ssh.mjs <host>`.

### New files

| File | Role |
|------|------|
| `docs/09-ssh-transport.md` | Design rationale for the shared SSH transport |
| `scripts/bench-ssh.mjs` | A/B benchmark harness (needs a live host) |

### Modified files

| File | Change |
|------|--------|
| `src/lib/ssh-exec.ts` | Keepalive in `SSH_OPTS`; multiplexing default-on |
| `src/lib/hosts/progress.ts` | One combined round-trip/cycle + adaptive backoff; `splitProgressOutput` |
| `src/lib/hosts/ready.ts` | `readyProbe` collapses 3 probes into 1 |
| `src/commands/hosts.ts` | Thread the probe result through `maybeBootstrap` (drop duplicate probe) |
| `src/lib/session/remote.ts` | Import canonical `SSH_OPTS` + `controlOpts` (drop private copy) |
| `src/commands/secrets.ts` | Route the remote push through `sshExec` |
| `src/lib/ssh-tunnel.ts` | `buildTunnelArgs` composes `SSH_OPTS` (inherits keepalive) |
