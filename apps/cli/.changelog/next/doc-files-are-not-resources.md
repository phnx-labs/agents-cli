- **A `README.md` / `AGENTS.md` sitting in a resource directory is no longer
  installed as a resource.** `listResources` skipped only dotfiles, so every `.md`
  beside the actual resources was materialized as one: `commands/README.md` — which
  the system repo has shipped for months — installed a bogus `/README` slash command
  into every agent home, and adding per-directory `AGENTS.md` docs would have added
  `/AGENTS`, `/CLAUDE`, and `/GEMINI` alongside it. `README`, `AGENTS`, `CLAUDE`, and
  `GEMINI` are now filtered from both `listResources` and `resolveResource` for every
  kind **except `rules`**, where `AGENTS.md` *is* the resource (the composed ruleset
  that syncs as each agent's memory file). The check tests `!entry.isDirectory()`
  rather than `isFile()`, because a `Dirent` for a symlink reports
  `isFile() === false` and `CLAUDE.md`/`GEMINI.md` are symlinks to `AGENTS.md` by
  convention — a resource *directory* named `agents/` is still a real resource.
  Verified against the real installed layers: 30 commands with `README` leaking
  before, 29 with none after.
- **`agents commands add/remove/view` no longer suggest `README` as the example
  command name.** With `README` reserved as a directory doc, the six hardcoded
  examples in the help text and non-interactive hints named a command that can never
  exist. They now use `plan`, which actually ships.
