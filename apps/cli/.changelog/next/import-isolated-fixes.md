- **`agents import --isolated` no longer misdescribes itself, chokes on codex, or copies
  your session history.** Three defects found by using it: (1) the confirmation summary
  printed `config: ~/.codex (will be moved into version home)` even under `--isolated` —
  announcing the exact adoption the flag exists to prevent, though the code correctly
  copied; it now reads `will be COPIED — your original stays put`. (2) Seeding failed
  outright for codex with `Cannot overwrite non-directory`, because its version home is a
  SUN_LEN-safe symlink to `~/.agents/.codex-homes/<version>/.codex` rather than a real
  directory; the seeder now follows the link and writes the home the agent actually reads.
  (3) The seed copied the whole config dir including sessions, logs, caches and sqlite —
  757MB on a real machine, 349MB of it `sessions` — so runtime state is now skipped and
  reported (33MB for the same install), with `--all` to include it. Also skips the config
  copy when `~/.<agent>` is itself a managed symlink, which is another version's home
  rather than the user's real settings. Source: `apps/cli/src/lib/import.ts`,
  `apps/cli/src/commands/import.ts`.
