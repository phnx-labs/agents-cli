- **An agent launch never raises a Touch ID sheet.** On macOS, starting an agent
  terminal or firing a routine could pop several biometric prompts in a row. Two
  causes: `interactiveUnlock` defaulted to true whenever an agent name was present,
  which made `agentOnly: true` a no-op for every agent-initiated read (no caller
  ever passed the flag, so the default *was* the behavior); and
  `isHeadlessSecretsContext` recognized the `headless` and `teams` runtimes but not
  `terminal`, which is what an interactive run sets. Because each keychain read runs
  in its own helper process, the biometric assertion never reuses, so one launch
  meant one sheet per bundle. Agent launches now resolve broker-only and a locked
  bundle fails fast naming `agents secrets unlock <bundle>`; `AGENTS_SECRETS_NO_PROMPT=1`
  is no longer needed as a workaround. An explicit `interactiveUnlock: true` caller
  can still raise the sheet on purpose.
