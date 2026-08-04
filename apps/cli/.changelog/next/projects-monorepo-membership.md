- **Two projects sharing one monorepo checkout are no longer indistinguishable.** Session,
  activity, and feed attribution anchored a project on `root ?? defaultPath`, so a subproject
  whose `root` is the monorepo and whose `defaultPath` is a subdir collapsed onto the same
  path as its umbrella — the longest-match tiebreak had nothing to separate them, and work in
  `rush/apps/cli` counted toward whichever definition happened to be listed first. A
  `defaultPath` nested under `root` is now the membership claim (the root says where the
  checkout is; `defaultPath` says which work is this project's), and each bound repo's
  checkout and subpath anchor too. Source: `apps/cli/src/lib/projects.ts`.
