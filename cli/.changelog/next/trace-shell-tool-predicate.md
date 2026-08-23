---
type: fix
---

`agents sessions trace` now recognizes a session's shell steps consistently across every surface. The "is this tool a shell command?" test lived as six hand-synced copies that had drifted apart — the tool-call indexer treated Codex's `exec`/`execute`/`run_command` as shell, but the trajectory model, the directory-touched scan, and both the HTML and stream renderers each used a narrower or differently-cased list. They now share one case-insensitive `isShellExecTool` predicate (`shell-programs.ts`), so a Codex or Droid shell step is colored, program-resolved, and counted the same as Claude's `Bash` everywhere the trace reads it.
