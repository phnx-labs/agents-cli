---
kind: report
title: "agents-cli: accounts, providers & custom harnesses — a how-to"
surface: cli
project: agents-cli
repository: phnx-labs/agents-cli
branch: main
human: Phoenix Labs
agent: agents-cli
host: workstation
session: "n/a"
---

## Summary

A practical guide to running any coding-agent CLI against **any** model provider with `agents`, using three primitives:

- **account** — a durable, reusable credential (an API key, a setup token, or a bearer token), stored device-local.
- **provider** — which upstream the credential talks to (`openrouter`, `anthropic`, `openai`, `xai`, …) and how it maps onto each host CLI's env vars.
- **harness** — a named `(host CLI + model)` combo you run like a native agent with `agents run <name>`.

Two end-to-end flows are shown: an **API-key** provider account (e.g. OpenRouter), and a **ChatGPT/Codex subscription** (OAuth, **no API key**) for opencode.

## 1. The three primitives

There is no standalone `provider` command — "provider" is a value you pass to `accounts add`.

| Primitive | Command | Notes |
| --- | --- | --- |
| **account** | `agents accounts add <name> --provider <p> --auth api-key\|setup-token\|bearer-token` | Prompts for the secret, or import one with `--from-secrets <bundle>:<KEY>`. Stored with policy `never` (no Touch ID at launch). |
| **provider** | the `--provider` value | See the registry below. `agents accounts add` lists valid providers in `--help`. |
| **harness** | `agents harness fork <native> <name> --model <id> [--account <acct>]` | Fork a native host (claude, codex, opencode, …). Omit `--account` to use the host's own native login. |

Inspect and manage:

```bash
agents accounts list                 # your credential accounts + native logins
agents harness list                  # your custom harnesses
agents run <harness> "your prompt"   # run it
```

## 2. Provider registry & host mapping

A provider maps one credential onto the env vars each host CLI expects. Example for `openrouter`:

| Host | Auth env var | Base-URL env var |
| --- | --- | --- |
| claude | `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_BASE_URL=https://openrouter.ai/api` |
| codex | `OPENAI_API_KEY` | `OPENAI_BASE_URL=https://openrouter.ai/api/v1` |
| opencode | `OPENROUTER_API_KEY` | — |

Other providers in the registry include `anthropic` (api-key or setup-token), `openai`, `xai`, `google`, `deepinfra`, `proxy`, `litellm`, `vllm`, and `ollama`. Each declares which auth types and which hosts it supports.

## 3. Flow diagram

<figure>
<svg viewBox="0 0 900 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="account to provider to harness to run flow">
  <defs><marker id="h" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#a3e635"/></marker></defs>
  <rect x="10" y="60" width="180" height="70" rx="8" fill="#0f1720" stroke="#a3e635" stroke-width="1.5"/>
  <text x="26" y="90" fill="#e5e7eb" font-family="ui-monospace,monospace" font-size="14">get a key</text><text x="26" y="110" fill="#9ca3af" font-family="ui-monospace,monospace" font-size="11">or use a subscription</text>
  <line x1="190" y1="95" x2="235" y2="95" stroke="#a3e635" stroke-width="1.5" marker-end="url(#h)"/>
  <rect x="240" y="60" width="180" height="70" rx="8" fill="#0f1720" stroke="#a3e635" stroke-width="1.5"/>
  <text x="256" y="90" fill="#e5e7eb" font-family="ui-monospace,monospace" font-size="14">accounts add</text><text x="256" y="110" fill="#9ca3af" font-family="ui-monospace,monospace" font-size="11">--provider &lt;p&gt;</text>
  <line x1="420" y1="95" x2="465" y2="95" stroke="#a3e635" stroke-width="1.5" marker-end="url(#h)"/>
  <rect x="470" y="60" width="180" height="70" rx="8" fill="#0f1720" stroke="#a3e635" stroke-width="1.5"/>
  <text x="486" y="90" fill="#e5e7eb" font-family="ui-monospace,monospace" font-size="14">harness fork</text><text x="486" y="110" fill="#9ca3af" font-family="ui-monospace,monospace" font-size="11">--account + --model</text>
  <line x1="650" y1="95" x2="695" y2="95" stroke="#a3e635" stroke-width="1.5" marker-end="url(#h)"/>
  <rect x="700" y="60" width="190" height="70" rx="8" fill="#0f1720" stroke="#a3e635" stroke-width="1.5"/>
  <text x="716" y="90" fill="#e5e7eb" font-family="ui-monospace,monospace" font-size="14">agents run &lt;name&gt;</text><text x="716" y="110" fill="#9ca3af" font-family="ui-monospace,monospace" font-size="11">credential injected</text>
