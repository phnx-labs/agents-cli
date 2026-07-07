# Self-Healing Installs

How agents-cli keeps a managed agent runnable when its install goes bad — detecting, surfacing, and repairing a broken binary instead of dying with a cryptic error.

> This covers the *runtime integrity* of agent CLIs agents-cli installs. For the
> normal install/pin/switch mechanics see [Version management](01-version-management.md).

## The failure it fixes

Several first-class agents ship their real (native) binary as an **optional
per-arch npm dependency**. Codex is the canonical case:

```
@openai/codex                       # the package `agents add codex` installs
  bin/codex.js                      # a thin JS wrapper (this is node_modules/.bin/codex)
  optionalDependencies:
    @openai/codex-darwin-arm64      # the ACTUAL binary ships here, in its `vendor/` tree
    @openai/codex-linux-x64
    ...
```

The wrapper `require.resolve`s the platform package and `spawn`s the native
binary inside its `vendor/` tree. That layout has a blind spot: if the platform
package's tarball extracts **partially** — an interrupted install, a flaky
network, or two `agents add codex` runs racing into the same version dir — the
package's `package.json` lands (so `require.resolve` succeeds) while the
`vendor/.../codex` binary does not. The wrapper sails **past its own
"missing optional dependency" guard** and `spawn`s a file that isn't there:

```
Error: spawn .../@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT
```

Two things made this nasty before self-healing:

1. **A gutted install looked healthy.** `getBinaryPath()` (and therefore
   `isVersionInstalled()`) only checks the JS wrapper at `node_modules/.bin/<cli>`,
   which *is* present. So the broken version got recorded as installed, pinned as
   the default, and picked to run.
2. **The crash was invisible.** Interactive runs are wrapped in tmux
   (see [Entrypoints & Loops](07-entrypoints-and-loops.md)); the `pane-died`
   hook detached the client the instant the agent exited, leaving only a bare
   `[detached (from session …)]` with no error text.

## Three layers of defense

```
  agents add <agent>@<ver>                 agents run <agent>
        │                                        │
        ▼                                        ▼
  ┌───────────────────┐                  ┌───────────────────┐
  │ LAYER 1           │                  │ LAYER 2           │
  │ install-integrity │                  │ launch self-heal  │
  │ gate              │                  │ (ensureAgentRunn- │
  │                   │                  │  able)            │
  │ probe the binary; │                  │ probe → repair →  │
  │ FAIL the install  │                  │ fall back →       │
  │ if it can't run — │                  │ install latest    │
  │ never pin a       │                  │ → else error      │
  │ broken version    │                  └─────────┬─────────┘
  └───────────────────┘                            ▼
                                          ┌───────────────────┐
                                          │ LAYER 3           │
                                          │ surface failures  │
                                          │                   │
                                          │ recap the dead    │
                                          │ tmux pane's real  │
                                          │ error + exit code │
                                          │ instead of a bare │
                                          │ [detached]        │
                                          └───────────────────┘
```

Layer 1 stops broken installs from ever being recorded. Layer 2 repairs one that
already exists (or slips past, e.g. a version that broke *after* install). Layer 3
guarantees that whatever residual failure reaches the user is *visible*, not
swallowed.

### Layer 1 — install-integrity gate

After a successful `npm install`, `installVersion()`
([`src/lib/versions.ts`](../src/lib/versions.ts)) probes the resolved binary via
`verifyInstalledBinaryLaunches()`. If it can't launch, the install returns
`success: false` and its `node_modules` is removed — so a gutted install is
**never** recorded as healthy and its caller never sets it as the default pin.

### Layer 2 — launch self-heal

`ensureAgentRunnable()` runs on the `agents run` path
([`src/commands/exec.ts`](../src/commands/exec.ts)), right after the version to
launch is resolved and **before** the launch command is built:

```
ensureAgentRunnable(agent, version):

  npm-package agent?  ─── no ──▶ return version    (grok/droid: global/native binary, N/A)
        │ yes
        ▼
  verifyInstalledBinaryLaunches(version)
        │
   ┌────┴─────┐
 healthy    broken
   │          │
 return     clean reinstall IN PLACE            (wipe node_modules first —
 version     (installVersion, { clean:true })    npm skips a present-but-gutted
   │          │                                   platform package otherwise)
   │     ┌────┴─────┐
   │  healthy    still broken
   │     │          │
   │  return     for each other installed version, newest-first:
   │  version       └─ verifyInstalledBinaryLaunches → if healthy:
   │                     setGlobalDefault(cand); return cand   (re-pin so the
   │                     │                                       shim path heals too)
   │                     ▼ none healthy
   │                  install `latest` (clean); pin it; return it
   │                     │ still fails
   │                     ▼
   │                  return null  ──▶  clear error: "not runnable and could not
   │                                     be repaired. Try: agents add <agent>@latest"
   ▼
 (spawn the healed version)
```

