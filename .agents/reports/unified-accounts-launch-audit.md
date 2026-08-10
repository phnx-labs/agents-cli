---
kind: report
title: Unified accounts launch audit
subtitle: Durable credentials attached to agent types, verified against the installed development CLI
status: verified-with-gaps
date: 2026-08-09
project: agents-cli
repository: phnx-labs/agents-cli
harness: codex
agent: root
host: yosemite-s1
session: 019fe983-21b5-7c33-aafc-8ed0cb556c0d
---

# Unified accounts launch audit

## Summary

The original account-label design was not launched. This implementation replaces it with durable credential accounts: a person creates a named API key, Anthropic setup token, or bearer token once, then attaches that stable account identity to native agents, custom harnesses, profiles, and routines.

> **Verdict:** The corrected account model works end-to-end for Anthropic setup tokens and for one OpenRouter API-key account reused by both Claude and OpenCode. Account rename and key rotation preserve the stable account ID. A missing device-local credential fails before an agent starts. Cursor API-key wiring is implemented but could not be live-tested because no Cursor API key was available on the three devices checked. Codex with an existing ChatGPT OAuth login rejected the third-party model; that path is not counted as verified.

## Findings

### Public interface

```sh
agents accounts
agents accounts add <name> --provider <provider> \
  --auth <api-key|setup-token|bearer-token> \
  [--from-secrets bundle:key]
agents accounts set-key <name> [--from-secrets bundle:key]
agents accounts inspect <name> [--json]
agents accounts rename <old> <new>
agents accounts remove <name>

agents run <agent> --account <name>
agents harness add <name> --host <agent> --model <model> --account <name>
```

There is no `accounts name ... --from claude@version` command. Native OAuth remains owned by each harness; `accounts` is for explicit long-lived credentials.

### What is stored

<svg viewBox="0 0 980 270" role="img" aria-label="Account metadata and device keychain flow" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="30" width="260" height="190" rx="18" fill="#111827" stroke="#a3e635" stroke-width="3"/>
  <text x="45" y="70" fill="#a3e635" font-size="22" font-family="monospace">accounts.yaml</text>
  <text x="45" y="110" fill="#f8fafc" font-size="18" font-family="sans-serif">stable UUID</text>
  <text x="45" y="140" fill="#f8fafc" font-size="18" font-family="sans-serif">name + provider</text>
  <text x="45" y="170" fill="#f8fafc" font-size="18" font-family="sans-serif">auth type + secret ref</text>
  <text x="45" y="200" fill="#94a3b8" font-size="16" font-family="sans-serif">never the credential bytes</text>
  <path d="M290 125 H430" stroke="#a3e635" stroke-width="4" marker-end="url(#arrow)"/>
  <rect x="440" y="30" width="220" height="190" rx="18" fill="#111827" stroke="#38bdf8" stroke-width="3"/>
  <text x="468" y="70" fill="#38bdf8" font-size="22" font-family="monospace">device store</text>
  <text x="468" y="118" fill="#f8fafc" font-size="18" font-family="sans-serif">encrypted credential</text>
  <text x="468" y="150" fill="#f8fafc" font-size="18" font-family="sans-serif">keyed by stable UUID</text>
  <text x="468" y="190" fill="#94a3b8" font-size="16" font-family="sans-serif">device-local by design</text>
  <path d="M670 125 H790" stroke="#38bdf8" stroke-width="4" marker-end="url(#arrow)"/>
  <rect x="800" y="30" width="160" height="190" rx="18" fill="#111827" stroke="#f8fafc" stroke-width="3"/>
  <text x="825" y="75" fill="#f8fafc" font-size="21" font-family="monospace">agent run</text>
  <text x="825" y="120" fill="#f8fafc" font-size="18" font-family="sans-serif">Claude</text>
  <text x="825" y="150" fill="#f8fafc" font-size="18" font-family="sans-serif">OpenCode</text>
  <text x="825" y="180" fill="#f8fafc" font-size="18" font-family="sans-serif">Cursor</text>
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a3e635"/></marker></defs>
</svg>

Profiles store the account's stable UUID, not its display name. Renaming an account therefore changes what users see without breaking attachments. `set-key` rotates credential bytes under the same identity.

## Evidence

