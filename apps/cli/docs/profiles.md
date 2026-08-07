# Profiles

Named bundles of (host CLI, endpoint, model, auth) — run alternative providers through a standard agent interface without a local proxy.

## Overview

A profile pins a host agent binary to a non-default API endpoint and model, with its API key stored in macOS Keychain. Running `agents run <profile>` resolves the profile at spawn time — env vars are injected into the child process and the key is read from Keychain, so the YAML on disk never holds secrets and is safe to commit.

Built-in presets cover the top open-weight models via OpenRouter (one shared key) and native CLI providers (xAI, Google). Custom profiles work with any OpenAI-compatible endpoint: Ollama, vLLM, LiteLLM Proxy. Profile YAML files live under `~/.agents/profiles/` and are resolved by name at `agents run` time.

> **Status:** Profiles are experimental, but available by default — no enable step needed.

## Custom harnesses (`agents harness`)

A custom harness is a profile you create from a host CLI + model in one command, so a model like Meta Muse Spark 1.1 runs like a native agent type:

```sh
# OpenCode pinned to Muse Spark, named `spark`
agents harness add spark --host opencode --model meta/muse-spark-1.1
agents run spark "refactor api/handlers/checkout.py"

# per-run model override still wins over the profile
agents run spark --model opencode/big-pickle "quick pass"

# private OpenAI/Anthropic-compatible endpoint with a keychain-backed key
agents harness add corp --host claude --model gpt-x --base-url https://gw.corp/v1 --auth-provider corp
```

The model is written to the host's model env var — `OPENCODE_MODEL` for opencode, `ANTHROPIC_MODEL` for claude, `GROK_MODEL` for grok, `GEMINI_MODEL` for gemini. Hosts that manage their own login (e.g. opencode) need no `--auth-provider`; omit it and no auth block is written.

`agents harness list` shows three groups: your custom harnesses, the addable built-in presets, and the native harness registry. `agents harness view <name>` and `agents harness remove <name>` round it out.

A harness *is* a profile — same `~/.agents/profiles/<name>.yml`, same `agents run` resolution, same device sync via `agents repo push user`. The difference from `agents profiles add`: `harness add` takes the host+model one-shot (no preset needed) and owns its own `--host` flag, whereas `agents profiles --host <device>` is reserved for running the profiles command on a remote device.

### Forking a harness (`agents harness fork`)

`fork` is the one verb for both starting points — a native harness, or a custom one you already tuned:

```sh
# fork the native OpenCode harness onto a DeepSeek model, keyed by OpenRouter
agents harness fork opencode deepseek --model deepseek/deepseek-v4-flash-0731 --auth-provider openrouter

# fork Claude Code onto a private gateway
agents harness fork claude corp --model gpt-x --base-url https://gw.corp/v1 --auth-provider corp

# copy an existing harness and swap only the model
agents harness fork deepseek deepseek-chat --model deepseek/deepseek-chat-v3
```

Forking a **native** harness requires `--model` — there is no model to inherit. Forking a **custom** harness copies everything (env, endpoint, auth binding, `fallback_model`, host version pin) and applies only the flags you pass; the two diverge from that point, so removing the source never affects the fork. `--force` overwrites an existing harness of the same name. The name `agents view` prints is derived from the harness `name` — `deepseek-flash` renders as `DeepSeek Flash` — so there is no flag to set it. The fork records its parent as `forkedFrom:` in the YAML — display-only lineage.

### Editing and renaming a harness (`agents harness edit` / `rename`)

`edit` applies overrides onto an existing harness **in place** — same name, same lineage — instead of copying it under a new one:

```sh
# swap the pinned model
agents harness edit deepseek --model deepseek/deepseek-v3.2

# repoint auth at a different provider and re-enter the key
agents harness edit corp --auth-provider corp2

# unpin the host CLI version
agents harness edit spark --version ""

# add (or clear, with an empty string) a same-host fallback model for rate-limit retries
agents harness edit deepseek --fallback-model deepseek/deepseek-chat-v3
```

`edit` takes the same override flags as `fork` (`--model`, `--base-url`, `--auth-provider`, `--version`, `--description`, `--from-secrets`) plus one edit-only flag, `--fallback-model`, for `Profile.fallback_model` (see [`03-routines.md`](03-routines.md) and the fallback cascade in `runWithFallback`). Unlike `fork`, `edit` never rewrites `forkedFrom` to point at itself.

