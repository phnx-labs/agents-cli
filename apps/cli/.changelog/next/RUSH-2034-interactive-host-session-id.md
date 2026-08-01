- **Interactive `agents run --host` now tracks the real session for every agent,
  not just Claude.** Codex, Kimi, Grok, and Gemini coin their own session id and
  reject a caller-supplied one, so an interactive host run of any of them showed a
  stale/absent id locally — `agents sessions` couldn't surface it and a dropped
  link couldn't auto-reconnect it (RUSH-2033 fixed only the Claude `--session-id`
  path). The launcher now forwards one correlation key it controls
  (`AGENT_LAUNCH_ID`); the remote `agents run` adopts that key
  (`resolveLaunchId`), so its SessionStart hook records the agent's real session id
  under it. After the stream the launcher does one ssh read of the remote hook
  record, resolves the real id by launch id (`resolveRemoteSessionId` /
  `pickRemoteSessionId`), registers it in the local session index, and reconnects
  against it on a dropped link. Claude still forces its own id up front and is
  unchanged. Source: `apps/cli/src/lib/hosts/remote-session-id.ts`,
  `resolveLaunchId` in `apps/cli/src/lib/exec.ts`, and the interactive `--host`
  branch in `apps/cli/src/commands/exec.ts`. (RUSH-2034)