![Rendered launch-audit overview](https://share.agents-cli.sh/muqsitnawaz/agents-cli-unified-accounts-report-e49710fa0e0a6fa8)

This screenshot was captured from the rendered report in headless Chrome on zion after the live CLI runs below completed.

### Installed CLI results

Installed artifact under test:

```text
/home/muqsit/.local/bin/agents
0.0.0-dev.a6ed79873-dirty
```

### One API-key account, two agent types

```text
$ agents run claude "Reply with exactly NATIVE_ACCOUNT_OK" \
    --account openrouter-primary --model qwen/qwen3-coder-next --mode plan
NATIVE_ACCOUNT_OK

$ agents run opencode@1.16.0 "Reply with exactly NATIVE_OPENCODE_ACCOUNT_OK" \
    --account openrouter-primary --model openrouter/qwen/qwen3-coder-next --mode plan
NATIVE_OPENCODE_ACCOUNT_OK
```

The account adapter supplied the host-specific key variable. For Claude it also supplied OpenRouter's Anthropic-compatible base URL; OpenCode selected the OpenRouter provider from the model identifier.

### Setup token

```text
$ agents run claude ... --account claude-automation
SETUP_TOKEN_OK
```

Anthropic setup tokens are validated for the `sk-ant-oat01-` shape and injected as `CLAUDE_CODE_OAUTH_TOKEN` only for Claude.

### Rename and rotation preserve identity

```text
$ agents accounts rename openrouter-primary openrouter-renamed
$ agents harness view account-proof-claude
Account:  openrouter-renamed
$ agents accounts rename openrouter-renamed openrouter-primary
stable_id=true

$ agents accounts set-key openrouter-primary --from-secrets openrouter.ai:OPENROUTER_API_KEY
ROTATION_STABLE_OK
```

### Missing credential fails before spawn

```text
$ agents run account-proof-claude "Reply with exactly SHOULD_NOT_START" --mode plan
Credential for account 'openrouter-primary' is missing on this device.
Add it with 'agents accounts set-key openrouter-primary'.
exit code: 1
```

### Verification matrix

| Path | Result | Evidence |
| --- | --- | --- |
| API key account creation/import | Pass | Safe metadata inspection reports `secretPresent: true`; raw key is absent from YAML |
| One account → Claude | Pass | `NATIVE_ACCOUNT_OK` |
| Same account → OpenCode | Pass | `NATIVE_OPENCODE_ACCOUNT_OK` |
| Anthropic setup token → Claude | Pass | `SETUP_TOKEN_OK` |
| Key rotation, stable identity | Pass | ID unchanged; post-rotation run returned `ROTATION_STABLE_OK` |
| Rename, stable harness attachment | Pass | Harness immediately displayed the new name; ID unchanged |
| Missing credential on another device/home | Pass | Exit 1 before spawn with exact `set-key` recovery command |
| Legacy version labels | Pass | Old v1 file is recoverably archived as `accounts.legacy-labels.yaml`; no false credential account is fabricated |
| Targeted tests | Pass | 73/73 account, command, harness, and runner tests; 54/54 wizard/harness tests |
| Cursor API key | Unverified | Adapter and CLI path implemented; no Cursor key existed locally, on zion, or on mac-mini during the audit |
| Codex + OpenRouter account while ChatGPT OAuth is active | Failed | Codex chose its ChatGPT auth and rejected the third-party model with HTTP 400; not counted as supported live proof |
| Independent staging-key chat | Failed | Key authenticated against OpenRouter's models API, but the Claude chat run hung; primary key was restored |

## Scope and migration

- Legacy `agents harness ... --auth-provider/--from-secrets` flags now fail with the concrete replacement: create an account, then pass `--account`.
- The interactive harness wizard selects an existing compatible account instead of copying credentials into a harness.
- Existing profile-owned credentials migrate on first resolution into a stable account, then the profile stores the account ID.
- `agents update --account` was removed because installation labels and credential accounts are different concepts.
- Local and routine launches resolve the credential before spawn. Remote/cloud/lease account forwarding is rejected because credentials are device-local; the destination must have the same account credential installed.

## Ship state

The implementation and this report are prepared on the `unified-accounts-durable` worktree for RUSH-2402. The evidence above is from the installed development build, not a released npm package. The `agents-cli` release train owns publishing after merge.
