- **`agents devices` no longer forces a Touch ID prompt on a password-auth box
  (RUSH-1970).** The read-only stats probe's live SSH to an uncached
  `auth.method === 'password'` device used to drive the askpass shim to resolve
  the SSH password through the biometry-gated Keychain sheet under a TTY, popping
  Touch ID during what should be a silent probe. The probe now threads a
  broker-only signal (`AGENTS_SSH_AGENT_ONLY`) so it resolves from an
  already-unlocked broker or degrades to an unreachable row — never a biometric
  prompt. Source: `apps/cli/src/commands/ssh.ts`,
  `apps/cli/src/lib/devices/health.ts`, `apps/cli/src/lib/devices/connect.ts`.
