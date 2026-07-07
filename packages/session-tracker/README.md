# @agents/session-tracker

> Per-agent SessionStart hook + descendant-pid lookup. One state-file format for
> every coding-agent CLI.

When a coding agent (Claude, Codex, Cursor, Grok, Gemini, Antigravity, …) starts,
each harness fires its own native `SessionStart` hook with its own payload shape.
This package is a **polyglot hook** that normalizes all of them into a single
state file, plus the lookup helpers to find "which live session is running in this
terminal / under this pid."

It is the **writer** side of live-session tracking. The reader that consumes these
files is the VS Code extension (`apps/factory/src/core/liveSession.ts`). This is a
**different** surface from the CLI's `agents sessions` command
(`apps/cli/src/lib/session/`), which parses agent transcript logs, not these state
files — don't conflate the two.

## What it writes, where, and when

On each agent's `SessionStart` event, `src/hook.sh` drops one JSON file:

```
~/.agents/.cache/terminals/sessions/<agent-pid>.json
```

```jsonc
{
  "session_id": "…",     // parsed per-agent (stdin JSON key, or env var)
  "agent": "claude",
  "cwd": "/path",
  "pid": 12345,
  "terminal_id": "…",    // from $AGENT_TERMINAL_ID, if set
  "launch_id": "…",      // from $AGENT_LAUNCH_ID, if set
  "ts": 1730000000000,
  "method": "hook-stdin" // | hook-env | fs-watch | stdout-banner
}
```

Writes are atomic (`mktemp` + `mv`). Per-agent payload parsing lives in `hook.sh`:
`claude`/`codex` read `session_id` from stdin JSON; `cursor` tries
`session_id`/`conversation_id`; `grok` reads `$GROK_SESSION_ID` from env;
`gemini`/`antigravity` try several stdin keys.

## Public API

```ts
import { trackSpawn, getLiveSession, findStateByPid, descendantPids } from '@agents/session-tracker';

// Poll for the state file a just-spawned agent will drop (default 5s timeout).
const res = await trackSpawn({ shellPid, agent, ... });   // → { confidence: 'high' | 'low', ... }

// Look up the live session for a terminal, by launchId → terminalId → pid tree walk.
const state = await getLiveSession({ launchId, terminalId, shellPid });
```

Also exported: `findStateInTree`, `findStateByTerminalId`, `findStateByLaunchId`,
`pruneStaleSessionState`, plus the writer (`recordSession`, `clearSession`) and
state-file helpers (`serializeState`, `parseState`, `writeStateAtomic`).

## Installing the hook

```bash
bun run install-hook claude            # register the hook in ~/.claude/settings.json
bun run install-hook claude codex cursor grok
```

`install-hook.ts` writes into each harness's native config (Claude
`settings.json`, Codex/Cursor `hooks.json`, Grok `hooks/session-start.json`) and is
**idempotent** — prior registrations of this package's `hook.sh` are stripped first.

## Build & test

```bash
bun install
bun run build          # tsc → dist/
bun test               # vitest
bun run test:cold-spawn  # 50-iteration reliability test (≥99% match, P95 < 1s)
```

The `files` allowlist ships `dist/` + `src/hook.sh` (the hook must be a real file
on disk for harnesses to exec it).
