# Contributing to agents-cli

Thanks for your interest in contributing. This guide covers the setup, conventions, and PR process.

## Setup

```bash
git clone https://github.com/phnx-labs/agents-cli
cd agents-cli
bun install
bun run build
bun run test
```

Requires Node.js 22.5+ and Bun. SQLite support uses the built-in `bun:sqlite` and `node:sqlite` modules; there is no native module rebuild step.

## Project structure

```
src/
  index.ts           # CLI entry point (commander.js)
  commands/          # One file per CLI command
  lib/               # Business logic, types, and integrations
    cloud/           # Cloud dispatch providers (Rush, Codex, Factory)
    session/         # Session discovery, parsing, rendering
    teams/           # Multi-agent coordination
```

Commands live in `src/commands/`, business logic in `src/lib/`. Tests are colocated as `*.test.ts` files under `__tests__/` directories.

## Code conventions

- **TypeScript only** -- strict mode enabled, no `any` where avoidable.
- **Bun** as the package manager and test runner.
- **JSDoc on all exports** -- every exported function, type, and interface has a JSDoc comment.
- **No emojis** in code, comments, or UI strings.
- **One test file per source file** -- `foo.ts` tests go in `__tests__/foo.test.ts`.
- **Real services in tests** -- no mocking. Tests hit actual code paths.

## Making changes

1. **Build and test before submitting:**
   ```bash
   bun run build && bun run test
   ```

2. **Keep PRs focused.** One feature or fix per PR. Don't bundle unrelated changes.

3. **Add tests for non-trivial logic.** Edge cases in parsing, state management, and resource syncing are the most valuable tests.

4. **Document new exports.** Every new public function or type needs a JSDoc comment.

## Adding a new agent

Agents are defined in `src/lib/agents.ts` as entries in the `AGENTS` object. Each entry declares:

- CLI command name and npm package
- Config directory and file format
- Memory file name (e.g., `CLAUDE.md`, `GEMINI.md`)
- Capability flags (hooks, MCP, skills, commands, permissions)

Add the agent ID to the `AgentId` type in `src/lib/types.ts`, then add the config entry in `src/lib/agents.ts`.

## Adding a cloud provider

Cloud providers implement the `CloudProvider` interface in `src/lib/cloud/types.ts`. See `src/lib/cloud/rush.ts` for a complete example. Register the provider in `src/lib/cloud/registry.ts`.

## Commit messages

Use [conventional commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
