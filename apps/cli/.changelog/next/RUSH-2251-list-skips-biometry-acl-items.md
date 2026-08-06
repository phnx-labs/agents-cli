- **`secrets list` no longer skips every biometry-ACL'd item, so `hold`/`always`-policy
  bundles are readable again (RUSH-2251).** A regression first shipped in v1.22.10 added
  `kSecUseAuthenticationUI: kSecUseAuthenticationUISkip` to the keychain helper's `list`
  data-protection pass. `UISkip` makes `SecItemCopyMatching` silently omit every item
  protected by a biometry access control — which is exactly the value items `set` writes —
  so enumeration returned only the no-ACL metadata and `never`-policy items. Every consumer
  that builds its keychain read set from that enumeration (`secrets exec`/`get`/`unlock`/
  `view --reveal`/`export`, `agents run --secrets`, `ssh`, `browser`, `share`) then reported
  the real secrets as `stored item '…' not found`, and `unlock` could not even warm the
  broker to work around it. The DP pass is now attributes-only with **no** `kSecUseAuthenticationUI`
  key: `kSecReturnAttributes` without `kSecReturnData` never evaluates the ACL, so it
  neither prompts for Touch ID nor filters the ACL'd items out — restoring the design the
  code comment already described. The RUSH-2233 timeout bound on that pass is unchanged.
  Source: `apps/cli/src/lib/secrets/keychain-helper.swift`.