Giving zero flags **in a terminal** now opens the same interactive wizard `add`/`fork` use, pre-filled with the harness's current values (`agents harness edit deepseek` with no flags). It walks each editable field — model, endpoint, auth, version, fallback, description — and writes only what you change; leaving every prompt at its default is a no-op. Fields the host can't carry are shown disabled with a reason: a host with no custom-endpoint slot (anything but claude/codex) skips the base-URL prompt, and a self-updating host (grok/droid/antigravity/cursor/hermes/muse/kiro/goose) skips the version pin, rather than silently accepting a value a run would drop. Giving zero flags **without** a terminal stays a no-op error naming the available ones, so scripts are unchanged.

`agents harness rename <old-name> <new-name>` renames the underlying YAML file and updates the `name:` field inside it; every other harness whose `forkedFrom:` pointed at the old name is rewritten to the new one. Renaming onto an existing name is a hard error — there is no overwrite path (use `remove` first if that's really the intent).

### Copying a key out of an existing secrets bundle (`--from-secrets`)

`add`, `fork`, and `edit` all accept `--from-secrets <bundle>` or `--from-secrets <bundle>:<key>` (the key is optional only when the bundle has exactly one). This is a **one-time copy**, not a live link: it reads the value out of the named `agents secrets` bundle (Touch ID on macOS, once) and writes it into the harness's own keychain item (`agents-cli.<provider>.token`), which is never gated behind biometry-required prefixes, so every later `agents run <harness>` reads it silently.

```sh
agents harness add corp --host claude --model gpt-x --auth-provider corp --from-secrets prod:OPENROUTER_KEY
agents harness edit corp --from-secrets prod:OPENROUTER_KEY   # rotate later without retyping
```

### Interactive wizard (`agents harness add` / `fork` / `edit`)

Run `add` or `fork` in a terminal without enough flags to build a harness (e.g. bare `agents harness add`, or `agents harness fork claude` with no `--model`) and a picker walks you through it instead of throwing: fork from (every native host plus your existing harnesses) → a built-in preset or "build custom" (host + model + provider) → the harness's name (pre-filled with the preset's own name, e.g. `deepseek`, not a model detail) → how to get the key (type it, or pick a bundle+key via `--from-secrets`). `edit` opens the same wizard pre-filled with a harness's current values when you run it with no flags (see above). Flags remain fully supported for scripts — the wizard only engages when required info is missing **and** stdin+stdout are a TTY; a non-interactive shell still gets the original error.

Both flows drive one shared step engine ([`src/commands/harness-wizard.ts`](../src/commands/harness-wizard.ts)): a `create` and an `edit` step list over a single runner, each step skippable by the matching flag and gated by a `WizardIO` seam that makes the engine testable without a TTY. The model catalog, connection test, per-host edit matrix, and cross-host portability plug into it via typed extension points (`WizardHooks`).

### Custom harnesses are their own agent type

`agents view` lists each custom harness as its own block, beside Claude and Codex rather than indented under whichever host CLI executes it — because `agents run <name>` already launches it the same way a native agent id is launched:

```
  deepseek-flash (custom)
    deepseek/deepseek-v4-flash-0731  openrouter stored  via claude

  deepseek-chat (custom · forked from deepseek-flash)
    deepseek/deepseek-chat-v3        openrouter stored  via claude
```

The row carries the pinned model, the account/auth state, and `via <host>` — the native harness that actually runs it, with its version when the harness pins one. A harness whose host CLI has no install is flagged `(host <id> not installed)` rather than listed as runnable. `agents view <name>` describes one harness (host, model, provider, auth, lineage, YAML path), and `agents view <name> --json` emits its summary. A native-specific `agents view <agent>` shows only that native harness's versions; it does not include custom harnesses that execute through it. The exact custom name also wins in `agents run`, before native ids and hard-deprecated aliases, so the fork remains runnable through its configured host. The unfiltered `agents view --json` inventory keeps hosted summaries under the `harnesses` key for machine consumers.

## Top-level resource profiles

`agents profile use <name>` activates a resource profile from `agents.yaml`.
This is separate from model-provider profiles (`agents profiles add kimi`):
resource profiles switch the resolved set of commands, skills, hooks, rules,
MCP servers, permissions, workflows, plugins, subagents, and secrets.

Create or update one from the CLI:

