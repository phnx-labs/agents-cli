- **Muse login is recognized under `providers.meta` (balanced no longer signed_out).**
  Live `muse login` writes `~/.config/muse/auth.json` as
  `{ schema_version, providers: { meta: { access_token, user_email, … } } }`.
  The presence detector only walked one object level, so it never saw the token
  under `providers.meta` and reported signed-out after a successful OAuth —
  `agents run muse` under balanced then failed with "excluded: 0.1.0
  (signed_out)". Detection now recurses into nested provider slots and surfaces
  `user_email` when present. Source: `apps/cli/src/lib/agents.ts`.
