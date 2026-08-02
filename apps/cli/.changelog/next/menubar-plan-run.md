- **The Cmd+Shift+O quick-dispatch bar is now Plan / Run, and never runs an agent
  in your home directory.** The two spotlight modes were renamed from File
  Ticket / Fix to **Plan** (investigate → file a Linear ticket) and **Run**
  (headless `agents run`). A new repo dropdown is populated from your recent
  session working directories with `$HOME` dropped, and the pick is passed as
  `--cwd` to both modes, so an agent is always scoped to a real repo instead of
  the too-broad home dir; the last-picked repo is remembered. Run now always uses
  `--strategy balanced` (auto load-balance across signed-in versions with
  headroom, skipping rate-limited), and `--name` is seeded from a slug of your
  task text instead of an opaque `quick-<timestamp>`. Source:
  `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/AgentsCLI.swift`.
