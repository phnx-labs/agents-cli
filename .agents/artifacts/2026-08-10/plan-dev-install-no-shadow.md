---
kind: plan
surface: cli
title: Dev builds must never replace the installed `agents` binary
summary: >
  An agent developing agents-cli currently overwrites or shadows the real
  `agents` command three different ways, leaving it broken. The dev build moves
  to its own name, `agents-dev`, and the repo instructions say so.
status: implementing
tracking: "extends RUSH-2431 / RUSH-2446"
facts:
  - "scripts/install.sh links the dev build as ~/.local/bin/{agents,ag,browser}"
  - "Those three links are dangling on yosemite-s0 right now"
  - "A worktree build is currently serving the shared daemon (pid 4163347)"
  - "postinstall.js, the path real npm users take, is out of scope"
---

## Focus for review

- **The dev command name.** `agents-dev` / `ag-dev`, chosen so PATH order stops
  deciding which code runs. Say if you want a different spelling.
- **Dropping `browser` from the dev link set.** `agents-dev browser …` covers it,
  and production never claims that name.
- **Making the daemon bounce opt-in.** Today `install.sh` restarts your shared
  routines/secrets daemon onto dev code automatically. That is a hijack you cannot
  see; I want it behind `--bounce-daemon`.
- **Repairing the links already on disk.** The next `install.sh` run would delete
  the three dangling `~/.local/bin` entries it created earlier.
- **Scope.** Development flow only. `postinstall.js` is untouched.

## Intent

> "when agents are building the binaries to test the agent CLI, they should not
> replace the global binary installed. they should build it under some path like
> bin or something and install it properly with some dev flag like agents dev …
> otherwise when it writes my binary it causes more problems for me"
>
> "install.sh … that script should be like install.sh or something like that. We
> should just install it locally, automatically."
>
> "not the post-install script is the one that runs for our users right? I'm
> talking about like when agents are doing development."

## Current architecture

Three separate mechanisms let a development build take over the production
command. Every one is verified against this machine, not inferred.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 900 400" role="img" aria-label="Three paths by which a dev build takes over the production agents command" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 z" fill="#e0663a"/>
    </marker>
    <marker id="ok" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 z" fill="#7a8a99"/>
    </marker>
  </defs>

  <text x="20" y="26" font-family="ui-monospace,monospace" font-size="13" font-weight="700" fill="currentColor">agent developing agents-cli</text>

  <rect x="20" y="44" width="215" height="52" rx="6" fill="none" stroke="#7a8a99" stroke-width="1.5"/>
  <text x="34" y="66" font-family="ui-monospace,monospace" font-size="11.5" fill="currentColor">1. global rule says</text>
  <text x="34" y="83" font-family="ui-monospace,monospace" font-size="11.5" fill="#e0663a">npm i -g .</text>

  <rect x="20" y="118" width="215" height="52" rx="6" fill="none" stroke="#7a8a99" stroke-width="1.5"/>
  <text x="34" y="140" font-family="ui-monospace,monospace" font-size="11.5" fill="currentColor">2. install.sh links</text>
  <text x="34" y="157" font-family="ui-monospace,monospace" font-size="11.5" fill="#e0663a">~/.local/bin/agents</text>

  <rect x="20" y="192" width="215" height="52" rx="6" fill="none" stroke="#7a8a99" stroke-width="1.5"/>
  <text x="34" y="214" font-family="ui-monospace,monospace" font-size="11.5" fill="currentColor">3. install.sh bounces</text>
  <text x="34" y="231" font-family="ui-monospace,monospace" font-size="11.5" fill="#e0663a">the shared daemon</text>

  <line x1="235" y1="70"  x2="392" y2="120" stroke="#e0663a" stroke-width="2" marker-end="url(#ar)"/>
  <line x1="235" y1="144" x2="392" y2="144" stroke="#e0663a" stroke-width="2" marker-end="url(#ar)"/>
  <line x1="235" y1="218" x2="392" y2="262" stroke="#e0663a" stroke-width="2" marker-end="url(#ar)"/>

  <rect x="400" y="104" width="230" height="80" rx="6" fill="none" stroke="#e0663a" stroke-width="2"/>
  <text x="414" y="128" font-family="ui-monospace,monospace" font-size="12" font-weight="700" fill="#e0663a">the production command</text>
  <text x="414" y="148" font-family="ui-monospace,monospace" font-size="11.5" fill="currentColor">agents / ag / browser</text>
  <text x="414" y="168" font-family="ui-monospace,monospace" font-size="11" fill="#7a8a99">overwritten or shadowed</text>

  <rect x="400" y="238" width="230" height="52" rx="6" fill="none" stroke="#e0663a" stroke-width="2"/>
  <text x="414" y="260" font-family="ui-monospace,monospace" font-size="12" font-weight="700" fill="#e0663a">the shared daemon</text>
  <text x="414" y="278" font-family="ui-monospace,monospace" font-size="11" fill="#7a8a99">secrets · browser · routines</text>

  <line x1="630" y1="144" x2="702" y2="144" stroke="#7a8a99" stroke-width="1.5" marker-end="url(#ok)"/>
  <line x1="630" y1="264" x2="702" y2="200" stroke="#7a8a99" stroke-width="1.5" marker-end="url(#ok)"/>

  <rect x="710" y="118" width="170" height="88" rx="6" fill="none" stroke="#7a8a99" stroke-width="1.5" stroke-dasharray="4 3"/>
  <text x="724" y="142" font-family="ui-monospace,monospace" font-size="12" font-weight="700" fill="currentColor">every other</text>
  <text x="724" y="160" font-family="ui-monospace,monospace" font-size="12" font-weight="700" fill="currentColor">session on the</text>
  <text x="724" y="178" font-family="ui-monospace,monospace" font-size="12" font-weight="700" fill="currentColor">fleet</text>
  <text x="724" y="196" font-family="ui-monospace,monospace" font-size="11" fill="#e0663a">runs broken / stale</text>

  <text x="20" y="330" font-family="ui-monospace,monospace" font-size="11" fill="#7a8a99">Legend:</text>
  <line x1="80" y1="326" x2="120" y2="326" stroke="#e0663a" stroke-width="2" marker-end="url(#ar)"/>
  <text x="128" y="330" font-family="ui-monospace,monospace" font-size="11" fill="#7a8a99">takeover path (this plan removes all three)</text>
  <line x1="80" y1="352" x2="120" y2="352" stroke="#7a8a99" stroke-width="1.5" marker-end="url(#ok)"/>
  <text x="128" y="356" font-family="ui-monospace,monospace" font-size="11" fill="#7a8a99">blast radius</text>
