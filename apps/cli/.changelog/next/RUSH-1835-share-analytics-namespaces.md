- **Per-user URL namespaces + privacy-first analytics for `agents share` (RUSH-1835).**
  Shares now publish under the publisher's GitHub username (`share.agents-cli.sh/<user>/<slug>`),
  with `/<user>` rendering a public gallery and legacy flat slugs still resolving. Every HTML
  publish also injects a cookieless Cloudflare Web Analytics beacon (opt out with
  `--no-analytics`). Configure the token during `agents share setup --analytics-token`, and
  check status with `agents share status` / `agents share analytics`. Source:
  `apps/cli/src/commands/share.ts`, `apps/cli/src/lib/share/{publish,analytics,worker-template}.ts`,
  `apps/cli/src/lib/git.ts`, `apps/cli/docs/share.md`.
 
 
