- **Bash-command summaries are faster and recognize more of what actually ran (#1830).**
  `classifyBashCommand` (behind `agents sessions` / `agents activity` summaries) tokenized
  the *entire* command — every pipeline segment, multi-KB heredoc bodies included — just to
  read the leading executable, costing up to ~1ms on a big `cat <<HEREDOC …`. It now
  tokenizes only the head of the first simple command. Coverage gaps that dumped commands
  into a raw `other` pile are closed too: a `cd` prefix separated by `;` or a newline (not
  just `&&`) unwraps to the real command, a path/tilde executable
  (`~/.agents/skills/linear/scripts/linear`) resolves by basename, and the repo's own
  toolchain (`agents`, `linear`, plus `rmdir`) is recognized — `agents` was the single top
  unrecognized token. `ag` stays the silver searcher, not an `agents` alias. Source:
  `apps/cli/src/lib/session/bash-command.ts`.
