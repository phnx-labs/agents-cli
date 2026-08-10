# agents-cli Configuration Surface — Source-of-Truth Spec

## Purpose

This document specifies the persistent configuration surface of `agents-cli`: the commands, on-disk schema, and resolution rules that determine how an `agents run` (or team placement, or daemon behavior) picks its mode, model, effort level, interactive host, browser profile, and per-device limits. The boundary covers the user-facing commands that write these values and the read paths that consume them.

## Capability boundary

In scope:

- `agents config list|get|set|unset` — unified config barrel.
- Key grammar:
  - `run.<agent@version>.model` — default model or tier token.
  - `run.<agent@version>.mode` — default permission mode.
  - `run.<agent@version>.effort` — default reasoning effort.
  - `run.<agent@version>.tier.<cheap|default|best|ultra>` — tier-to-model override.
  - `interactive.host` — fleet-wide interactive host pin.
  - `browser.profile` — default browser profile (device scope).
  - `devices.<name>.<property>` — per-device config keys.
- Deprecated aliases that still mutate the same stores:
  `agents defaults run`, `agents models tier`, `agents devices configure`,
  `agents devices set-interactive`, `agents browser profiles set-default`.
- Project-local `agents.yaml` `run:` blocks discovered from `process.cwd()` upward.
- Underlying storage: central `~/.agents/agents.yaml` and per-device `~/.agents/devices/<host>/agents.yaml`.

Out of scope:

- Transient CLI flags (`--model`, `--mode`, `--effort` on `agents run`).
- Agent-native settings files (e.g. Claude’s own `settings.json`).
- Secrets, profiles, project-root, routines, and other central `agents.yaml` keys not listed above.

## Requirements

### Requirement: The unified config command accepts a dotted key grammar

The system SHALL accept config keys in the form `run.<agent@version>.<property>`,
`interactive.host`, `browser.profile`, and `devices.<name>.<property>`, and SHALL
reject unknown scopes, agents, versions, properties, or tiers with a clear error.

#### Scenario: parse a run model key

- GIVEN the key `run.claude@2.1.45.model`
- WHEN `parseConfigKey` is called
- THEN it returns `{ scope: 'run', agent: 'claude', version: '2.1.45', property: 'model' }`.

Evidence: `apps/cli/src/lib/config-keys.ts:parseConfigKey` matches `^run\.(.*)\.(model|mode|effort)$` and validates the captured `agent@version` token.

#### Scenario: reject an unknown agent

- GIVEN the key `run.notanagent@*.model`
- WHEN `parseConfigKey` is called
- THEN it throws an error naming the key and listing known agents.

Evidence: `apps/cli/src/lib/config-keys.ts:parseAgentVersion` checks `agent in AGENTS`.

### Requirement: Run defaults are stored under a selector-keyed map

The system SHALL persist `agents config set run.<agent@version>.<model|mode|effort>`
under `run.defaults.<agent:version>.<field>` in central `agents.yaml`.

#### Scenario: set a wildcard default via the new command

- GIVEN no existing run defaults
- WHEN the user runs `agents config set run.claude@*.model claude-opus-4-8`
- THEN `~/.agents/agents.yaml` contains `run: { defaults: { "claude:*": { model: claude-opus-4-8 } } }`.

Evidence: `apps/cli/src/commands/config.ts:setConfig` routes run model keys to
`setRunDefaultModel` (`apps/cli/src/lib/run-defaults.ts`), which writes to
`meta.run.defaults[selector]`.

### Requirement: Exact run-default selectors override wildcard selectors

The system SHALL resolve run defaults so that an exact `<agent>:<version>` selector wins over a wildcard `<agent>:*` selector for each field independently.

#### Scenario: wildcard plus exact override

- GIVEN `run.defaults."claude:*".model = sonnet` and `run.defaults."claude:2.1.45".model = opus`
- WHEN `resolveRunDefaults('claude', '2.1.45')` is called
- THEN the resolved model is `opus`.

