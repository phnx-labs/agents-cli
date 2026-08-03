- **`agents setup secrets --policy hold` no longer fails, and `agents secrets
  status` stops naming the retired `daily` policy.** The 1.20.79 `daily` → `hold`
  rename swept the help, docs, and the `secrets list` POLICY column, but two
  surfaces were never migrated. The worse one was functional: the onboarding
  wizard carried its own copy of the policy vocabulary, so
  `agents setup secrets --policy hold` — the canonical name every other secrets
  command prints — exited with `Invalid --policy 'hold'. Use daily, always, or
  never.`, and its interactive prompt still offered `daily` as the default
  choice. It now shares `parsePolicyOpt` with `agents secrets policy`, so the two
  commands can't disagree about what a policy is called; `daily`/`session` stay
  accepted as aliases and the wizard's default is unchanged (the hold tier). The
  second was cosmetic: `agents secrets status` printed "a daily bundle prompts
  once…" and "the next read of each daily bundle…" — the one command a user runs
  to answer *why did it prompt again*, naming a policy its sibling commands no
  longer emit. Both lines now say `hold` and are pure values pinned by tests, so
  the vocabulary can't drift again. Source:
  `apps/cli/src/commands/setup-secrets.ts`, `apps/cli/src/commands/secrets.ts`.
