- **`agents publish --branch <b>` now pushes the index to `<b>`, not just the printed URL (#1061).**
  The flag rewrote the printed `raw.githubusercontent.com/.../<b>/skills-index.json`
  URL, but the commit still landed on the checked-out branch — so `--branch dev` from a
  `main` checkout published the index to `main` while advertising a `dev` URL that didn't
  resolve. `commitAndPush` now takes an optional target branch and pushes
  `<current>:<target>`, reporting back the branch the index actually landed on so the URL
  references it. Omitting `--branch` still publishes to the repo's current branch.
  Source: `apps/cli/src/lib/git.ts` (`commitAndPush`, `pushOrigin`, `getCurrentBranch`),
  `apps/cli/src/commands/packages.ts`.
