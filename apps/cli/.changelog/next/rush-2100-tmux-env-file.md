- **Resolved secrets no longer appear in `ps` for tmux-launched agents
  (RUSH-2100).** An interactive `agents run` wraps the agent in tmux via
  `exec env K=V … <agent>`, which put the entire exec env — every resolved
  secrets-bundle value — into the pane's command line, readable by any process of
  the same user. On one fleet box six live processes carried
  `AGENTS_SECRETS_PASSPHRASE`, the key that decrypts every file-backed bundle on
  that machine. The pane now sources a `0600` env file and unlinks it before
  `exec`, so only the file path is argv-visible; a missing file aborts the pane
  rather than launching half-configured. Every key routes through the file, not a
  curated "secret-bearing" subset, so a newly added credential is covered without
  anyone maintaining a list. Source: `apps/cli/src/lib/exec.ts`,
  `apps/cli/docs/specifications.md` (SEC-8a).
