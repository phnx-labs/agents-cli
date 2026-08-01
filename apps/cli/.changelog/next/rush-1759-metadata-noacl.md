- **No more Touch ID prompt on every new agent session.** Bundle metadata (names,
  descriptions, variable names + references, and non-sensitive `--value` literals)
  is now stored WITHOUT the biometry ACL at every prompt-policy tier, not just
  `never`. Metadata is non-sensitive by contract — real secret values live in
  separate `agents-cli.secrets.*` items that keep the bundle's policy ACL — so
  enumerating bundles no longer needs a keychain unlock. This kills the recurring
  Touch ID prompt that fired on every new Claude/agent terminal: a SessionStart
  hook runs `agents devices list`, which scans bundle metadata through crabbox, and
  that scan used to pop Touch ID once per broker window (~7 days) on every cold
  launch. `agents secrets list` is now silent too. Reading a bundle's actual
  values (run injection, `view --reveal`) still prompts. Existing bundles are
  migrated automatically and once: the first metadata scan after upgrade re-homes
  each bundle's metadata item no-ACL (reusing the read it already did, so it adds
  no extra prompt), and every scan after that is prompt-free. Source:
  `apps/cli/src/lib/secrets/bundles.ts`, `apps/cli/src/lib/secrets/index.ts`.
