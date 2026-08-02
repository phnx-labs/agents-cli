- **`agents setup fleet` now guides Tailscale device onboarding (RUSH-2000).**
  The setup command registers a new `fleet` capability wizard that verifies
  Tailscale, syncs discovered devices through the existing `agents devices sync`
  path, applies SSH auth with `agents devices set`, optionally writes the
  managed SSH config include, tests connectivity with `agents ssh <device>
  uname`, and can run `agents fleet update` after registration. Source:
  `apps/cli/src/commands/setup-fleet.ts`, `apps/cli/src/commands/setup.ts`.
