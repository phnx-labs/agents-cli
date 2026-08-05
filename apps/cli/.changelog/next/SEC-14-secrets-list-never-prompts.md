- **`secrets list` enumeration never pops Touch ID (SEC-14).** The signed keychain
  helper's `list` (and `list-synced`) data-protection pass swept every DP item with
  the default `kSecUseAuthenticationUIAllow`, so a `kSecMatchLimitAll` enumeration
  evaluated a biometry-ACL'd value item's ACL and showed a real Touch ID sheet on
  every call — a prompt storm, since `secrets list` runs constantly (bundle
  resolution, the menubar device poll, the watchdog). It is now
  `kSecUseAuthenticationUISkip`: the no-ACL bundle metadata (all the listing needs)
  still returns, ACL'd value items are silently skipped, and no sheet is shown. This
  was below the `AGENTS_SECRETS_NO_PROMPT` / `agentOnly` guard, so SEC-13 (#1942) did
  not cover it. Source: `apps/cli/src/lib/secrets/keychain-helper.swift`.