```sh
agents profile set work \
  --skills "system:code-review,user:deploy" \
  --mcp "user:github" \
  --permissions "system:default" \
  --rules work \
  --secrets "github.com,prod"
agents profile use work
```

The same state can be kept directly in `~/.agents/agents.yaml`:

```yaml
profiles:
  active: work
  presets:
    work:
      skills: ["system:code-review", "user:deploy"]
      mcp: ["user:github"]
      permissions: ["system:default"]
      rules: work
      secrets: ["github.com", "prod"]
```

When a profile is active, omitted resource kinds remain unchanged; listed kinds
are filtered to the selected names. Secrets outside the active profile are not
listed and cannot be injected into runs.

## Architecture

```
~/.agents/
  profiles/
    kimi.yml              # profile YAML (no secrets)
    deepseek.yml
    local-llama.yml

macOS Keychain
  agents-cli.openrouter.token    # shared across all openrouter profiles
  agents-cli.xai.token           # xAI profiles
  agents-cli.ollama.token        # custom profiles

                  ┌─────────────────────┐
  agents run kimi │  resolveProfileEnv  │
  ───────────────▶│  1. read kimi.yml   │
                  │  2. read Keychain   │──▶ spawn claude
                  │  3. merge env block │     ANTHROPIC_BASE_URL=...
                  └─────────────────────┘     ANTHROPIC_MODEL=...
                                              ANTHROPIC_AUTH_TOKEN=<key>
```

Profile YAML `host.agent` selects which binary is spawned. Env vars override defaults for that CLI. Auth is resolved last — keychain item name is stored in `auth.keychainItem` and the env var to inject it under is stored in `auth.envVar`.

## Command Reference

| Command | Description | Example |
|---------|-------------|---------|
| `profiles list` / `ls` | List configured profiles (name, host, provider, model) | `agents profiles list` |
| `profiles presets` | List built-in presets with descriptions | `agents profiles presets` |
| `profiles view <name>` / `show` | Inspect a profile (env vars, auth status, preset link) | `agents profiles view kimi` |
| `profiles add <name>` | Add a profile from a preset. Prompts for API key once per provider. | `agents profiles add kimi` |
| `profiles add <name> --preset <preset>` | Add a profile using an explicit preset name | `agents profiles add k2 --preset kimi` |
| `profiles add <name> --version <v>` | Pin the host CLI version | `agents profiles add kimi --version 2.1.113` |
| `profiles add <name> --key-stdin` | Read API key from stdin (CI-safe) | `echo $KEY \| agents profiles add kimi --key-stdin` |
| `profiles add <name> --force` | Overwrite an existing profile | `agents profiles add kimi --force` |
| `profiles remove <name>` / `rm` | Delete a profile (keychain token is kept) | `agents profiles remove kimi` |
| `profiles login <provider>` | Store or rotate the API key for a provider | `agents profiles login openrouter` |
| `profiles login <provider> --key-stdin` | Read key from stdin | `echo $KEY \| agents profiles login openrouter --key-stdin` |
| `profiles logout <provider>` | Remove a stored provider key from Keychain | `agents profiles logout openrouter` |

## Built-in Presets

All OpenRouter presets share one key (`agents-cli.openrouter.token`). Adding a second OpenRouter preset never re-prompts.

