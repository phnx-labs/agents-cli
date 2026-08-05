- **`agents secrets exec <bundle> -- <cmd>` now resolves a locked keychain bundle
  interactively at a real terminal.** The local resolve hardcoded `agentOnly: true`
  (`commands/secrets.ts`), so running `exec` on a locked bundle at a terminal
  failed closed with "run `agents secrets unlock` first" instead of raising the one
  Touch ID sheet the human just implied by asking to use the values. It now gates
  `agentOnly` on `isHeadlessSecretsContext() || !isInteractiveTerminal()`: an
  unlocked bundle still runs silently, a locked bundle at an interactive terminal
  resolves with a single sheet and then runs the command with the secrets injected,
  and under an agent (`AGENTS_RUNTIME`) or headless (no TTY) it stays broker-only —
  release/CI scripts never prompt. Mirrors the same fix for `view --reveal`.
  `--host` remote resolves and `export`/`get` are unchanged. Source:
  `apps/cli/src/commands/secrets.ts`.
