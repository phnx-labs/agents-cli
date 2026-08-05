- **`secrets list` enumeration never pops Touch ID (SEC-14).** The signed keychain
  helper's `list` data-protection pass swept every DP item with the default
  `kSecUseAuthenticationUIAllow`, so a `kSecMatchLimitAll` enumeration evaluated a
  biometry-ACL'd value item's ACL and showed a real Touch ID sheet on every call — a
  prompt storm, since `secrets list` runs constantly (bundle resolution, the menubar
  device poll, the watchdog). It is now `kSecUseAuthenticationUISkip`: the no-ACL
  bundle metadata (all the listing needs — bundle names come from the metadata, never
  the value items) still returns, ACL'd value items are silently skipped, and no sheet
  is shown. This read is below the `AGENTS_SECRETS_NO_PROMPT` / `agentOnly` guard, so
  SEC-13 (#1942) did not cover it. One narrow behavioral trade: a legacy bundle whose
  *metadata* item still carries a stray biometry ACL (pre-RUSH-1759, before the
  one-time no-ACL heal) is now silently skipped by `list` rather than prompted-then-
  shown; it still resolves and self-heals when read by name. Source:
  `apps/cli/src/lib/secrets/keychain-helper.swift`.
