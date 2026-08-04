- **Balanced rotation no longer picks version homes that only inherit the active login.**
  `getAccountInfo` falls back to the active/global HOME credential so `agents view`
  still shows who is signed in when a version home has no auth file of its own.
  Launch paths isolate config (`GROK_HOME`, `CODEX_HOME`, …) to the per-version home,
  so those empty homes died at spawn with "Not signed in" after balanced picked them
  (observed: `grok@0.2.118` with no `auth.json` looking signed-in via `~/.grok` →
  `0.2.32`). Rotation now requires a real per-version credential when we know where
  it lives (`credentialPresence.perVersion`). Source: `src/lib/rotate.ts`
  (`isLaunchableSignedIn`, `collectRunCandidates`).