The healed version is then adopted explicitly, so a fallback that re-pins the
**global** default is not defeated by a **project** pin (`resolveVersion` prefers
the project pin).

### Layer 3 — surface failures

`runInTmux()` ([`src/lib/exec.ts`](../src/lib/exec.ts)) recaps a dead pane's last
output (read from scrollback via `capture-pane -S -200`, because the pane's
visible screen is just the "Pane is dead" banner) plus the exit code to stderr —
so a launch that still fails lands in the caller's shell instead of a bare
`[detached]`. A fast failure (dead before attach) always recaps; a post-attach
**nonzero** exit recaps too; a clean exit or a manual `Ctrl-b d` detach stays
quiet. The `--no-tmux` / `--disable-tmux` flag (and `AGENTS_NO_TMUX=1`) bypass the
wrapper entirely to spawn the agent with full stdio — the fastest way to see a
launch failure raw.

## The health probe

The whole system rests on one narrow judgement:
`verifyInstalledBinaryLaunches()` runs `<binary> --version` under the version's
isolated `HOME`. Because the `ENOENT` originates in the *child* (the wrapper
spawns fine, then fails to exec the absent native binary), the probe inspects the
child's **output**, not merely whether the spawn succeeded.

`isMissingBinarySignature()` decides "broken", and it is deliberately narrow —
only the missing-file signature counts:

```
/\bENOENT\b | no such file | cannot find | command not found | is not recognized/i
```

Everything else is treated as **healthy**: an ordinary nonzero exit (an agent
that dislikes `--version`) or a timeout (an agent that waits for input) must never
be mistaken for a gutted install. This asymmetry is intentional — a false
"healthy" costs a visible ENOENT that Layers 2/3 still catch, whereas a false
"broken" would needlessly reinstall (Layer 2) or **wipe a good install**
(Layer 1). The bias is toward never destroying a healthy install.

## Scope and limits

| Aspect | Behavior |
|---|---|
| Agents covered | npm-package agents only (the `optionalDependencies` failure class). Agents with a global/native binary (grok → `~/.grok/downloads`, droid → `~/.local/bin`) are returned unchanged. |
| Windows | The probe **short-circuits to healthy on `win32`**. `getBinaryPath` returns the extensionless `.bin/<cli>` shell wrapper, which isn't directly `execFile`-able there; probing it would ENOENT on a healthy install and Layer 1 would wipe it. `isVersionInstalled` still validates presence on Windows via `getPackageBinaryPath`. |
| Entry path | Self-heal runs on **`agents run`**. The bare-shim path (typing `codex` directly) relies on the shim's own auto-install plus Layer 1 — it does not call `ensureAgentRunnable`. |
| Cost | One `--version` spawn per local run for npm agents (fast for a healthy binary). A repair triggers a real `npm install`. |
| Repair vs. fallback | In-place repair re-fetches the whole tarball; if a specific version is un-fetchable (yanked/offline), self-heal falls back to another installed version rather than blocking the run. `home/` (conversation history) is always preserved across a clean reinstall. |

## Source map

| Piece | Location |
|---|---|
| `ensureAgentRunnable()` — the self-heal engine | [`src/lib/versions.ts`](../src/lib/versions.ts) |
| `verifyInstalledBinaryLaunches()` — the launch probe | [`src/lib/versions.ts`](../src/lib/versions.ts) |
| `isMissingBinarySignature()` — the "broken" classifier | [`src/lib/versions.ts`](../src/lib/versions.ts) |
| `installVersion(..., { clean })` — Layer 1 gate + wipe-then-reinstall | [`src/lib/versions.ts`](../src/lib/versions.ts) |
| Self-heal wiring on the run path | [`src/commands/exec.ts`](../src/commands/exec.ts) |
| `runInTmux()` dead-pane recap (Layer 3) | [`src/lib/exec.ts`](../src/lib/exec.ts) |
| Tests | `src/lib/versions-integrity.test.ts`, `src/lib/tmux/session.test.ts`, `src/lib/exec.test.ts` |