| Preset | Provider | Model | Notes |
|--------|----------|-------|-------|
| `kimi` | openrouter | `moonshotai/kimi-k2.5` | 99% HumanEval. REASONING — interactive only; `--print` returns empty output. |
| `kimi-chat` | openrouter | `moonshotai/kimi-k2-0905` | Non-reasoning sibling. PRINT-SAFE. |
| `minimax` | openrouter | `minimax/minimax-m2.5` | 80.2% SWE-bench. REASONING — interactive only. |
| `glm` | openrouter | `z-ai/glm-5` | #1 Chatbot Arena ELO among open-weight. REASONING — interactive only. |
| `qwen` | openrouter | `qwen/qwen3-coder-next` | Latest coding Qwen. PRINT-SAFE. |
| `deepseek` | openrouter | `deepseek/deepseek-chat-v3-0324` | Non-reasoning DeepSeek Chat. PRINT-SAFE. |
| `open-claude` | openrouter | `qwen/qwen3-coder-next` | Open-weight coding inside Claude Code — general open-claude path. PRINT-SAFE. |
| `claude-spark` | openrouter | `meta/claude-spark-1.1` | Meta Claude Spark 1.1 via OpenRouter inside Claude Code. Open alternative for open-claude spark usage. |
| `opencode` | opencode | (default) | OpenCode default — uses configured model. Auth via `opencode auth`. |
| `opencode-spark` | opencode | `meta/claude-spark-1.1` | Meta Claude Spark 1.1 via OpenCode — best for open-claude usage with opencode harness. |
| `opencode-qwen` | opencode | `qwen/qwen3-coder-next` | Qwen3 Coder Next via OpenCode — free via opencode provider. |
| `grok-fast` | xai | `grok-build-fast` | Native grok host. |
| `grok-heavy` | xai | `grok-build` | Native grok host (SuperGrok). |
| `agy` | google | (CLI default) | Native antigravity host. |
| `anthropic` | anthropic | `claude-3-5-sonnet-latest` | Direct Anthropic API. |
| `proxy` | proxy | (custom) | Generic local proxy / gateway. |
| `truefoundry` | truefoundry | (custom) | TrueFoundry AI Gateway. |
| `bedrock` | bedrock | (custom) | AWS Bedrock native mode. |
| `vertex` | vertex | (custom) | Google Vertex AI. |
| `foundry` | foundry | (custom) | Azure AI Foundry. |
| `litellm` | litellm | (custom) | LiteLLM proxy. |
| `vllm` | vllm | (custom) | Self-hosted vLLM. |
| `ollama` | ollama | `qwen3-coder:30b` (default) | Local Ollama via Codex host. |

Source: `src/lib/profiles-presets.ts`.

**REASONING vs PRINT-SAFE:** Claude Code sends `thinking:{type:"enabled"}` in its Anthropic payload. When the model returns reasoning/redacted_thinking blocks, `--print` consolidation returns empty stdout. Reasoning presets (`kimi`, `minimax`, `glm`) work fine interactively; use print-safe variants (`kimi-chat`, `qwen`, `deepseek`) for `agents run --print` and scripted pipelines.

## Configuration Schema

```yaml
# ~/.agents/profiles/<name>.yml

name: local-llama              # string, required — must match filename stem
                               # Pattern: [a-z0-9][a-z0-9-_]{0,48} (case-insensitive)

description: Local Llama 3.3  # string, optional — shown in `profiles list` and `view`

host:
  agent: claude                # AgentId, required — which CLI binary to spawn
                               # One of: claude, codex, cursor, opencode, grok, antigravity
                               # (gemini is hard-deprecated — see 00-concepts.md)
  version: 2.1.113             # string, optional — pin this host CLI version

env:                           # Record<string, string>, required (may be empty {})
  ANTHROPIC_BASE_URL: http://localhost:11434   # endpoint override
  ANTHROPIC_MODEL: llama-3.3-70b              # model override
  ANTHROPIC_SMALL_FAST_MODEL: llama-3.3-70b  # fast-path model (optional)

auth:                          # optional — omit if no token is needed
  envVar: ANTHROPIC_AUTH_TOKEN # string — which env var to inject the key into
  keychainItem: agents-cli.ollama.token  # string — keychain item that holds the key

preset: kimi                   # string, optional — preset this profile was created from
                               # Set automatically by `profiles add`; informational only.

provider: openrouter           # string, optional — provider name for display
                               # Set automatically by `profiles add`; informational only.

models:                        # Partial<Record<ModelTier, string>>, optional
  cheap: deepseek/deepseek-chat-v3        # per-tier model ids for THIS harness's
  default: deepseek/deepseek-v4-flash-0731 # own catalog — resolves `agents run
  best: deepseek/deepseek-r1               # <profile> --model cheap|default|best|ultra`
                               # against the harness's own models instead of the host
                               # agent's (claude/codex/...) native catalog. An unset
                               # tier clamps to the next CHEAPER tier that IS set
                               # (ultra -> best -> default -> cheap). Omit entirely to
                               # keep today's behavior: a requested tier falls back to
                               # the single pinned model in `env`, unchanged.
```

Fields sourced from `Profile` interface at `src/lib/profiles.ts:19-73`.

## Recipes

### 1. Add a preset and run it

```bash
# Store the OpenRouter key once (all openrouter presets reuse it)
agents profiles login openrouter

# Add Kimi (interactive use — reasoning model)
agents profiles add kimi
agents run kimi "refactor the auth handler"

