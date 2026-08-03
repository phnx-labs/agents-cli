- **`agents secrets status` says `hold`, not the retired `daily`.** The policy
  rename (1.20.79) missed two lines in the one command users run to answer "why
  did it prompt again": the hold-window header still read "a daily bundle prompts
  once…", and the empty-broker line "the next read of each daily bundle…".
  `daily` is an accepted input alias but is no longer a name the CLI's own help
  or `secrets list` POLICY column uses, so the diagnostic surface named a policy
  its sibling commands don't. Both lines now say `hold`, and the header is a pure
  `renderHoldSummary()` pinned by a test so the vocabulary can't drift again.
  Source: `apps/cli/src/commands/secrets.ts`.