</svg>
<figcaption><b>Figure.</b> Three independent takeover paths, one blast radius.</figcaption>
</figure>

| # | Mechanism | Evidence |
| --- | --- | --- |
| 1 | The global rule tells every agent to install globally, and this repo carves out no exception | `/home/muqsit/.claude/CLAUDE.md:455` — *"No locally built CLIs. Install globally (`npm i -g`…)"*. npm prefix is `/home/muqsit/.local`, so `npm i -g .` lands on the real install. |
| 2 | `install.sh` links the dev build under the production names | `apps/cli/scripts/install.sh:141-146` — `for bin in agents ag browser; do ln -sf "$src" "$LINK_DIR/$bin"` |
| 3 | `install.sh` restarts the shared daemon pinned to the dev binary | `install.sh:196` `AGENTS_INSTALL_BIN="$LINKED_PATH"` → `install.sh:205` `d.startDaemon?.(bin)` → `apps/cli/src/lib/daemon.ts:1313` |

<div class="artifact-callout">
Both AGENTS.md files document path 2 as correct — <code>AGENTS.md:158</code> and
<code>apps/cli/AGENTS.md:583-585</code> say the dev build is "symlinked into
<code>$HOME/.local/bin/agents</code>. The npm-installed global is never touched."
That is true about the npm prefix and false about the command you actually type.
</div>

### What that looks like on this box right now

<div class="artifact-grid artifact-grid-2">
<div class="artifact-panel" data-state="current" data-evidence="capture">

**Before — the dev links were dangling**

```console
$ ls -la ~/.local/bin/agents ~/.local/bin/ag ~/.local/bin/browser
agents  -> /home/muqsit/.local/agents-cli-dev/bin/agents
ag      -> /home/muqsit/.local/agents-cli-dev/bin/ag
browser -> /home/muqsit/.local/agents-cli-dev/bin/browser

$ ls ~/.local/agents-cli-dev/lib/node_modules/@phnx-labs/
                                     # empty - the dev prefix was cleaned

$ ~/.local/bin/agents --version
zsh: no such file or directory: /home/muqsit/.local/bin/agents

$ pgrep -af __daemon-run
4163347 bun .agents/worktrees/rush-2431-binary-shadow/apps/cli/dist/index.js __daemon-run
```

