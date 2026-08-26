---
kind: report
title: "agents-cli: accounts, providers & custom harnesses — verification + OpenRouter and ChatGPT-subscription flows"
surface: cli
---

## Summary

- **What this documents:** a hands-on verification of the agents-cli **accounts / provider / custom-harness** primitives on the *latest* code, run on **mac-mini**, plus a second flow that runs **opencode on the ChatGPT/Codex subscription with no API key**.
- **Audience:** maintainers of agents-cli (this is an internal verification + bug report, not end-user docs).
- **Result:** the API-key account flow works end-to-end for the **claude** and **codex** hosts; the **opencode** harness has a **model-pin bug**; opencode's own DB was **corrupt** (fixed); and the **ChatGPT-subscription (OAuth, no API key)** flow for opencode **works**.
- **Four concrete findings/bugs** are listed in §7 with `file:line` evidence.

## 1. Environment

| Item | Value |
| --- | --- |
| Test box | `mac-mini` (`/Users/user`) |
| Build under test | `agents-dev` = `0.0.0-dev.523eb8d52` (latest `origin/main` HEAD at test time) |
| How it was built | fast-forwarded the mac-mini checkout (was 412 commits behind), then `apps/cli/scripts/install.sh --skip-tests` |
| Production CLI | untouched — everything ran as `agents-dev`, never `agents` |

`agents-dev` is a side-by-side dev install; the shared daemon was left on production code.

## 2. The three primitives (how to actually use them)

There is **no** standalone `agents provider` command. "Provider" is a value in a fixed registry, selected with `--provider` on `accounts add`.

| Primitive | Command | What it is |
| --- | --- | --- |
| **account** | `agents accounts add <name> --provider <p> --auth api-key\|setup-token\|bearer-token` | A durable, device-local credential bundle (policy `never`, no Touch ID). |
| **provider** | the `--provider` value (`openrouter`, `anthropic`, `openai`, `xai`, `deepinfra`, `google`, `proxy`, `litellm`, `vllm`, `ollama`, …) | Registry entry that maps a credential onto each host's env vars. |
| **harness** | `agents harness fork <native> <name> --model <id> [--account <acct>]` | A named `(host CLI + model)` combo you run with `agents run <name>`. Omit `--account` to use the host's **native** login. |

**How `openrouter` maps onto hosts** (`src/lib/account-provider-registry.ts`):

| Host | Auth env | Base-URL env |
| --- | --- | --- |
| claude | `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_BASE_URL=https://openrouter.ai/api` |
| codex | `OPENAI_API_KEY` | `OPENAI_BASE_URL=https://openrouter.ai/api/v1` |
| opencode | `OPENROUTER_API_KEY` | — |

## 3. Flow diagram

<figure>
<svg viewBox="0 0 900 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="account to provider to harness to run flow">
  <defs><marker id="h" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#a3e635"/></marker></defs>
  <rect x="10" y="60" width="180" height="70" rx="8" fill="#0f1720" stroke="#a3e635" stroke-width="1.5"/>
  <text x="26" y="90" fill="#e5e7eb" font-family="ui-monospace,monospace" font-size="14">browser</text><text x="26" y="110" fill="#9ca3af" font-family="ui-monospace,monospace" font-size="11">provision OpenRouter key</text>
  <line x1="190" y1="95" x2="235" y2="95" stroke="#a3e635" stroke-width="1.5" marker-end="url(#h)"/>
  <rect x="240" y="60" width="180" height="70" rx="8" fill="#0f1720" stroke="#a3e635" stroke-width="1.5"/>
  <text x="256" y="90" fill="#e5e7eb" font-family="ui-monospace,monospace" font-size="14">accounts add</text><text x="256" y="110" fill="#9ca3af" font-family="ui-monospace,monospace" font-size="11">--provider openrouter</text>
  <line x1="420" y1="95" x2="465" y2="95" stroke="#a3e635" stroke-width="1.5" marker-end="url(#h)"/>
  <rect x="470" y="60" width="180" height="70" rx="8" fill="#0f1720" stroke="#a3e635" stroke-width="1.5"/>
  <text x="486" y="90" fill="#e5e7eb" font-family="ui-monospace,monospace" font-size="14">harness fork</text><text x="486" y="110" fill="#9ca3af" font-family="ui-monospace,monospace" font-size="11">--account + --model</text>
  <line x1="650" y1="95" x2="695" y2="95" stroke="#a3e635" stroke-width="1.5" marker-end="url(#h)"/>
  <rect x="700" y="60" width="190" height="70" rx="8" fill="#0f1720" stroke="#a3e635" stroke-width="1.5"/>
  <text x="716" y="90" fill="#e5e7eb" font-family="ui-monospace,monospace" font-size="14">agents run &lt;name&gt;</text><text x="716" y="110" fill="#9ca3af" font-family="ui-monospace,monospace" font-size="11">credential injected</text>