# Add a print-safe preset for scripted use
agents profiles add deepseek
agents run deepseek --print "summarize the diff"
```

### 2. Write a custom YAML for a local Ollama endpoint

Drop a YAML under `~/.agents/profiles/local-llama.yml`:

```yaml
name: local-llama
description: Local Llama 3.3 via Ollama
host:
  agent: claude
env:
  ANTHROPIC_BASE_URL: http://localhost:11434
  ANTHROPIC_MODEL: llama-3.3-70b
auth:
  envVar: ANTHROPIC_AUTH_TOKEN
  keychainItem: agents-cli.ollama.token
```

Then store the key and verify:

```bash
agents profiles login ollama    # or: echo "your-key" | agents profiles add local-llama --key-stdin
agents profiles view local-llama
agents run local-llama "hello"
```

### 3. Rotate the API key for a provider

Rotation applies to all profiles that share the same provider key:

```bash
agents profiles login openrouter   # prompts for new key, overwrites the old one
# All kimi, kimi-chat, minimax, glm, qwen, deepseek profiles pick it up immediately
```

To rotate via stdin (CI):

```bash
echo "$NEW_KEY" | agents profiles login openrouter --key-stdin
```

### 4. List and inspect configured profiles

```bash
agents profiles list              # table: NAME HOST PROVIDER MODEL
agents profiles view kimi         # env vars, auth status, signup URL
agents profiles presets           # full preset catalog with descriptions
```

### 5. Pin a specific host version

```bash
agents profiles add kimi --version 2.1.113
# spawns claude@2.1.113 for this profile only
```

### 6. Remove a profile without losing the key

```bash
agents profiles remove kimi
# YAML deleted; agents-cli.openrouter.token stays in Keychain
# Other openrouter profiles are unaffected

# To fully remove the key too:
agents profiles logout openrouter
```

### 7. Run a profile on a leased box

```bash
agents run deepseek "summarize this repo" --lease hetzner
agents run deepseek "summarize this repo" --box warm-one
```

Leased profile runs install the profile's `host.agent` on the disposable box and
materialize a temporary profile there for the duration of the run. Profiles with
their own API key, such as OpenRouter-backed `kimi` and `deepseek`, ship that
profile auth only; the base runtime's local OAuth credential is copied only when
the profile has no auth env of its own. `--box <slug>` targets an existing warm
crabbox box instead of provisioning a disposable lease, so the same box can serve
profile runs from different repositories and remains running after the command.

`--lease` is reuse-first against one shared `default` pool across repositories:
before leasing a new box it looks for a warm box with the same network mode that
`crabbox status` reports SSH-ready, and reuses it instead of paying for one warm
box per repo. If the pool is empty, the newly warmed box is kept after the run so
the next caller can reuse it. Each concurrent run copies the synced checkout into its own
`~/workspaces/<repo>-<run>` directory, then launches there; callers share compute,
not a working tree, agent home, or credential file. Switching repositories therefore pays a re-sync latency in
exchange for the lower idle-compute cost.

The generic `.crabbox.yaml` `profile:` key still scopes repo sandbox/CI scripts.
To opt `agents run --lease` into a dedicated hot-box pool, add a separate lease
label explicitly:

```yaml
leaseProfile: private-hot-box
```

`--fresh` opts out of reuse entirely: it always provisions a brand-new box and
tears it down after the run.

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/profiles.mp4"></video>

`agents profiles add kimi` stores the OpenRouter key once; `agents run kimi` spawns Claude Code with Kimi K2.5 responding.

## See Also

- `docs/00-concepts.md` — DotAgents repos, resource resolution order
- `docs/02-resource-sync.md` — how profiles sync across machines
- `docs/secrets.md` — inject secrets bundles into agent runs

## Per-provider guides

For non-preset providers (gateways, self-hosted), the wizard at `agents profiles create` walks you through the env vars. Per-provider gotchas are in:

- [TrueFoundry](profiles/truefoundry.md) — LLM Gateway, Bedrock-backed
- [AWS Bedrock](profiles/bedrock.md) — direct
- [Google Vertex](profiles/vertex.md)
- [Microsoft Azure AI Foundry](profiles/foundry.md) — distinct from TrueFoundry
- [OpenRouter](profiles/openrouter.md) — built-in presets
- [Self-hosted vLLM](profiles/vllm.md) — native Anthropic endpoint, tool_use clean
- [LiteLLM Proxy](profiles/litellm.md)
- [Ollama](profiles/ollama.md) — Codex host recommended

Full table: [profiles/INDEX.md](profiles/INDEX.md).
