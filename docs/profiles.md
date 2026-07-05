# Profiles

Named bundles of (host CLI, endpoint, model, auth) — run alternative providers through a standard agent interface without a local proxy.

## Overview

A profile pins a host agent binary to a non-default API endpoint and model, with its API key stored in macOS Keychain. Running `agents run <profile>` resolves the profile at spawn time — env vars are injected into the child process and the key is read from Keychain, so the YAML on disk never holds secrets and is safe to commit.

Built-in presets cover the top open-weight models via OpenRouter (one shared key) and native CLI providers (xAI, Google). Custom profiles work with any OpenAI-compatible endpoint: Ollama, vLLM, LiteLLM Proxy. Profile YAML files live under `~/.agents/profiles/` and are resolved by name at `agents run` time.

> **Status:** Profiles are experimental, but available by default — no enable step needed.

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
| `grok-fast` | xai | `grok-build-fast` | Native grok host. |
| `grok-heavy` | xai | `grok-build` | Native grok host (SuperGrok). |
| `agy` | google | (CLI default) | Native antigravity host. |

Source: `src/lib/profiles-presets.ts:45-143`.

**REASONING vs PRINT-SAFE:** Claude Code sends `thinking:{type:"enabled"}` in its Anthropic payload. When the model returns reasoning/redacted_thinking blocks, `--print` consolidation returns empty stdout. Reasoning presets (`kimi`, `minimax`, `glm`) work fine interactively; use print-safe variants (`kimi-chat`, `qwen`, `deepseek`) for `agents run --print` and scripted pipelines.

## Configuration Schema

```yaml
# ~/.agents/profiles/<name>.yml

name: local-llama              # string, required — must match filename stem
                               # Pattern: [a-z0-9][a-z0-9-_]{0,48} (case-insensitive)

description: Local Llama 3.3  # string, optional — shown in `profiles list` and `view`

host:
  agent: claude                # AgentId, required — which CLI binary to spawn
                               # One of: claude, codex, gemini, cursor, opencode, grok, antigravity
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
```

Fields sourced from `Profile` interface at `src/lib/profiles.ts:18-32`.

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