Evidence: `apps/cli/src/lib/run-defaults.ts:131` merges wildcard first, then exact selector per-field.

### Requirement: Project-local run configs override central run defaults

The system SHALL discover project-local `agents.yaml` files from the current working directory upward and merge their `run:` blocks after the central `agents.yaml` run config, with later (closer) project files winning.

#### Scenario: project overrides user default

- GIVEN central `run.defaults."claude:*".model = opus`
- AND a project-local `agents.yaml` in the working directory with `run: { defaults: { "claude:*": { model: haiku } } }`
- WHEN `resolveRunDefaults('claude', version, projectPath)` is called
- THEN the resolved model is `haiku`.

Evidence: `apps/cli/src/lib/run-defaults.ts:202` passes `[readMeta().run, ...projectRunConfigs]` to `resolveRunDefaultsFromConfigs`, and `apps/cli/src/lib/run-config.ts:19` walks upward from the start path.

### Requirement: Model tier overrides are folded into the run namespace

The system SHALL persist `agents config set run.<agent@version>.tier.<tier> <model>`
under `model.tiers.<agent:version>.<tier>` in central `agents.yaml`.

#### Scenario: pin Claude best tier via the new command

- GIVEN no existing tier overrides
- WHEN the user runs `agents config set run.claude@*.tier.best claude-opus-4-8`
- THEN `~/.agents/agents.yaml` contains `model: { tiers: { "claude:*": { best: claude-opus-4-8 } } }`.

Evidence: `apps/cli/src/commands/config.ts:setConfig` routes tier keys to
`setTierOverride` (`apps/cli/src/lib/model-tier-overrides.ts:93`), which writes to
`meta.model.tiers[selector]`.

### Requirement: Tier overrides resolve most-specific selector first

The system SHALL apply tier overrides so that `<agent>:<version>` overrides `<agent>:*` per tier.

#### Scenario: wildcard and version-specific tier

- GIVEN `model.tiers."claude:*".best = claude-opus-4-7` and `model.tiers."claude:2.1.45".best = claude-opus-4-8`
- WHEN resolving the best tier for `claude` version `2.1.45`
- THEN the model is `claude-opus-4-8`.

Evidence: `apps/cli/src/lib/model-tier-overrides.ts:66` merges wildcard first, then exact version.

### Requirement: Tier resolution falls back to auto-ranking when the override is unknown

The system SHALL ignore an overridden model id that is not present in the installed harness/version catalog and fall back to the auto-ranked model for that tier.

#### Scenario: stale override

- GIVEN `model.tiers."claude:*".best = claude-opus-99`
- AND the installed Claude catalog does not contain `claude-opus-99`
- WHEN the best tier is resolved
- THEN the system uses the auto-ranked best model for that version.

Evidence: `apps/cli/src/lib/model-tiers.ts:applyTierOverrides` validates overrides against `catalogIds` and keeps the base value when the id is missing.

### Requirement: Device-scope config keys are stored per-device

The system SHALL write `agents config set devices.<name>.<property>` to
`~/.agents/devices/<name>/agents.yaml`, not to central `agents.yaml`.

#### Scenario: configure a peer device

- GIVEN device `mac-mini` is registered
- WHEN the user runs `agents config set devices.mac-mini.max-agents 4`
- THEN `~/.agents/devices/mac-mini/agents.yaml` contains `config: { maxAgents: 4 }`
- AND central `agents.yaml` is unchanged.

Evidence: `apps/cli/src/commands/config.ts:setConfig` maps `max-agents` to the internal
key `agents.max-concurrent` and calls `setConfigValue` with `{ device: name }`;
`apps/cli/src/lib/device-config.ts:302` writes to the peer device doc.

### Requirement: Central config keys are stored in `~/.agents/agents.yaml`

The system SHALL store central-scope config keys (`interactive.host`, `browser.profile`, run defaults, tier overrides) in `~/.agents/agents.yaml`.

#### Scenario: set interactive host

- GIVEN no interactive host set
- WHEN the user runs `agents config set interactive.host zion`
- THEN `~/.agents/agents.yaml` contains `config: { interactiveHost: zion }`
- AND the device doc for `zion` is unchanged.

