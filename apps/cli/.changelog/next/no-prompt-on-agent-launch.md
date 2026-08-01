- **An agent launch never raises a Touch ID sheet.** On macOS, starting an agent
  terminal or firing a routine could pop several biometric prompts in a row, because
  each keychain read runs in its own helper process and the biometric assertion never
  reuses across processes. Two causes: `interactiveUnlock` defaulted to true whenever
  an agent name was present, which let an agent-initiated read fall through the
  `agentOnly` guard; and `isHeadlessSecretsContext` recognized the `headless` and
  `teams` runtimes but not `terminal`, which is what an interactive run sets. Agent
  launches now resolve broker-only and a locked bundle fails fast naming
  `agents secrets unlock <bundle>`; `AGENTS_SECRETS_NO_PROMPT=1` is no longer needed
  as a workaround. A human-typed `agents secrets get/export/exec` still prompts —
  those pass `interactiveUnlock: true` explicitly. This narrows the agent-triggered
  approval added in RUSH-2032, which is unreleased.
