- **Helper binaries no longer download through a repository-rename redirect.**
  `HELPER_RELEASE_REPO` still named `phnx-labs/agents-cli` after the repository was renamed
  to `phnx-labs/agi-cli`. Nothing was broken — GitHub redirects a renamed repo, and both
  slugs returned HTTP 200 — but every signed helper asset (`MenubarHelper.app.zip`,
  `Agents_CLI.app.zip`, `ComputerHelper.app.zip`, `computer-helper-win.exe`) was resolving
  through that redirect, which is one re-created repository away from pointing elsewhere.
  What actually protects the download is the sha256 + `codesign` + designated-requirement +
  Team ID verification in `helper-download.ts`; this removes the reliance on the redirect.
  The `agents.yaml` `$schema` URL, the CHANGELOG link, the star nudge, and the
  `package.json` repository/issues metadata moved with it.
  **The npm package name is deliberately unchanged** — it is still
  `@phnx-labs/agents-cli`, and renaming it would orphan every installed CLI. That
  distinction is now pinned by a test. Source: `cli/src/lib/helper-download.ts`.
  `publish-computer-helper-mac.sh` carried the old slug too, and that one is a **write**
  path: `REPO_SLUG` reaches `gh release view` (the immutability guard), `gh release create`,
  and `gh release upload --clobber`. Publishing signed helper binaries was going through the
  rename redirect. Found by sweeping `scripts/` and `.github/` after the source tree was
  already clean — the source sweep alone would have missed it.
  Three further live paths carried the old slug and were missed by the first sweep:
  `ssh-tunnel.ts:170` `WIN_HELPER_RELEASE_REPO` (a **separately hardcoded** constant — the
  download URL for `computer-helper-win.exe`, the fourth signed asset, which the first
  version of this change claimed to cover and did not); `commands/feedback.ts:14`, which
  opens real GitHub issues; and `factory/snapshot.ts:30`, which polls this repo's PRs.
  `installations/migrate.ts` also wrote the old URL into the `agents.yaml` header it
  generates. Separately, `.github/workflows/tests-windows-host-e2e.yml:54` gated on
  `github.repository == 'phnx-labs/agents-cli'`, which is permanently false after a rename
  — that job had silently stopped running on every push to main and on its daily cron.