Any shell that puts `~/.local/bin` first gets a broken `agents`.
</div>

<div class="artifact-panel" data-state="proposed" data-evidence="capture">

**After — two names, no collision**

```console
$ bash scripts/install.sh --skip-tests
  bin:    /home/muqsit/.local/bin/agents-dev
  Removed stale dev link: ~/.local/bin/agents -> ~/.local/agents-cli-dev/bin/agents
  Removed stale dev link: ~/.local/bin/ag     -> ~/.local/agents-cli-dev/bin/ag
  Removed stale dev link: ~/.local/bin/browser -> ~/.local/agents-cli-dev/bin/browser
  Shared daemon left on production code (secrets broker, browser IPC, routines).
  Ready
  /home/muqsit/.local/bin/agents-dev (0.0.0-dev.41ae41f60-dirty)
  Run 'agents-dev <args>'. Your installed 'agents' is untouched.

$ ls ~/.local/bin/agents ~/.local/bin/ag ~/.local/bin/browser
ls: cannot access ...: No such file or directory   # all three gone

$ agents --version
1.22.35                              # installed CLI, untouched

$ agents-dev --version
0.0.0-dev.41ae41f60-dirty            # this working tree
```

PATH position stops mattering. You pick which one runs by typing its name.
</div>
</div>

## Purpose

