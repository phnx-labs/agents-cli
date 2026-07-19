- **`agents fork` — branch a session into a new independent copy.** Copies a Claude
  session transcript to a fresh session id (rewriting only the `sessionId` field so the
  per-message uuid chain stays intact) beside the original, then registers it so it
  resumes independently from the same cwd and version — the original is left untouched.
  `--name` labels the fork. Source: `apps/cli/src/lib/session/fork.ts`,
  `apps/cli/src/commands/fork.ts`.
