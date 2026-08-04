- **Two projects sharing one monorepo checkout are no longer indistinguishable.** Session,
  activity, and feed attribution anchored a project on `root ?? defaultPath`, so a subproject
  whose `root` is the monorepo and whose `defaultPath` is a subdir collapsed onto the same
  path as its umbrella — the longest-match tiebreak had nothing to separate them, and work in
  `rush/apps/cli` counted toward whichever definition happened to be listed first. A
  `defaultPath` nested under `root` now takes precedence over that `root` (the root says where
  the checkout is; `defaultPath` says which work is this project's), and each bound repo's
  checkout and subpath anchor too. A narrowed `root` still covers the rest of its checkout as
  a fallback, so a lone project defined with `--path` keeps attributing work across its own
  repo instead of only inside the subdir. Source: `apps/cli/src/lib/projects.ts`.
