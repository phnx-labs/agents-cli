- **`agents run <agent>` no longer hangs when launched headless without a prompt.**
  A run with no prompt and no explicit `--interactive` resolves to interactive
  intent — but in a non-TTY shell (a headless agent, a pipe, CI) there is no
  terminal to host the REPL, so it attached a TUI to dead stdin and hung forever.
  It now fails fast with the headless alternatives (`agents run <agent> "<task>"`
  or `agents run <agent> --headless` to read the prompt from stdin). An explicit
  `--interactive` is still honored. Source: `apps/cli/src/commands/exec.ts`,
  `apps/cli/src/lib/exec.ts` (`inferredInteractiveWithoutTty`). (RUSH-1829)
