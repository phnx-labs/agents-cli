- **`agents run codex` can now reach the fleet from inside its sandbox.** Codex's
  `workspace-write` sandbox blocks `$HOME` (verified against the live CLI and OpenAI's
  sandbox docs), but the model routinely shells out to `agents ...`, whose runtime state
  lives under `~/.agents` — the SSH askpass shim (`~/.agents/.cache/devices/askpass.sh`),
  the device/stats cache, secrets, session writes, config tunings. Those inner writes hit
  `EROFS` (`agents ssh` died before connecting, so a remote `agents run codex` could not
  SSH or self-tune), and the fix was previously left to the caller (teams pass
  `--add-dir ~/.agents` explicitly; a plain `agents run` never did). `buildExecCommand`
  now grants `~/.agents` as an extra writable root whenever Codex runs `workspace-write`
  (`--mode edit`/`auto`) — via `--add-dir` on fresh runs (deduped against user
  `--add-dir`s) and via `-c sandbox_workspace_write.writable_roots` on resume forms (which
  reject `--add-dir`). This is the officially-recommended way to widen scope "without
  removing the sandbox entirely" — far narrower than `--mode skip` (danger-full-access).
  `plan` (read-only) and `skip` (sandbox already dropped) are unaffected. Source:
  `apps/cli/src/lib/exec.ts` (`buildExecCommand`, `codexWritableRootsConfig`).