</svg>
<figcaption>Provisioned credential → durable account → custom harness → run. The credential is read headlessly and injected into the host CLI's env.</figcaption>
</figure>

## 4. Flow A — OpenRouter API key (the accounts feature)

1. Provisioned a **new** OpenRouter key (`agents-cli-test-2026-08-10`, $5 cap) via the Comet **Work** profile (already logged into OpenRouter). The key was captured straight to a file, never echoed to the transcript.
2. Loaded it into a file-backed bundle and created the account:

```bash
agents secrets create ork-file --backend file
cat key.txt | agents secrets add ork-file KEY --value-stdin --type api-key
agents accounts add openrouter-test --provider openrouter --auth api-key --from-secrets ork-file:KEY
# -> secretPresent: true, policy: never
```

3. Forked three harnesses onto that one account and ran each:

| Harness | Host · model | Result |
| --- | --- | --- |
| `or-claude` | claude · `anthropic/claude-haiku-4.5` | **PONG** — credential injected, real response |
| `or-codex` | codex · `openai/gpt-4o-mini` | **PONG** (needs a git-repo cwd; codex refuses a non-trusted dir) |
| `or-opencode` | opencode · `anthropic/claude-haiku-4.5` | failed — see §6 (DB) and §7 (model-pin) |

The credential is a **keychain, policy `never`** bundle and was read **headlessly over SSH** — the accounts feature's core promise holds.

## 5. Flow B — opencode on the ChatGPT/Codex subscription (no API key)

opencode's OpenAI provider offers three login methods: `ChatGPT Pro/Plus (browser)`, **`ChatGPT Pro/Plus (headless)`**, and `Manually enter API Key`. The headless method is a **device-code OAuth** against `https://auth.openai.com/codex/device` — the same endpoint Codex uses.

```bash
opencode auth login --provider openai --method "ChatGPT Pro/Plus (headless)"
#   Go to: https://auth.openai.com/codex/device
#   Enter code: XXXX-XXXXX      (authorize in a browser signed into the ChatGPT account)
```

Authorized the device code in the Work browser (already signed into the OpenAI account `user@example.com`, which holds the subscription). Result:

- `auth.json` gained an `openai` credential of **`type: oauth`** (access + refresh + accountId) — **not** an API key.
- `opencode auth list` → `OpenAI oauth`.
- Direct run on the subscription:

```bash
opencode run --model openai/gpt-5.4-mini "Reply with exactly: PONG"   # -> PONG
```

- Through an agents harness (`oc-sub`, forked from opencode, **no `--account`**), with the model set via a project `opencode.json` (to work around the bug in §7.2): `agents run oc-sub` → `gpt-5.4-mini` → **PONG**.

