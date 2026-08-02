- **Codex can now build, test, and install without escalating to YOLO.** Codex's
  `workspace-write` sandbox blocks `$HOME`, so `cargo build`, `go build`, `npm/bun install`,
  `pip install` etc. failed on their out-of-workspace cache writes (`~/.cargo`, `GOCACHE`,
  `~/.npm`, `~/.cache`, …) — which is what pushed people to `--mode full`
  (`--dangerously-bypass-approvals-and-sandbox`). agents-cli now writes a platform-resolved
  baseline of **regenerable toolchain caches** into Codex's `config.toml`
  (`[sandbox_workspace_write].writable_roots`) on permission sync — `~/.cargo`, `~/.rustup`,
  `~/.npm`, `~/.bun`, `~/go`, `~/.deno`, `~/.gradle`, `~/.m2`, `~/.gem`, plus `~/Library/Caches`
  + `~/Library/pnpm` on macOS or `~/.cache` + `~/.local/{share,state}` on Linux. Credential dirs
  (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/.netrc`) are deliberately excluded, so
  `--mode auto` stays a real sandbox — far narrower than danger-full-access. Any
  `writable_roots` you set yourself are preserved (unioned, never clobbered). Source:
  `apps/cli/src/lib/permissions.ts` (`codexDefaultWritableRoots`, `mergeCodexSandboxWrite`).
