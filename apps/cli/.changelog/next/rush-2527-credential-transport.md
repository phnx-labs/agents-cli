- **Credential pushes now ride a hardened SSH posture: pinned host keys + no
  connection reuse (RUSH-2527).** Every `agents secrets` operation that moves
  credential bytes across the fleet — `agents accounts sync <name> --device`,
  `agents secrets export <bundle> --host`, `agents fleet apply
  --provision-secrets`, and a remote bundle resolve (`run --secrets b@host` /
  `secrets exec --host`) — now verifies the destination against the CLI-managed
  known_hosts store (a **changed** host key is refused) and never leaves a reusable
  60s SSH `ControlMaster` socket behind that an unrelated later `agents` invocation
  could silently reuse. This matches the posture the `--copy-creds` dispatch
  already used, extended to the explicit provider-account and secrets-export
  transports. Read-only browse calls (`secrets list --host`) are unaffected and
  keep the fast multiplexed baseline. Source:
  `apps/cli/src/lib/secrets/remote.ts` (`credentialTransportSshOpts`),
  `apps/cli/src/lib/secrets/push.ts`.
