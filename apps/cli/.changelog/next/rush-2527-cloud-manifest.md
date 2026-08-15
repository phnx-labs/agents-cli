- **`agents cloud run` (Rush) never reads or uploads a native Claude OAuth login
  (RUSH-2527, SING-1b, breaking).** Two changes: (1) the account manifest sent on
  every non-balanced dispatch no longer includes a `cred_fp` hash computed by
  reading each Claude version's OAuth token — it carries **version + account email
  only**; (2) the token-upload retry path is **removed entirely** — the
  `--upload-account-tokens` flag, the `AGENTS_RUSH_UPLOAD_TOKENS` env var, the
  recorded consent file, and `buildAccountTokensPayload` are gone. There is no
  consented way to copy a rotating harness login to the cloud (it would be
  invalidated on its next refresh and log the fleet out). When Rush Cloud asks for
  a token (a new account or a rotation), dispatch now **fails loud** and steers to a
  portable provider account: `agents accounts add <name> --provider anthropic --auth
  api-key` (or `setup-token`), then dispatch under that account. Source:
  `apps/cli/src/lib/cloud/rush.ts`, `apps/cli/src/commands/cloud.ts`.
