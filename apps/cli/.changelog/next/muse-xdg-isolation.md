- **Muse multi-version isolation matches Claude/Codex (XDG pin, not bare symlink).**
  Claude/Codex isolate per version with `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.
  Muse has no dedicated config env; it reads `$XDG_CONFIG_HOME/muse` and
  `$XDG_DATA_HOME/muse`. After `agents import muse`, `~/.config/muse` is a
  symlink into the version home — Muse refuses that path with
  `Agent Definition filesystem source failed: SymlinkOrReparse` and exits 1
  (the Zion `agents run muse@0.1.0` failure). Managed launches now pin
  `XDG_CONFIG_HOME` + `XDG_DATA_HOME` into the version home from `buildExecEnv`,
  the main shim, and versioned aliases (`muse@0.1.0`), the same way Claude pins
  `CLAUDE_CONFIG_DIR`. Muse is also listed in `CONFIG_ENV_ISOLATED_AGENTS` so
  `--isolated` installs are honest. Source: `apps/cli/src/lib/{exec,shims}.ts`.
