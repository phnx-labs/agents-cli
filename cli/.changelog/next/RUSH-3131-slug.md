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
