- **`agents menubar` now works from the Bun single-file binary.** When the CLI runs
  as the compiled Bun executable, `import.meta.url` points inside the virtual
  `/$bunfs/` bundle, so the menu-bar helper couldn't find the shipped
  `MenubarHelper.app` on disk (`bundle source: missing (cannot enable)`) or read its
  own `package.json` (`current version: unknown`, and a perpetual "stale" warning).
  `enable` refused with "no menu-bar helper bundle ships with this install." Version
  and bundle resolution now fall back to the real on-disk install, located by
  following the `agents` launcher symlink, so `enable`/`disable`/`status` behave the
  same whether the CLI runs under Node or the Bun binary. Source:
  `apps/cli/src/lib/version.ts`, `apps/cli/src/lib/menubar/install-menubar.ts`.
