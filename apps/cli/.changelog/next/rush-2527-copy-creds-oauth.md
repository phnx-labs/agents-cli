- **`agents run --host --copy-creds` and `agents run --lease` no longer copy a
  native OAuth / session login to another device (RUSH-2527, breaking for those
  flags).** Both used to serialize each signed-in runtime's rotating login — the
  Claude OAuth token and codex/grok/gemini `auth.json` files — onto a persistent
  host (`--copy-creds`) or an ephemeral leased box (`--lease`) so it booted
  logged-in. A rotating harness login copied across machines is invalidated on its
  next server-side token refresh and logs the rest of the fleet out, and the
  fleet-auth contract forbids it on every device, ephemeral or not
  (`docs/specifications.md` SING-1b). Both now **fail loud** when asked to copy a
  signed-in native runtime and steer to the portable, non-rotating path: create a
  provider account (`agents accounts add`) and push it with `agents accounts sync
  <name> --device <host>` (a policy-`never` bundle, safe to reuse on many devices).
  A profile-dispatch `--lease` run carrying its own portable auth (a BYOK gateway)
  still works; only the native-login copy is refused. Explicit `agents accounts
  sync` and `secrets export --host` are unchanged. Sources:
  `apps/cli/src/lib/hosts/credentials.ts`, `apps/cli/src/lib/crabbox/runtimes.ts`
  (`buildCredentialScript`); shared predicate `isNativeOAuthRuntime`.