So: **yes**, opencode can run on the Codex/OpenAI subscription with no API key. In agents-cli terms this is a **native-login** harness (auth lives in opencode's `auth.json`), distinct from a `--provider`/`--account` credential bundle.

## 6. The opencode "no such column: name" error — root cause + fix

The `or-opencode` run failed with `Error: no such column: name`. This was **not** the accounts feature — **`opencode auth list` itself failed the same way**, so opencode's own state was broken.

**Root cause:** opencode's local DB (`~/.local/share/opencode/opencode.db`) had a schema **behind** the installed opencode `1.18.10` binary. The binary queries a `name` column on the OAuth-account table `control_account`, but the on-disk schema lacked it; the drizzle migration journal (`__drizzle_migrations`, 3 rows with empty hashes; opencode's own `migration` table empty) was drifted, so the adding-`name` migration never applied.

**Fix (reversible):** backed up and reset the DB so opencode recreated it at the current schema.

```bash
cd ~/.local/share/opencode
cp opencode.db opencode.db.broken-2026-08-10.bak
mv opencode.db opencode.db-shm opencode.db-wal /tmp/opencode-db-backup/
opencode auth list      # recreates the schema -> now succeeds; auth.json (Z.AI keys) preserved
```

This is an **opencode-internal migration bug**, unrelated to agents-cli. The reset loses opencode session history (backed up); `control_account`/`migration` were empty, so no OAuth accounts were lost.

## Findings

| # | Severity | Finding |
| --- | --- | --- |
| 7.1 | Low | `agents accounts add --from-secrets <bad-or-locked-bundle>` and `accounts inspect <missing>` **crash with an uncaught Node exception** (raw `throw`, `Node.js vXX` stack) instead of a clean CLI error. |
| 7.2 | Medium | **opencode custom-harness model pin is ignored.** Models are injected via a per-host env var in `MODEL_ENV_KEYS` (`src/lib/profiles.ts:235` — `ANTHROPIC_MODEL`/`OPENAI_MODEL`/`GEMINI_MODEL`/`GROK_MODEL`). There is **no opencode entry**, and `--model` is not emitted for a custom harness, so `agents run <opencode-harness>` runs `opencode run --agent plan …` with **no model** and opencode falls back to its default (`glm-4.7`). |
| 7.3 | Info | **Model-slug gotcha:** `anthropic/claude-3.5-haiku` is not a valid OpenRouter slug (404 = model-not-found, not 401). Current slugs: `anthropic/claude-haiku-4.5`, `anthropic/claude-3-haiku`. |
| 7.4 | External | opencode `1.18.10` ships a DB schema its migration runner didn't apply on an upgraded install → `no such column: name` breaks every opencode command (§6). opencode-side bug. |

## Evidence

```bash
# --- Flow A: OpenRouter API-key account ---
agents secrets create ork-file --backend file
cat key.txt | agents secrets add ork-file KEY --value-stdin --type api-key
agents accounts add openrouter-test --provider openrouter --auth api-key --from-secrets ork-file:KEY
agents harness fork claude or-claude --model anthropic/claude-haiku-4.5 --account openrouter-test
agents run or-claude "Reply with exactly: PONG"        # -> PONG

# --- Flow B: opencode on the ChatGPT subscription (no API key) ---
opencode auth login --provider openai --method "ChatGPT Pro/Plus (headless)"   # authorize device code in a browser
opencode run --model openai/gpt-5.4-mini "Reply with exactly: PONG"            # -> PONG
```

## 9. State left in place / cleanup

- **Removed:** raw key files in `/tmp` on all boxes; the temp `ork-file` import bundle.
- **Kept (working):** the `openrouter-test` account; harnesses `or-claude`, `or-codex`, `or-opencode`, `oc-sub`; opencode's `openai` OAuth (subscription) login; the OpenRouter key (`agents-cli-test-2026-08-10`, $5 cap); the opencode DB backup at `~/.local/share/opencode/opencode.db.broken-2026-08-10.bak`.
- All of the above can be torn down on request (`agents accounts remove`, `agents harness remove`, `opencode auth logout openai`, delete the OpenRouter key in the dashboard).
