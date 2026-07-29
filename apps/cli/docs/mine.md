# Make it yours — white-label the CLI

`agents setup mine` mints a **personally-named CLI** that _is_ agents-cli. Run it
as `jack` instead of `agents`, hide the commands you don't want, and pin a curated
set of skills/plugins — all under your own name. Free and Apache-2.0.

```bash
agents setup mine            # wizard: pick a name, choose what to turn off
jack run claude "hello"      # every agents verb, under your name
jack --help                  # help, version, and errors all read "jack"
```

## How it works

A brand is a name plus a thin config in `~/.agents/agents.yaml` (`brands.<name>`).
`init` writes three things:

1. **A pass-through shim** at `~/.agents/.cache/shims/<name>` — a 755 script that
   `export AGENTS_BRAND=<name>` then `exec`s the agents-cli entrypoint with your
   args verbatim. That dir is already on your `PATH` from install, so the new name
   is immediately a command. Nothing is copied or forked — it's the same binary.
2. **The brand config** — `{ name, disabledCommands, profile, enabled }`.
3. **A resource profile preset** (`mine-<name>`) that curates what the brand sees.

When the CLI starts under `AGENTS_BRAND`, it (a) presents its name/help/errors as
the brand, (b) drops the brand's disabled commands, and (c) activates the brand's
resource profile so skills/plugins/MCP/hooks filter to your curated set. The plain
`agents` / `ag` commands are unaffected.

Because brand config lives in `agents.yaml`, it rides `agents repo push/pull`
across your fleet like every other user setting.

## Commands

| Command | What it does |
|---|---|
| `agents setup mine` | Interactive wizard — pick a name, check off features to disable, mint it. |
| `agents mine init <name> [--disable <cmds...>] [--force]` | Create a brand non-interactively. |
| `agents mine list` | Show your brands and what each has turned off. |
| `agents mine toggle <name> [flags]` | Enable/disable features for a brand (see below). |
| `agents mine remove <name> [--purge]` | Remove a brand's shim + config (`--purge` also deletes its resource preset). |

### `toggle` flags

| Flag | Effect |
|---|---|
| `--disable <cmds...>` / `--enable <cmds...>` | Hide/un-hide built-in top-level commands (e.g. `teams`, `cloud`). |
| `--disable-plugin <names...>` / `--enable-plugin <names...>` | Turn plugins off/on for the brand. |
| `--disable-skill <names...>` / `--enable-skill <names...>` | Turn skills off/on for the brand. |

Plugin/skill toggles are written to the brand's resource-profile preset as
`['*', '!name']` excludes, so everything you _don't_ name stays on. See
[Resource profiles](profiles.md) for the underlying model.

## Examples

```bash
# A locked-down CLI for a teammate: no teams/cloud, no rush plugin.
agents mine init jack --disable teams cloud
agents mine toggle jack --disable-plugin rush

# A second, fully independent brand.
agents mine init pranjal --disable wallet

jack --help          # lists neither teams nor cloud
agents --help        # unchanged — every command still there
```

## Notes

- **Names** follow the same rules as agent CLIs: a letter then letters/digits/`_`/`-`,
  and can't collide with `agents`, `ag`, or an installed agent CLI (`claude`, `codex`, …).
- **`agents` is never affected** — disabling a command for a brand hides it only
  under that brand; the plain CLI keeps every command.
- **Brand curation is a foreground view.** The background auto-sync always
  reconciles the full resource set into your shared agent homes, so a brand never
  silently strips skills/plugins for the plain `agents` user. Note that running
  `<brand> sync` explicitly will materialize the brand's curated set into the
  shared homes — run `agents sync` to restore the full set.
- **Commercial white-label** (redistributing a branded build to customers) will
  require a license in a future release; personal use is free.