Remove the cause, not just the symptom. RUSH-2431 already shipped the detection
half — `apps/cli/src/lib/binary-shadow.ts` ("Detect `agents` binaries that could
shadow the currently running CLI") and an `agents doctor` `binary-shadow`
warning. RUSH-2446 added the fleet-rollout probe that refuses to count a
dev-shadowed box as upgraded (`apps/cli/src/lib/devices/rollout-verify.ts:172-177`).
This plan extends that work by removing what those two exist to catch; both stay
in place as backstops.

## Proposed Changes

### `apps/cli/scripts/install.sh` — link as `agents-dev`, never `agents`

```diff
-  for bin in agents ag browser; do
+  for bin in "${DEV_BINS[@]}"; do
     ...
-    ln -sf "$PREFIX/bin/$bin" "$LINK_DIR/$bin"
+    ln -sf "$PREFIX/bin/$bin" "$LINK_DIR/$bin$DEV_SUFFIX"
   done
```

`browser` leaves the dev link set entirely: `agents-dev browser …` reaches the
same code, and production's `~/.local/bin` fallback claims only `agents` and `ag`
(`apps/cli/scripts/postinstall.js:315`), so there is no reason to hold a third
name.

The same rename applies at every other site that hardcodes the bin name:

| Site | Now | After |
| --- | --- | --- |
| `:7-12` header comment | "exposed via `$HOME/.local/bin/agents`" plus PATH-ordering advice | exposed as `agents-dev` / `ag-dev`; states the script must never touch `agents`, `ag`, or `browser` |
| `:69` status line | `bin: $LINK_DIR/agents` | `bin: $LINK_DIR/agents-dev` |
| `:132-140` MINGW branch | writes `$LINK_DIR/$bin{,.cmd,.ps1}` | writes `$LINK_DIR/$bin-dev{,.cmd,.ps1}` with an embedded marker comment |
| `:152-157` macOS Mach-O branch | `ln -sf "$NATIVE_BIN" "$LINK_DIR/agents"` and `…/ag` | `…/agents-dev` and `…/ag-dev` |
| `:159-162` runnability check | `LINKED_PATH="$LINK_DIR/agents"` | `LINKED_PATH="$LINK_DIR/agents-dev"` |
| `:219-238` PATH-precedence warning | warns when the registry bin dir precedes `$LINK_DIR` | delete the ordering half; keep only the "`$LINK_DIR` is not on PATH" case |

### Repair pass, before the new links are created

```diff
+DEV_SHADOW_MARKER='AGENTS_CLI_DEV_SHADOW_LINK'
+
+# Remove ONLY a $LINK_DIR/{agents,ag,browser} entry a PRIOR run of THIS script
+# created. A real file, or a link pointing anywhere else (registry install,
+# Homebrew, the user's own alias), is left untouched.
+cleanup_legacy_shadow() {
+  local path="$1" raw
+  if [[ -L "$path" ]]; then
+    # readlink, not [[ -e ]]: -e is false for a DANGLING symlink, which is
+    # exactly the shape left behind when the dev prefix is cleaned.
+    raw=$(readlink "$path") || return 0
+    case "$raw" in
+      "$PREFIX"/*|"$HOME"/.local/agents-cli-dev/*)
+        rm -f "$path"; dim "  Removed legacy shadow link: $path -> $raw" ;;
+    esac
+  elif [[ -f "$path" ]] && grep -qF "$DEV_SHADOW_MARKER" "$path" 2>/dev/null; then
+    rm -f "$path"; dim "  Removed legacy shadow file: $path"
+  fi
+}
+for bin in agents ag browser; do
+  cleanup_legacy_shadow "$LINK_DIR/$bin"
+  cleanup_legacy_shadow "$LINK_DIR/$bin.cmd"
+  cleanup_legacy_shadow "$LINK_DIR/$bin.ps1"
+done
```

This clears the three dangling entries on yosemite-s0 the next time the script
runs.

### Daemon bounce becomes opt-in

The docblock at `install.sh:186-187` justifies the automatic restart on the
premise that the dev build *is* what `agents` resolves to. This change removes
that premise, so the restart has to stop being automatic:

```diff
-if [[ -z "${CI:-}" && "${AGENTS_NO_HEAL:-}" != "1" ]]; then
+if [[ -z "${CI:-}" && "${AGENTS_NO_HEAL:-}" != "1" && "$BOUNCE_DAEMON" == true ]]; then
   INSTALLED_PKG="$PREFIX/lib/node_modules/$PKG_NAME"
   ...
+elif [[ -z "${CI:-}" ]]; then
+  dim "  Shared daemon left on production code (secrets broker, browser IPC, routines)."
+  dim "  Pass --bounce-daemon to point it at this dev build - that also affects your"
+  dim "  everyday 'agents', not just agents-dev."
 fi
```

### `AGENTS.md` (root, canonical — never edit the `CLAUDE.md` symlink)

Amend the entry-points table row at `:158`, then add a short paragraph under the
table stating the rule and naming the override it takes over from:

```diff
-| CLI dev install | [`apps/cli/scripts/install.sh`](apps/cli/scripts/install.sh) | side-by-side dev build at `~/.local/agents-cli-dev`, exposed via `~/.local/bin/agents`; does not touch the registry install |
+| CLI dev install | [`apps/cli/scripts/install.sh`](apps/cli/scripts/install.sh) | side-by-side dev build at `~/.local/agents-cli-dev`, invoked as `agents-dev` (and `ag-dev`); never creates or touches `~/.local/bin/{agents,ag,browser}` |
```

The new paragraph, in substance: in this repo the global "install globally / no
locally built CLIs" rule does **not** apply to agents-cli itself, because the
thing being built *is* the command. To run your changes, use `bun run test` or
`bun run test:remote` for the suite (`apps/cli/package.json:58,61`), and
`scripts/install.sh` then `agents-dev …` to drive the real CLI. Never `npm i -g`
from the working tree. `agents doctor` reports a `binary-shadow` finding if
something has taken the name.

### `apps/cli/AGENTS.md` (canonical) — correct the false claim

Rewrite the "Local dev build" paragraph at `:583-585` so it matches: installs at
`$HOME/.local/agents-cli-dev/`, exposed as `agents-dev` / `ag-dev`; the
production `agents` command is never created or overwritten; version stamps
`0.0.0-dev.<sha>[-dirty]`; the daemon bounce is opt-in.

### Stale-premise comments — wording only, no logic

`apps/cli/src/lib/devices/rollout-verify.ts:6-10` and
`apps/cli/src/commands/ssh.ts:461` both name `scripts/install.sh` as *the*
example of a shadowing dev build. Reword to a generic "a stale or legacy install
pointed `agents` elsewhere". The probes are name-agnostic (`command -v agents`)
and keep working unchanged.

## Public Interface

| Surface | Before | After |
| --- | --- | --- |
| Dev command | `agents` (shadows production) | `agents-dev` |
| Dev alias | `ag` (shadows production) | `ag-dev` |
| Dev browser | `browser` (shadows production) | removed; use `agents-dev browser` |
| Daemon restart | automatic on every install | opt-in via `--bounce-daemon` |
| Production `agents` / `ag` / `browser` | may be replaced | never written by `install.sh` |

```bash
# build + install this working tree, then drive it
bash apps/cli/scripts/install.sh --skip-tests
agents-dev sessions --active

# your everyday CLI is unaffected
agents --version
```

## Plan

- [ ] Rename the dev links to `agents-dev` / `ag-dev` in `install.sh`; drop `browser`
- [ ] Add the `cleanup_legacy_shadow` repair pass ahead of link creation
- [ ] Gate the daemon bounce behind `--bounce-daemon`, defaulting off
- [ ] Simplify the PATH warning to the "not on PATH" case only
- [ ] Update root `AGENTS.md`: table row plus the never-clobber paragraph
- [ ] Correct the "Local dev build" paragraph in `apps/cli/AGENTS.md`
- [ ] Reword the stale premise in `rollout-verify.ts` and `ssh.ts`
- [ ] Add `apps/cli/scripts/install.test.ts`
- [ ] Add the changelog fragment
- [ ] Verify end to end on this box and quote the output

## Validation

New test `apps/cli/scripts/install.test.ts`, in the style of
`apps/cli/scripts/postinstall.test.ts:41-74` — the real script via `spawnSync`,
a temp `HOME`, no mocking:

| Case | Assertion |
| --- | --- |
| Fresh run | `~/.local/bin/agents-dev` and `ag-dev` exist and resolve into the dev prefix |
| Fresh run | none of `agents`, `ag`, `browser` is created |
| Pre-seeded dangling link into the dev prefix | removed |
| Pre-seeded link to an unrelated decoy | left byte-identical (mirrors `postinstall.test.ts:166-190`) |
| Default run | no daemon restart attempted |
| `--bounce-daemon` | `AGENTS_INSTALL_BIN` is the `agents-dev` path |

End to end, on this machine:

```bash
bash apps/cli/scripts/install.sh --skip-tests
ls -la ~/.local/bin/agents ~/.local/bin/ag ~/.local/bin/browser   # gone
agents --version                                                  # 1.22.35
agents-dev --version                                              # 0.0.0-dev.<sha>
agents doctor                                                     # no binary-shadow
pgrep -af __daemon-run                                            # no worktree path
cd apps/cli && bun run test -- scripts/install.test.ts
```

## Risks

| Risk | Mitigation |
| --- | --- |
| Muscle memory: sessions and notes that say "run `agents` after install.sh" | Both AGENTS.md files change in the same PR; `install.sh` prints the `agents-dev` path on completion |
| The repair pass deletes a link the user created by hand | It only removes links whose raw target resolves inside the dev prefix, plus MINGW files carrying the marker; a decoy-target test pins this |
| A box already has a dev-shadowed `agents` and never re-runs `install.sh` | `agents doctor`'s `binary-shadow` finding (RUSH-2431) and the rollout probe (RUSH-2446) still catch it |
| Someone wants the old auto-bounce behavior | `--bounce-daemon` keeps it, one flag away, with the blast radius stated |
| Stale worktree daemon (pid `4163347`) predates this change | Stop it separately during verification; not fixed by the code change alone |

## What the plan missed

Kept honest: three things this plan did not anticipate, each found by the
non-author review or by running the change on a real box.

| Found by | What the plan got wrong |
| --- | --- |
| Review, round 1 | The Windows repair was designed around a marker embedded in the wrapper files. The **pre-rename** MINGW branch wrote its wrappers with no marker at all — it hardcoded the `agents-cli-dev` path — so on the one platform where the shadow is a file rather than a symlink, the repair matched nothing while the docs claimed it was unconditional. Fixed by matching the dev-prefix reference in the file body. |
| Verifying on this box | Removing the shadow left the **systemd unit's `ExecStart` dangling** — it had been pinned to `~/.local/bin/agents` by an earlier revision's daemon bounce. `systemctl` read `active` because the daemon runs from memory; the failure was scheduled for the next restart, when the scheduler, secrets broker, and browser IPC would have gone down silently. The cleanup now checks both manifest formats and prints `agents daemon restart`. |
| Review, round 2 | That new check matched `$LINK_DIR/agents` as a substring, which **also matches `$LINK_DIR/agents-dev`** — so a box with a healthy `--bounce-daemon` manifest plus one stale link was told to restart a working daemon. Fixed by matching the exact removed path, terminated. |

The pattern in all three: the change was correct in the case it was designed for
and wrong in a neighbouring case, and only a run or an adversarial read surfaced
it. Every behavior fix now carries a mutation-checked test.

## Tracking

Extends RUSH-2431 (`binary-shadow` detection) and RUSH-2446 (rollout
verification). No new ticket opened yet — one gets created and paired when this
plan is approved. `apps/cli/scripts/postinstall.js` is explicitly out of scope.

The rendered source lands at `.agents/artifacts/2026-08-10/plan-dev-install-no-shadow.md`
in the implementation worktree and ships with the PR.
