- **A starved `coreauthd` can no longer hang `secrets list` forever (RUSH-2233).**
  The keychain helper's `list` runs two passes, and the data-protection pass omits
  `kSecUseAuthenticationUI: …Fail` on purpose (that flag drops every biometry-ACL
  item even when authentication is healthy). Omitting it means the query still
  reaches LocalAuthentication/`coreauthd`, which has no deadline of its own — a
  wedged `coreauthd` left `SecItemCopyMatching` blocked for the life of the
  process. That is *why* helpers accumulated for the bounded-spawn + reaper work
  in RUSH-2231/2232 to clean up. The pass now runs on a background thread behind
  a 3-second wait: on timeout the helper logs one line to stderr, skips the pass,
  and prints whatever the file-keychain pass produced — the same handling the
  screen-locked `errSecInteractionNotAllowed` case already got. Set
  `AGENTS_KEYCHAIN_LIST_TIMEOUT_MS` to override the deadline;
  `AGENTS_KEYCHAIN_BOUNDED_TEST=1` runs the helper's headless self-test for the
  bounded wait. Source: `apps/cli/src/lib/secrets/keychain-helper.swift`.
