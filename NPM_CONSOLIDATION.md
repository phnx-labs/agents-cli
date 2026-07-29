# npm consolidation — deprecate the alias packages

The download signal for this CLI is currently split across three npm packages:

| Package | Role | Action |
| --- | --- | --- |
| **`@phnx-labs/agents-cli`** | Canonical package — the real CLI | Keep. Do **not** deprecate. |
| `@phnx-labs/agi-cli` | Front-brand alias (`packages/agi-cli`) — re-exports the canonical CLI | Deprecate. |
| `@companion/agents-cli` | Legacy redirect stub (`packages/swarmify-mirror`) — re-exports the canonical CLI | Deprecate. |

Deprecating the two aliases points every `npm install` at the canonical package, so downloads, GitHub stars, and search rank concentrate on one listing instead of three. `npm deprecate` is non-destructive: the packages stay installable (existing installs keep working), npm just prints a deprecation warning on install and greys the listing.

## What Muqsit needs to run

These commands require npm **publish auth** for the `@phnx-labs` and `@companion` scopes, so they are **not** run by the agent — run them yourself once logged in (`npm whoami` to confirm):

```bash
# Deprecate every version of the agi-cli alias.
npm deprecate "@phnx-labs/agi-cli@*" \
  "Deprecated: install @phnx-labs/agents-cli instead (same CLI). See https://github.com/phnx-labs/agents-cli"

# Deprecate every version of the legacy @companion redirect stub.
npm deprecate "@companion/agents-cli@*" \
  "Deprecated: install @phnx-labs/agents-cli instead. See https://github.com/phnx-labs/agents-cli"
```

Notes:

- The `@*` range deprecates **all** published versions. To deprecate only a specific range, pass e.g. `"@phnx-labs/agi-cli@<=1.20.70"`.
- To **undo** a deprecation, re-run `npm deprecate` with an empty message string: `npm deprecate "@phnx-labs/agi-cli@*" ""`.
- Do **not** `npm unpublish` the aliases — that breaks existing installs and the 24h-old unpublish window rules. Deprecation is the safe path.
- Leave `@phnx-labs/agents-cli` untouched; it is the destination.

## Verify

```bash
npm view @phnx-labs/agi-cli deprecated
npm view @companion/agents-cli deprecated
npm view @phnx-labs/agents-cli deprecated   # should print nothing (not deprecated)
```

The package.json `description` and `README.md` for both aliases (`packages/agi-cli`, `packages/swarmify-mirror`) already state the deprecation and name `@phnx-labs/agents-cli` as canonical — those ship on the next publish of each alias so the npm listing pages match the deprecation warning.
