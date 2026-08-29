- Fix the `agents-cli` discovery skill/plugin install commands to use the real GitHub
  repo path `phnx-labs/agi-cli` (they pointed at `phnx-labs/agents-cli`, which only
  resolved via GitHub's rename redirect). The npm package stays `@phnx-labs/agents-cli`.
  Also maps the plugin manifests + skill to `agents-cli-plugin.test.ts` in CI impact
  analysis so a manifest/skill edit runs its test on the PR. (PHNX-3337 review follow-up)