Evidence: `apps/cli/src/lib/state.ts:900` classifies `config` and `run` and `model` as `'central'`; `apps/cli/src/commands/config.ts:setConfig` calls `setConfigValue('interactive.host', name)` which routes to central `agents.yaml` via `apps/cli/src/lib/device-config.ts:274`.

### Requirement: User-level config is visible in per-device views via `--inherited`

The system SHALL provide `agents devices config <name> --inherited` to render user-level
keys (such as `interactive.host`) that apply to the named device but are stored in
central `~/.agents/agents.yaml`. Without `--inherited`, the per-device view SHALL show
only device-scope keys.

#### Scenario: show inherited interactive host

- GIVEN `config.interactiveHost` is set to `zion` in central `agents.yaml`
- WHEN the user runs `agents devices config mac-mini --inherited`
- THEN the output contains an "Inherited from ~/.agents/agents.yaml" section
- AND that section contains `interactive.host` with value `zion`
- BUT `agents devices config mac-mini` (without `--inherited`) does not contain `interactive.host`.

Evidence: `apps/cli/src/commands/ssh.ts:configureCmd` adds `--inherited` and renders
`listUserConfig()` separately from device-scope keys; `apps/cli/src/lib/device-config.ts`
exposes `listUserConfig()` for user-scope entries.

### Requirement: Default browser profile is a device-scope meta field

The system SHALL store the default browser profile in the top-level `defaultBrowserProfile` field of the per-device doc.

#### Scenario: set default browser profile

- GIVEN no default browser profile
- WHEN the user runs `agents config set browser.profile work`
- THEN `~/.agents/devices/<self>/agents.yaml` contains `defaultBrowserProfile: work`.

Evidence: `apps/cli/src/commands/config.ts:setConfig` writes `defaultBrowserProfile` via
`updateMeta` for the self device; `apps/cli/src/lib/state.ts:905` classifies
`defaultBrowserProfile` as `'device'`.

### Requirement: Deprecated commands still mutate the same YAML paths

The system SHALL keep the legacy commands (`agents defaults run`, `agents models tier`,
`agents devices configure`, `agents devices set-interactive`,
`agents browser profiles set-default`) functional and route their writes to the same
underlying stores as `agents config`, while emitting a deprecation warning.

#### Scenario: old run-default command still works

- GIVEN no existing run defaults
- WHEN the user runs `agents defaults run set 'claude:*' --model opus`
- THEN `~/.agents/agents.yaml` contains `run.defaults."claude:*".model = opus`
- AND the command emits a deprecation warning pointing to `agents config`.

Evidence: `apps/cli/src/commands/defaults.ts` calls `setRunDefault` and prints
`DEPRECATION` via `console.warn`.

### Requirement: Unset config keys restore default behavior

The system SHALL treat an absent or unset key as “use the built-in default behavior” rather than erroring.

#### Scenario: unset run default

- GIVEN `run.defaults."claude:*"` exists
- WHEN the user runs `agents config unset run.claude@*.model`
- THEN the selector is removed from `run.defaults`
- AND subsequent runs resolve as if no default had ever been set.

Evidence: `apps/cli/src/commands/config.ts:unsetConfig` delegates to `unsetRunDefault`;
`apps/cli/src/lib/run-defaults.ts:255` deletes the selector and, if empty, deletes `run.defaults`.

## Coverage gaps and ambiguities

1. **Project-local run config precedence is implicit.** A project `agents.yaml` can silently override user defaults, including model, with no warning emitted to the user.
2. **Fleet sync is manual.** Central `agents.yaml` and `devices/` docs sync via the DotAgents repo push/pull workflow; the CLI does not automatically propagate a config change to other online devices.
3. **No validation that a run-default model id exists in the catalog.** `setRunDefault` accepts any non-empty string (`apps/cli/src/lib/run-defaults.ts:72`), unlike tier overrides which are checked against the catalog at resolution time.