</svg>
<figcaption>Credential → durable account → custom harness → run. The credential is injected into the host CLI's env at launch.</figcaption>
</figure>

## 4. Flow A — an API-key provider account (OpenRouter)

Point Claude Code, Codex, or opencode at any model on OpenRouter with one reusable account.

```bash
# 1. Create the account (paste the key at the prompt, or import from an existing secret)
agents accounts add openrouter --provider openrouter --auth api-key

# 2. Fork a harness onto it, pinning a model
agents harness fork claude or-claude --model anthropic/claude-haiku-4.5 --account openrouter
agents harness fork codex  or-codex  --model openai/gpt-4o-mini        --account openrouter

# 3. Run
agents run or-claude "Reply with exactly: PONG"    # -> PONG
```

One account can back many harnesses. Use `agents accounts set-default <host> openrouter` to make it the default when `--account` is omitted.

## 5. Flow B — a ChatGPT / Codex subscription (no API key)

opencode can run on a ChatGPT Pro/Plus subscription via OAuth — no API key. Its OpenAI provider offers `ChatGPT Pro/Plus (browser)`, `ChatGPT Pro/Plus (headless)`, and `Manually enter API Key`. The headless method is a device-code flow.

```bash
opencode auth login --provider openai --method "ChatGPT Pro/Plus (headless)"
#   Go to: https://auth.openai.com/codex/device
#   Enter code: XXXX-XXXXX    (authorize in a browser signed into the ChatGPT account)

opencode run --model openai/gpt-5.4-mini "Reply with exactly: PONG"   # -> PONG
```

This stores an OAuth credential (access + refresh token) in opencode's `auth.json`, not an API key. In agents-cli terms this is a **native-login** harness: fork opencode **without** `--account`, and it uses that OAuth login.

## Findings

Practical gotchas worth knowing:

- **Model ids are provider-specific.** For OpenRouter, `anthropic/claude-3.5-haiku` does not exist (returns 404, model-not-found); use `anthropic/claude-haiku-4.5` or `anthropic/claude-3-haiku`. List valid slugs at `https://openrouter.ai/api/v1/models`.
- **codex refuses a non-git cwd.** Run codex-host harnesses from inside a git repository (or it errors "Not inside a trusted directory").
- **opencode picks a model from its own config**, so pin the model in `opencode.json` (`{"model": "openai/gpt-5.4-mini"}`) or pass `--model` when driving opencode directly.
- **`--auth` types:** `api-key` (most providers), `setup-token` (e.g. Anthropic `sk-ant-oat01-…`), `bearer-token` (e.g. Bedrock, proxies).

## Evidence

A real run through the full chain (host CLI launched by `agents`, credential injected, live model response):

```text
$ agents run or-claude "Reply with exactly the single word: PONG"
Resolved custom harness 'or-claude' -> claude
Running: claude --permission-mode plan --print -p Reply with exactly the single word: PONG
PONG

$ opencode run --model openai/gpt-5.4-mini "Reply with exactly the single word: PONG"
> gpt-5.4-mini
PONG
```

Both the API-key account flow and the subscription (OAuth) flow return live output, confirming the credential is resolved and injected end-to-end.
