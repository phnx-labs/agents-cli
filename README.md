# agents-cli — monorepo

Phoenix Labs OSS. This repo houses the CLI, the Factory GUI, native helper daemons,
and shared libraries. Each package installs and builds independently.

```
apps/
  cli/          @phnx-labs/agents-cli — the CLI (published to npm)
                  └─ menubar/  native macOS menu-bar helper (ships in the CLI tarball)
  factory/      the Factory GUI — VS Code extension + React UI + Electron desktop app
packages/
  session-tracker/   @agents/session-tracker — SessionStart hook + pid-lineage lib
  swarmify-mirror/   frozen legacy @swarmify shim (do not update)
native/
  computer-mac/      macOS accessibility/screenshot daemon (Swift)
  computer-win/      Windows accessibility/screenshot daemon (C#)
```

## Build

Each package is self-contained (no JS workspaces):

```bash
# CLI
cd apps/cli && bun install && bun run build && bun run test

# Factory GUI
cd apps/factory && bun install && bun run compile

# Native daemons (built from source, not shipped in the CLI tarball)
./native/computer-mac/scripts/build.sh debug
```

The full contributor/design guide lives in [`apps/cli/README.md`](apps/cli/README.md) and
[`docs/`](docs/README.md); repo memory is in [`AGENTS.md`](AGENTS.md).
