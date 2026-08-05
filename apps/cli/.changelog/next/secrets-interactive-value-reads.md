- **`agents secrets view <bundle> --reveal` now resolves a locked keychain bundle
  interactively at a real terminal.** The command hardcoded `agentOnly: true` on
  both reveal call sites (`commands/secrets.ts`), so an explicit human `--reveal`
  on a locked bundle went through the broker-only path and errored with an unlock
  hint instead of raising the one Touch ID sheet the human just asked for. The
  `agentOnly` flag is now `isHeadlessSecretsContext() || !isInteractiveTerminal()`
  — under an agent (`AGENTS_RUNTIME`) or with no TTY it stays broker-only and
  never prompts, but a deliberate `--reveal` typed at an interactive terminal
  resolves the value with a single biometric sheet. This mirrors the existing
  `reveal && !isInteractiveTerminal()` guard a few lines up. `export --plaintext`
  and `exec` are untouched — they stay intentionally silent for release/CI
  scripts. Source: `apps/cli/src/commands/secrets.ts`.
