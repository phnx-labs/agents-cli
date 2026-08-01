- **Actor provenance now survives the SSH hop.** A run dispatched to another host
  (`agents run --host`, a remote `agents teams` supervisor, or any `--host`
  passthrough) used to drop the resolved actor at the SSH boundary, so the remote
  re-resolved it from the *originating* box's `SSH_CONNECTION` and mis-credited the
  work to the shared machine or `UNRESOLVED@<host>`. The dispatch layer now forwards
  `AGENTS_ACTOR*` / `GIT_*` across the wire (POSIX `export` and Windows `$env:`
  alike), so the remote inherits the origin identity instead of re-resolving. A
  caller-supplied env value still wins on collision (mirrors `buildExecEnv`).
  Source: `withActorEnv` in `apps/cli/src/lib/hosts/dispatch.ts`, wired into
  `launchDetached` / `runInteractiveOnHost` and the `--host` passthrough. (RUSH-2028)
